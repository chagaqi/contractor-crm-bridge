import {
  BridgeEngine,
  FSM_SOURCES,
  RecordingCrmAdapter,
  Router,
  type EngineOptions,
  type FsmConnection,
  type FsmSource,
  type BridgeRequest,
} from '../src/index.js';

export const SECRET = 'test-webhook-secret';

export function connections(secret = SECRET): Partial<Record<FsmSource, FsmConnection>> {
  return Object.fromEntries(FSM_SOURCES.map((s) => [s, { source: s, webhookSecret: secret }]));
}

export function makeEngine(opts: EngineOptions = {}) {
  const recorder = new RecordingCrmAdapter();
  const engine = new BridgeEngine({
    connections: connections(),
    adapters: [recorder],
    retry: { attempts: 2, baseDelayMs: 0 },
    ...opts,
  });
  return { engine, recorder };
}

export interface MockCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
  rawBody: string;
}

export type MockRoute = {
  method?: string;
  match: string | RegExp;
  status?: number;
  reply?: unknown | ((call: MockCall) => unknown);
};

/** A `fetch` stand-in that records every call and answers from the first matching route (default 200 {}). */
export function mockFetch(routes: MockRoute[] = []) {
  const calls: MockCall[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers as Record<string, string>) ?? {})) headers[k.toLowerCase()] = v;
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    let body: unknown = rawBody;
    try {
      body = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }
    const call: MockCall = { method, url, path: new URL(url).pathname, headers, body, rawBody };
    calls.push(call);
    const route = routes.find((r) => (!r.method || r.method === method) && (typeof r.match === 'string' ? url.includes(r.match) : r.match.test(url)));
    const status = route?.status ?? 200;
    const reply = typeof route?.reply === 'function' ? (route.reply as (c: MockCall) => unknown)(call) : (route?.reply ?? {});
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

export function request(router: Router, method: string, path: string, opts: { body?: unknown; headers?: Record<string, string>; raw?: string } = {}) {
  const url = new URL(path, 'http://localhost');
  const rawBody = opts.raw ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
  const req: Omit<BridgeRequest, 'params'> = {
    method,
    path: url.pathname,
    query: url.searchParams,
    headers: Object.fromEntries(Object.entries(opts.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
    rawBody,
    url: url.toString(),
  };
  return router.handle(req).then((res) => ({
    ...res,
    json: (() => {
      try {
        return JSON.parse(String(res.body ?? 'null'));
      } catch {
        return null;
      }
    })() as any,
  }));
}
