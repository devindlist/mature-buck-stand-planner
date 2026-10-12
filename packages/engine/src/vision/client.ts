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

export interface VisionClientOptions {
  mode: VisionMode;
  proxyUrl?: string;
  /** Per-install token the proxy checks; not an Anthropic key. */
  appToken?: string;
  fetchFn?: typeof fetch;
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
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
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
    throw new VisionError(aborted ? 'Map analysis timed out. Try again with signal, or use mock mode.' : 'Could not reach the vision proxy. Check your connection.', true);
  } finally {
    clearTimeout(timer);
  }
}
