/**
 * A tiny, dependency-free HTTP router so the whole gateway bundles into one file and the
 * routes can be unit-tested without opening sockets (`router.handle(request)`).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export interface BridgeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  params: Record<string, string>;
  /** Full URL as seen by the server (used for signature schemes that sign the URL). */
  url: string;
}

export interface StreamWriter {
  write(chunk: string): void;
  onClose(fn: () => void): void;
}

export interface BridgeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: string | object | null;
  /** Server-sent events / long-lived responses. */
  stream?: (writer: StreamWriter) => void;
}

export type Handler = (req: BridgeRequest) => Promise<BridgeResponse> | BridgeResponse;

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): BridgeResponse {
  return { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: JSON.stringify(body) };
}

export function html(body: string, status = 200, headers: Record<string, string> = {}): BridgeResponse {
  return { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers }, body };
}

export function parseJson<T = Record<string, unknown>>(req: BridgeRequest): T {
  if (!req.rawBody) return {} as T;
  try {
    return JSON.parse(req.rawBody) as T;
  } catch {
    throw new HttpError(400, 'request body must be valid JSON');
  }
}

export function header(req: BridgeRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

export function safeCompare(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export class Router {
  private routes: Route[] = [];
  private guards: Array<{ prefix: string; guard: (req: BridgeRequest) => BridgeResponse | null }> = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({ method: method.toUpperCase(), parts: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(pattern: string, handler: Handler) {
    return this.add('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler) {
    return this.add('POST', pattern, handler);
  }

  put(pattern: string, handler: Handler) {
    return this.add('PUT', pattern, handler);
  }

  delete(pattern: string, handler: Handler) {
    return this.add('DELETE', pattern, handler);
  }

  /** Runs before any route under `prefix`; return a response to short-circuit (e.g. 401). */
  guard(prefix: string, guard: (req: BridgeRequest) => BridgeResponse | null): this {
    this.guards.push({ prefix, guard });
    return this;
  }

  listRoutes(): string[] {
    return this.routes.map((r) => `${r.method} /${r.parts.join('/')}`);
  }

  async handle(input: Omit<BridgeRequest, 'params'>): Promise<BridgeResponse> {
    const segs = input.path.split('/').filter(Boolean).map(decodeURIComponent);
    let methodMismatch = false;
    for (const route of this.routes) {
      const params = match(route.parts, segs);
      if (!params) continue;
      if (route.method !== input.method && !(route.method === 'GET' && input.method === 'HEAD')) {
        methodMismatch = true;
        continue;
      }
      const req: BridgeRequest = { ...input, params };
      for (const { prefix, guard } of this.guards) {
        if (input.path === prefix || input.path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
          const denied = guard(req);
          if (denied) return denied;
        }
      }
      try {
        return await route.handler(req);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message, details: err.details });
        return json(500, { error: err instanceof Error ? err.message : 'internal error' });
      }
    }
    if (input.method === 'OPTIONS') return { status: 204, headers: corsHeaders() };
    return json(methodMismatch ? 405 : 404, { error: methodMismatch ? 'method not allowed' : 'not found', path: input.path });
  }
}

function match(pattern: string[], segs: string[]): Record<string, string> | null {
  if (pattern.length !== segs.length && !(pattern[pattern.length - 1] === '*' && segs.length >= pattern.length - 1)) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i]!;
    if (p === '*') {
      params['*'] = segs.slice(i).join('/');
      return params;
    }
    const s = segs[i];
    if (s === undefined) return null;
    if (p.startsWith(':')) params[p.slice(1)] = s;
    else if (p !== s) return null;
  }
  return params;
}

export function corsHeaders(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type,x-bridge-token',
  };
}

const MAX_BODY = 5 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Adapts a Router to `http.createServer`. */
export function toNodeHandler(router: Router, options: { publicUrl?: string } = {}) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    const host = req.headers.host ?? 'localhost';
    const url = new URL(req.url ?? '/', options.publicUrl ?? `http://${host}`);
    let rawBody = '';
    try {
      rawBody = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: (err as Error).message }));
      return;
    }
    const out = await router.handle({
      method: (req.method ?? 'GET').toUpperCase(),
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      rawBody,
      url: `${options.publicUrl ? options.publicUrl.replace(/\/$/, '') : `http://${host}`}${req.url ?? '/'}`,
    });
    if (out.stream) {
      res.writeHead(out.status, { 'cache-control': 'no-cache', connection: 'keep-alive', ...(out.headers ?? {}) });
      res.flushHeaders?.();
      const closers: Array<() => void> = [];
      req.on('close', () => closers.forEach((fn) => fn()));
      out.stream({ write: (chunk) => res.write(chunk), onClose: (fn) => closers.push(fn) });
      return;
    }
    const body = out.body === undefined || out.body === null ? '' : typeof out.body === 'string' ? out.body : JSON.stringify(out.body);
    res.writeHead(out.status, out.headers ?? {});
    res.end(req.method === 'HEAD' ? undefined : body);
  };
}
