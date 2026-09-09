import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  R2Error,
  deleteObject,
  listObjects,
  putFile,
  signRequest,
  type R2Config,
} from "./r2.js";

const cfg: R2Config = {
  endpoint: "https://acct123.r2.cloudflarestorage.com",
  bucket: "smm-backups",
  accessKeyId: "AKIAEXAMPLE",
  secretAccessKey: "secret-example",
};
const CLOCK = new Date("2026-09-09T12:00:00.000Z");

describe("signRequest", () => {
  it("builds a path-style URL with the bucket first", () => {
    const { url } = signRequest(cfg, { method: "PUT", key: "smm/db/a.gpg", now: CLOCK });
    expect(url).toBe(
      "https://acct123.r2.cloudflarestorage.com/smm-backups/smm/db/a.gpg"
    );
  });

  it("keeps slashes in the key but escapes other characters", () => {
    const { url } = signRequest(cfg, { method: "GET", key: "a b/c+d.gpg", now: CLOCK });
    expect(url).toContain("/smm-backups/a%20b/c%2Bd.gpg");
  });

  it("sends UNSIGNED-PAYLOAD so a large body never has to be hashed in memory", () => {
    const { headers } = signRequest(cfg, { method: "PUT", key: "k", now: CLOCK });
    expect(headers["x-amz-content-sha256"]).toBe("UNSIGNED-PAYLOAD");
  });

  it("formats x-amz-date as the compact ISO form SigV4 requires", () => {
    const { headers } = signRequest(cfg, { method: "GET", key: "k", now: CLOCK });
    expect(headers["x-amz-date"]).toBe("20260909T120000Z");
  });

  it("scopes the credential to date/region/s3/aws4_request", () => {
    const { headers } = signRequest(cfg, { method: "GET", key: "k", now: CLOCK });
    expect(headers.authorization).toContain(
      "Credential=AKIAEXAMPLE/20260909/auto/s3/aws4_request"
    );
    expect(headers.authorization).toContain(
      "SignedHeaders=host;x-amz-content-sha256;x-amz-date"
    );
  });

  it("sorts query parameters canonically", () => {
    const { url } = signRequest(cfg, {
      method: "GET",
      query: { prefix: "smm/db/", "list-type": "2" },
      now: CLOCK,
    });
    // "list-type" sorts before "prefix".
    expect(url).toContain("?list-type=2&prefix=smm%2Fdb%2F");
  });

  const sig = (r: { headers: Record<string, string> }) =>
    /Signature=([0-9a-f]+)/.exec(r.headers.authorization!)![1];

  it("is deterministic for the same inputs and clock", () => {
    const a = signRequest(cfg, { method: "PUT", key: "k", now: CLOCK });
    const b = signRequest(cfg, { method: "PUT", key: "k", now: CLOCK });
    expect(sig(a)).toBe(sig(b));
  });

  // Each of these participates in the canonical request; if any stopped
  // contributing, requests would still be signed but wrongly, and R2 would
  // reject them at runtime rather than here.
  it.each([
    ["method", { method: "GET" as const, key: "k" }],
    ["key", { method: "PUT" as const, key: "other" }],
    ["query", { method: "PUT" as const, key: "k", query: { "list-type": "2" } }],
  ])("changes the signature when the %s changes", (_label, override) => {
    const baseline = sig(signRequest(cfg, { method: "PUT", key: "k", now: CLOCK }));
    expect(sig(signRequest(cfg, { ...override, now: CLOCK }))).not.toBe(baseline);
  });

  it("changes the signature when the clock moves to another day", () => {
    const baseline = sig(signRequest(cfg, { method: "PUT", key: "k", now: CLOCK }));
    const nextDay = new Date("2026-09-10T12:00:00.000Z");
    expect(sig(signRequest(cfg, { method: "PUT", key: "k", now: nextDay }))).not.toBe(
      baseline
    );
  });

  it("changes the signature when the secret changes", () => {
    const baseline = sig(signRequest(cfg, { method: "PUT", key: "k", now: CLOCK }));
    const other = { ...cfg, secretAccessKey: "different" };
    expect(sig(signRequest(other, { method: "PUT", key: "k", now: CLOCK }))).not.toBe(
      baseline
    );
  });
});

// ---------- wire behaviour ----------

