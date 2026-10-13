/**
 * Request validation for the vision proxy. Pure functions so they are unit-testable
 * without the network or the SDK.
 */
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/**
 * About 4.95 MB decoded, under the API's 5 MB per-image cap. The app sends JPEGs of at most 2576 px on
 * the long edge (Claude's high-resolution tier), typically 0.5–2 MB. Keep this equal to the engine's
 * MAX_VISION_BASE64_CHARS (packages/engine/src/vision/client.ts), which the app checks before sending.
 */
export const MAX_IMAGE_BASE64_CHARS = 6_600_000;

export interface AnalyzeRequest {
  imageBase64: string;
  mediaType: MediaType;
  hint?: string;
}

export type Validation = { ok: true; value: AnalyzeRequest } | { ok: false; status: number; error: string };

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export function validateAnalyzeRequest(body: unknown): Validation {
  if (typeof body !== 'object' || body === null) return { ok: false, status: 400, error: 'Body must be a JSON object.' };
  const b = body as Record<string, unknown>;
  if (typeof b.imageBase64 !== 'string' || b.imageBase64.length < 100) return { ok: false, status: 400, error: 'imageBase64 is required.' };
  if (b.imageBase64.length > MAX_IMAGE_BASE64_CHARS) return { ok: false, status: 413, error: 'Image too large (over about 5 MB). Resize to 2576 px or less on the long edge.' };
  // Check a prefix and the tail; scanning megabytes with a regex is wasteful.
  if (!BASE64.test(b.imageBase64.slice(0, 4096)) || !BASE64.test(b.imageBase64.slice(-64))) return { ok: false, status: 400, error: 'imageBase64 is not valid base64 (no data: prefix).' };
  if (!MEDIA_TYPES.includes(b.mediaType as MediaType)) return { ok: false, status: 400, error: `mediaType must be one of ${MEDIA_TYPES.join(', ')}.` };
  const hint = typeof b.hint === 'string' ? b.hint.slice(0, 200).replace(/[\u0000-\u001f]/g, ' ') : undefined;
  return { ok: true, value: { imageBase64: b.imageBase64, mediaType: b.mediaType as MediaType, hint } };
}

/** Splits a comma-separated APP_TOKENS value into trimmed, non-empty tokens. */
export function parseTokens(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
}

export type AuthPolicy = { ok: true; open: boolean } | { ok: false; error: string };

/**
 * Startup auth policy. Fails closed: with no APP_TOKENS the proxy only runs when ALLOW_NO_AUTH=1 is set
 * explicitly (local development), never together with NODE_ENV=production. `open: true` means requests
 * are not authenticated, so the caller must bind to loopback only. Many hosts (Fly.io, Cloud Run, a bare
 * VPS) do not set NODE_ENV, so that variable alone is not a safe signal.
 */
export function resolveAuthPolicy(tokens: readonly string[], env: { ALLOW_NO_AUTH?: string; NODE_ENV?: string }): AuthPolicy {
  if (tokens.length) return { ok: true, open: false };
  if (env.ALLOW_NO_AUTH !== '1') {
    return { ok: false, error: 'Refusing to start: set APP_TOKENS (comma-separated per-install tokens). For local development only, ALLOW_NO_AUTH=1 runs without auth on 127.0.0.1.' };
  }
  if (env.NODE_ENV === 'production') {
    return { ok: false, error: 'Refusing to start: ALLOW_NO_AUTH=1 is not allowed with NODE_ENV=production. Set APP_TOKENS.' };
  }
  return { ok: true, open: true };
}

/**
 * Ceiling for one Claude call, measured from when analysis starts (after the upload is read).
 * The app waits DEFAULT_VISION_TIMEOUT_MS (300 s, packages/engine/src/vision/client.ts) from the moment it
 * sends, so this stays at or under 270 s: the proxy must always give up first.
 */
export const DEFAULT_MODEL_TIMEOUT_MS = 240_000;
export const MIN_MODEL_TIMEOUT_MS = 30_000;
export const MAX_MODEL_TIMEOUT_MS = 270_000;

/** Parses VISION_TIMEOUT_MS; falls back when unset or not a number, and clamps into [min, max]. */
export function parseTimeoutMs(raw: string | undefined, fallback = DEFAULT_MODEL_TIMEOUT_MS, min = MIN_MODEL_TIMEOUT_MS, max = MAX_MODEL_TIMEOUT_MS): number {
  const n = raw === undefined || raw.trim() === '' ? Number.NaN : Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** The slice of http.ServerResponse that watchRequest needs (kept narrow so tests can fake it). */
export interface ClosableResponse {
  readonly writableFinished: boolean;
  readonly destroyed?: boolean;
  once(event: 'close', listener: () => void): unknown;
  removeListener(event: 'close', listener: () => void): unknown;
}

export type AbortReason = 'client' | 'deadline';

export interface RequestWatch {
  /** Aborts when the client disconnects before the response is sent, or when the deadline passes. */
  readonly signal: AbortSignal;
  /** Which of the two fired first, or null while neither has. */
  reason(): AbortReason | null;
  /** Clears the deadline timer and the close listener. Call it in a finally block. */
  dispose(): void;
}

/**
 * Ties an upstream call to the life of the HTTP request: the returned signal aborts when the client goes
 * away (so an abandoned request stops costing money) or when `deadlineMs` passes (so a slow call can never
 * outlive the app's own timeout). Listens on the response, not the request: in Node 16+ the request's
 * 'close' fires once the body is read, while the response's 'close' fires when the connection drops.
 */
export function watchRequest(res: ClosableResponse, deadlineMs: number): RequestWatch {
  const controller = new AbortController();
  let why: AbortReason | null = null;
  const abort = (reason: AbortReason): void => {
    if (why) return;
    why = reason;
    controller.abort();
  };
  const onClose = (): void => {
    if (!res.writableFinished) abort('client');
  };
  const timer = setTimeout(() => abort('deadline'), deadlineMs);
  res.once('close', onClose);
  // The client may have gone while the body was still being read; 'close' has already fired by then.
  if (res.destroyed && !res.writableFinished) abort('client');
  return {
    signal: controller.signal,
    reason: () => why,
    dispose: () => {
      clearTimeout(timer);
      res.removeListener('close', onClose);
    },
  };
}

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '');
  return m ? m[1].trim() : null;
}

/** Fixed-window per-token limiter. In-memory: fine for a single small instance. */
export class RateLimiter {
  private readonly limit: number;
  private readonly windowMs: number;
  private hits = new Map<string, { start: number; n: number }>();

  constructor(limit: number, windowMs = 3_600_000) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    const cur = this.hits.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      this.hits.set(key, { start: now, n: 1 });
      return true;
    }
    if (cur.n >= this.limit) return false;
    cur.n++;
    return true;
  }
}
