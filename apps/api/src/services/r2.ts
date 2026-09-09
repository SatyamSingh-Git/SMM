// Minimal S3-compatible client for Cloudflare R2 — just the four calls the
// backup job needs (put, list, get, delete), signed with SigV4.
//
// Deliberately not @aws-sdk/client-s3: that pulls a large dependency tree onto
// a 1 GB box to make four requests. SigV4 for path-style S3 is ~60 lines of
// node:crypto, and keeping it here means the backup path has no third-party
// code in it at all.
//
// Requests use `x-amz-content-sha256: UNSIGNED-PAYLOAD`, which S3 and R2 both
// accept over HTTPS. That is what lets a large dump stream out of a file
// handle without being hashed into memory first.

import { createHash, createHmac } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

export type R2Config = {
  endpoint: string; // https://<account>.r2.cloudflarestorage.com
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string; // R2 ignores this but SigV4 requires a value
};

const UNSIGNED = "UNSIGNED-PAYLOAD";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Percent-encode per RFC 3986, which is stricter than encodeURIComponent. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Encode an object key, keeping "/" as a path separator. */
function encodeKey(key: string): string {
  return key.split("/").map(uriEncode).join("/");
}

export type SignedRequest = { url: string; headers: Record<string, string> };

/**
 * Build the URL + signed headers for one request. Exported so the signing can
 * be tested directly against a known clock rather than only through the wire.
 */
export function signRequest(
  cfg: R2Config,
  opts: {
    method: "GET" | "PUT" | "DELETE";
    key?: string;
    query?: Record<string, string>;
    now?: Date;
    extraHeaders?: Record<string, string>;
  }
): SignedRequest {
  const region = cfg.region ?? "auto";
  const now = opts.now ?? new Date();
  const amzDate = now.toISOString().replace(/[-:]|\.\d{3}/g, ""); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const host = new URL(cfg.endpoint).host;

  const canonicalUri = opts.key
    ? `/${uriEncode(cfg.bucket)}/${encodeKey(opts.key)}`
    : `/${uriEncode(cfg.bucket)}`;

  const canonicalQuery = Object.entries(opts.query ?? {})
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");

  const headers: Record<string, string> = {
    host,
    "x-amz-content-sha256": UNSIGNED,
    "x-amz-date": amzDate,
    ...opts.extraHeaders,
  };

  // Signed headers must be lowercase, sorted, and trimmed.
  const sortedKeys = Object.keys(headers)
    .map((k) => k.toLowerCase())
    .sort();
  const canonicalHeaders =
    sortedKeys
      .map((k) => `${k}:${String(headers[k] ?? headers[k.toLowerCase()]).trim()}`)
      .join("\n") + "\n";
  const signedHeaders = sortedKeys.join(";");

  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    UNSIGNED,
  ].join("\n");

  const scope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, dateStamp), region), "s3"),
    "aws4_request"
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${cfg.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const qs = canonicalQuery ? `?${canonicalQuery}` : "";
  return { url: `${cfg.endpoint.replace(/\/$/, "")}${canonicalUri}${qs}`, headers };
}

export class R2Error extends Error {
  constructor(public status: number, public body: string, message: string) {
    super(message);
    this.name = "R2Error";
  }
}

async function send(
  signed: SignedRequest,
  method: string,
  body?: unknown
): Promise<Response> {
  // Built untyped: the API package compiles without the DOM lib, so BodyInit
  // and the `duplex` option (required by Node's fetch for a streamed request
  // body) are not in scope.
  const init: Record<string, unknown> = { method, headers: signed.headers };
  if (body !== undefined) {
    init.body = body;
    init.duplex = "half";
  }
  const res = await fetch(signed.url, init as RequestInit);
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new R2Error(res.status, text, `R2 ${method} failed: ${res.status} ${text}`);
  }
  return res;
}

/** Upload a local file, streamed — never read whole into memory. */
export async function putFile(
  cfg: R2Config,
  key: string,
  filePath: string,
  contentType = "application/octet-stream"
): Promise<{ size: number }> {
  const { size } = await stat(filePath);
  const signed = signRequest(cfg, {
    method: "PUT",
    key,
    extraHeaders: { "content-type": contentType },
  });
  // Content-Length is set but not signed — S3 does not require it in the
  // canonical headers, and signing it would break streamed bodies.
  signed.headers["content-length"] = String(size);
  await send(signed, "PUT", Readable.toWeb(createReadStream(filePath)));
  return { size };
}

export type R2Object = { key: string; size: number; lastModified: Date };

/** List objects under a prefix. Follows continuation tokens. */
export async function listObjects(
  cfg: R2Config,
  prefix: string
): Promise<R2Object[]> {
  const out: R2Object[] = [];
  let token: string | undefined;
  do {
    const query: Record<string, string> = { "list-type": "2", prefix };
    if (token) query["continuation-token"] = token;
    const res = await send(signRequest(cfg, { method: "GET", query }), "GET");
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const chunk = m[1] ?? "";
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1];
      const size = /<Size>(\d+)<\/Size>/.exec(chunk)?.[1];
      const modified = /<LastModified>([\s\S]*?)<\/LastModified>/.exec(chunk)?.[1];
      if (!key) continue;
      out.push({
        key,
        size: Number(size ?? 0),
        lastModified: new Date(modified ?? 0),
      });
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/
      .exec(xml)?.[1];
  } while (token);
  return out;
}

export async function deleteObject(cfg: R2Config, key: string): Promise<void> {
  await send(signRequest(cfg, { method: "DELETE", key }), "DELETE");
}

/** Fetch an object as a web stream, for the restore drill. */
export async function getObjectStream(
  cfg: R2Config,
  key: string
): Promise<ReadableStream<Uint8Array>> {
  const res = await send(signRequest(cfg, { method: "GET", key }), "GET");
  if (!res.body) throw new R2Error(500, "", "R2 GET returned no body");
  return res.body;
}
