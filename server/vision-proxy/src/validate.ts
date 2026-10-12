/**
 * Request validation for the vision proxy. Pure functions so they are unit-testable
 * without the network or the SDK.
 */
export const MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** ~5 MB decoded; the app sends ≤ 1568 px JPEGs, typically 300–900 KB. */
export const MAX_IMAGE_BASE64_CHARS = 7_000_000;

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
  if (b.imageBase64.length > MAX_IMAGE_BASE64_CHARS) return { ok: false, status: 413, error: 'Image too large. Resize to 1568 px on the long edge.' };
  // Check a prefix and the tail; scanning megabytes with a regex is wasteful.
  if (!BASE64.test(b.imageBase64.slice(0, 4096)) || !BASE64.test(b.imageBase64.slice(-64))) return { ok: false, status: 400, error: 'imageBase64 is not valid base64 (no data: prefix).' };
  if (!MEDIA_TYPES.includes(b.mediaType as MediaType)) return { ok: false, status: 400, error: `mediaType must be one of ${MEDIA_TYPES.join(', ')}.` };
  const hint = typeof b.hint === 'string' ? b.hint.slice(0, 200).replace(/[\u0000-\u001f]/g, ' ') : undefined;
  return { ok: true, value: { imageBase64: b.imageBase64, mediaType: b.mediaType as MediaType, hint } };
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
