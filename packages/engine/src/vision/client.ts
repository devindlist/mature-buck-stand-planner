import { MOCK_VISION_RESULT } from './mock.ts';
import { parseVisionResult, type VisionResult } from './schema.ts';

/**
 * Vision analysis client. Two modes:
 *  - 'mock'  — no network; returns MOCK_VISION_RESULT after a short delay.
 *  - 'proxy' — POSTs the photo to the hunter's own vision proxy (server/vision-proxy),
 *              which holds the Claude API key. The key never ships in the app.
 */
export type VisionMode = 'mock' | 'proxy';

export interface VisionRequest {
  imageBase64: string;
  mediaType: 'image/jpeg' | 'image/png' | 'image/webp';
  /** Optional hint from the hunter ("onX screenshot", "topo"). */
  hint?: string;
}

export interface VisionResponse {
  result: VisionResult;
  issues: string[];
  mode: VisionMode;
  model?: string;
}

/**
 * How long the app waits for the proxy, upload and analysis included. The proxy cancels its
 * Claude call after its own deadline (server/vision-proxy VISION_TIMEOUT_MS, default 240 s,
 * never above 270 s), so this must stay comfortably above that: otherwise the app gives up
 * while the proxy keeps working, the hunter retries, and every attempt is billed and counted
 * against the hourly limit with no result reaching the phone.
 */
export const DEFAULT_VISION_TIMEOUT_MS = 300_000;

/**
 * Largest image Claude's high-resolution vision tier takes (Opus 4.7 and later, including the
 * proxy's default claude-opus-5-5): 2576 px on the long edge and about 3.75 MP in total, with
 * coordinates mapping 1:1 to pixels. Older models, or a VISION_MODEL override, downscale larger
 * images themselves (1568 px on Opus 4.6 and earlier), so sending this size is safe either way.
 */
export const MAX_VISION_EDGE_PX = 2576;
export const MAX_VISION_PIXELS = 3_750_000;

/**
 * Largest base64 payload the app should send: 5,000,000 characters. The API's per-image cap is
 * 5 MB, and whether it is counted on decoded bytes (about 6.67M base64 characters) or on the base64
 * text is not confirmed offline, so this is deliberately conservative: it keeps the payload under
 * 5 MB under either reading (5M characters decode to 3.75 MB). A JPEG of at most 3.75 MP at quality
 * 0.6-0.8 is normally well under it. The proxy (validate.ts MAX_IMAGE_BASE64_CHARS) uses the same
 * number and rejects anything larger; the app re-encodes once at lower quality above it.
 */
export const MAX_VISION_BASE64_CHARS = 5_000_000;

export interface FittedImage {
  width: number;
  height: number;
  /** True when width/height are smaller than the input and the photo needs resizing. */
  resized: boolean;
}

/**
 * Size to downscale a photo to before sending it: never upscales, keeps the aspect ratio, and
 * stays within both the long-edge and total-pixel limits of the vision tier.
 */
export function fitVisionImage(width: number, height: number): FittedImage {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return { width, height, resized: false };
  const scale = Math.min(1, MAX_VISION_EDGE_PX / Math.max(width, height), Math.sqrt(MAX_VISION_PIXELS / (width * height)));
  if (scale >= 1) return { width, height, resized: false };
  // The epsilon absorbs float error (2796 * (2576 / 2796) can land a hair under 2576).
  return { width: Math.max(1, Math.floor(width * scale + 1e-6)), height: Math.max(1, Math.floor(height * scale + 1e-6)), resized: true };
}

export interface VisionClientOptions {
  mode: VisionMode;
  proxyUrl?: string;
  /** Per-install token the proxy checks; not an Anthropic key. */
  appToken?: string;
  fetchFn?: typeof fetch;
  /** Total wait for the proxy. Default DEFAULT_VISION_TIMEOUT_MS; keep it above the proxy's own deadline. */
  timeoutMs?: number;
  mockDelayMs?: number;
}

export class VisionError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export async function analyzeMapPhoto(req: VisionRequest, opts: VisionClientOptions): Promise<VisionResponse> {
  if (opts.mode === 'mock') {
    await new Promise((r) => setTimeout(r, opts.mockDelayMs ?? 600));
    const { result, issues } = parseVisionResult(JSON.parse(JSON.stringify(MOCK_VISION_RESULT)));
    return { result, issues, mode: 'mock' };
  }
  if (!opts.proxyUrl) throw new VisionError('No vision proxy configured. Use mock mode or set a proxy URL in Settings.', false);
  const fetchFn = opts.fetchFn ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_VISION_TIMEOUT_MS);
  try {
    const res = await fetchFn(`${opts.proxyUrl.replace(/\/$/, '')}/v1/analyze-map`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.appToken ? { authorization: `Bearer ${opts.appToken}` } : {}) },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    const body = (await res.json().catch(() => null)) as { result?: unknown; error?: string; model?: string } | null;
    if (!res.ok) throw new VisionError(body?.error ?? `Vision proxy error ${res.status}`, res.status >= 500 || res.status === 429);
    const { result, issues } = parseVisionResult(body?.result);
    return { result, issues, mode: 'proxy', model: body?.model };
  } catch (e) {
    if (e instanceof VisionError) throw e;
    const aborted = (e as { name?: string }).name === 'AbortError';
    throw new VisionError(aborted ? 'Map analysis timed out. Try again with a stronger signal or a less cluttered screenshot, or mark features by hand.' : 'Could not reach the vision proxy. Check your connection.', true);
  } finally {
    clearTimeout(timer);
  }
}