const recorded: Array<{ method: string; url: string; auth: string | null }> = [];
let respond: (req: Request) => Response = () => new HttpResponse(null, { status: 200 });

const server = setupServer(
  http.all("https://acct123.r2.cloudflarestorage.com/*", ({ request }) => {
    recorded.push({
      method: request.method,
      url: request.url,
      auth: request.headers.get("authorization"),
    });
    return respond(request);
  })
);

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => {
  recorded.length = 0;
  respond = () => new HttpResponse(null, { status: 200 });
  server.resetHandlers();
});
afterAll(() => server.close());

function listXml(keys: Array<[string, string]>, next?: string): string {
  return `<?xml version="1.0"?><ListBucketResult>${keys
    .map(
      ([k, d]) =>
        `<Contents><Key>${k}</Key><Size>2048</Size><LastModified>${d}</LastModified></Contents>`
    )
    .join("")}${
    next ? `<NextContinuationToken>${next}</NextContinuationToken>` : ""
  }</ListBucketResult>`;
}

describe("putFile", () => {
  it("streams the file and sets an explicit Content-Length", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "r2-test-"));
    const file = path.join(dir, "dump.gz.gpg");
    const body = Buffer.alloc(5000, 3);
    await writeFile(file, body);

    let seenLength: string | null = null;
    let seenBody: ArrayBuffer | null = null;
    respond = () => new HttpResponse(null, { status: 200 });
    server.use(
      http.put("https://acct123.r2.cloudflarestorage.com/*", async ({ request }) => {
        seenLength = request.headers.get("content-length");
        seenBody = await request.arrayBuffer();
        return new HttpResponse(null, { status: 200 });
      })
    );

    const out = await putFile(cfg, "smm/db/dump.gz.gpg", file);
    expect(out.size).toBe(5000);
    expect(seenLength).toBe("5000");
    expect(seenBody!.byteLength).toBe(5000);
  });

  it("raises R2Error with the response body on failure", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "r2-test-"));
    const file = path.join(dir, "x");
    await writeFile(file, "hi");
    respond = () =>
      HttpResponse.xml("<Error><Code>AccessDenied</Code></Error>", { status: 403 });

    const err = await putFile(cfg, "k", file).catch((e) => e);
    expect(err).toBeInstanceOf(R2Error);
    expect(err.status).toBe(403);
    expect(err.body).toContain("AccessDenied");
  });
});

describe("listObjects", () => {
  it("parses keys, sizes and timestamps", async () => {
    respond = () =>
      HttpResponse.xml(
        listXml([
          ["smm/db/a.gpg", "2026-09-09T02:00:00.000Z"],
          ["smm/db/b.gpg", "2026-09-08T02:00:00.000Z"],
        ])
      );
    const objects = await listObjects(cfg, "smm/db/");
    expect(objects.map((o) => o.key)).toEqual(["smm/db/a.gpg", "smm/db/b.gpg"]);
    expect(objects[0]!.size).toBe(2048);
    expect(objects[0]!.lastModified.toISOString()).toBe("2026-09-09T02:00:00.000Z");
  });

  it("follows continuation tokens until the listing is complete", async () => {
    let page = 0;
    respond = () => {
      page++;
      return HttpResponse.xml(
        page === 1
          ? listXml([["a", "2026-09-09T02:00:00.000Z"]], "TOKEN1")
          : listXml([["b", "2026-09-08T02:00:00.000Z"]])
      );
    };
    const objects = await listObjects(cfg, "smm/db/");
    expect(objects.map((o) => o.key)).toEqual(["a", "b"]);
    expect(recorded[1]!.url).toContain("continuation-token=TOKEN1");
  });

  it("returns an empty list for an empty bucket", async () => {
    respond = () => HttpResponse.xml("<ListBucketResult></ListBucketResult>");
    expect(await listObjects(cfg, "smm/db/")).toEqual([]);
  });
});

describe("deleteObject", () => {
  it("issues a signed DELETE for the key", async () => {
    await deleteObject(cfg, "smm/db/old.gpg");
    expect(recorded[0]!.method).toBe("DELETE");
    expect(recorded[0]!.url).toContain("/smm-backups/smm/db/old.gpg");
    expect(recorded[0]!.auth).toContain("AWS4-HMAC-SHA256");
  });
});
