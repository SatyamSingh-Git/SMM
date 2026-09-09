// Test-only stub for Meta's Graph endpoints.
//
// The publishers talk to Meta over `fetch` with form-encoded POST bodies and
// query-string GETs. This intercepts both, records every call in order, and
// serves canned responses — so a test can assert the exact request shape the
// publisher produces without any network.
//
// Fixture caveat: these response shapes are derived from what the publishers
// parse, not recorded from live traffic. They pin OUR request contract and
// OUR parsing; they cannot catch Meta changing its schema. That is what the
// weekly live shape smoke test (Phase 0.2) is for.

import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";

export type RecordedCall = {
  method: "GET" | "POST";
  /** Path after the API version prefix, e.g. "/17841/media_publish". */
  path: string;
  params: Record<string, string>;
};

// Returns a body to JSON-encode, an HttpResponse for full control, or
// undefined to fall through to the next responder.
export type Responder = (call: RecordedCall) => unknown;

const THREADS_BASE = "https://graph.threads.net/v1.0";
const IG_BASE = "https://graph.instagram.com/v22.0";

export class MetaStub {
  readonly calls: RecordedCall[] = [];
  private responders: Responder[] = [];
  private counter = 0;

  /** Calls that hit a create/publish/status endpoint, in order. */
  paths(): string[] {
    return this.calls.map((c) => `${c.method} ${c.path}`);
  }

  /** The params of the Nth recorded call. */
  params(i: number): Record<string, string> {
    const c = this.calls[i];
    if (!c) throw new Error(`no call at index ${i}; got ${this.calls.length}`);
    return c.params;
  }

  /** First call whose path ends with `suffix`. */
  find(suffix: string, method?: "GET" | "POST"): RecordedCall {
    const c = this.calls.find(
      (x) => x.path.endsWith(suffix) && (!method || x.method === method)
    );
    if (!c) throw new Error(`no call matching ${suffix}; saw ${this.paths().join(", ")}`);
    return c;
  }

  count(suffix: string): number {
    return this.calls.filter((c) => c.path.endsWith(suffix)).length;
  }

  /** Add a responder consulted before the defaults. Later ones win. */
  on(responder: Responder): void {
    this.responders.unshift(responder);
  }

  /** Fail the next request to `suffix` with a Meta-shaped error body. */
  failOn(suffix: string, status: number, error: unknown): void {
    let fired = false;
    this.on((call) => {
      if (fired || !call.path.endsWith(suffix)) return undefined;
      fired = true;
      return HttpResponse.json(error as Record<string, unknown>, { status });
    });
  }

  reset(): void {
    this.calls.length = 0;
    this.responders = [];
    this.counter = 0;
  }

  private defaultResponse(call: RecordedCall): unknown {
    const id = `id_${++this.counter}`;
    if (call.method === "POST") return { id };
    // Container status polls. Threads reads `status`, IG reads `status_code`.
    if (call.params.fields?.includes("status")) {
      return { status: "FINISHED", status_code: "FINISHED" };
    }
    return {};
  }

  handle(call: RecordedCall): Response {
    this.calls.push(call);
    for (const r of this.responders) {
      const out = r(call);
      if (out instanceof HttpResponse) return out;
      if (out !== undefined) return HttpResponse.json(out as Record<string, unknown>);
    }
    return HttpResponse.json(this.defaultResponse(call) as Record<string, unknown>);
  }
}

/** Build an MSW server bound to a fresh stub. Call in the test file's setup. */
export function metaServer(): { stub: MetaStub; server: ReturnType<typeof setupServer> } {
  const stub = new MetaStub();

  const toCall = async (
    base: string,
    request: Request
  ): Promise<RecordedCall> => {
    const url = new URL(request.url);
    const method = request.method as "GET" | "POST";
    const params: Record<string, string> = {};
    if (method === "GET") {
      url.searchParams.forEach((v, k) => (params[k] = v));
    } else {
      new URLSearchParams(await request.text()).forEach((v, k) => (params[k] = v));
    }
    return { method, path: url.pathname.slice(new URL(base).pathname.length), params };
  };

  const server = setupServer(
    http.all(`${THREADS_BASE}/*`, async ({ request }) =>
      stub.handle(await toCall(THREADS_BASE, request))
    ),
    http.all(`${IG_BASE}/*`, async ({ request }) =>
      stub.handle(await toCall(IG_BASE, request))
    )
  );

  return { stub, server };
}
