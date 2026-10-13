import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeMapPhoto, DEFAULT_VISION_TIMEOUT_MS, fitVisionImage, MAX_VISION_EDGE_PX, MAX_VISION_PIXELS, VisionError } from './client.ts';
import { MOCK_VISION_RESULT } from './mock.ts';

const REQ = { imageBase64: 'x', mediaType: 'image/jpeg' } as const;

/** Runs `run` while recording the delay of every setTimeout it schedules. */
async function recordTimerDelays(run: () => Promise<unknown>): Promise<number[]> {
  const delays: number[] = [];
  const g = globalThis as { setTimeout: unknown };
  const real = globalThis.setTimeout;
  g.setTimeout = (fn: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return real(fn, ms);
  };
  try {
    await run();
  } finally {
    g.setTimeout = real;
  }
  return delays;
}

/** A proxy that never answers; it only ends when the client aborts. */
const hangingFetch = ((_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  })) as unknown as typeof fetch;

test('client: default wait outlasts the proxy deadline (240 s default, 270 s cap) so the app never abandons a live call', async () => {
  assert.ok(DEFAULT_VISION_TIMEOUT_MS >= 300_000, `default ${DEFAULT_VISION_TIMEOUT_MS} ms must exceed the proxy's 270 s ceiling with margin`);
  const okFetch = (async () => new Response(JSON.stringify({ result: MOCK_VISION_RESULT, model: 'm' }), { status: 200 })) as typeof fetch;
  const delays = await recordTimerDelays(() => analyzeMapPhoto(REQ, { mode: 'proxy', proxyUrl: 'https://p', fetchFn: okFetch }));
  assert.ok(delays.includes(DEFAULT_VISION_TIMEOUT_MS), `timer delays were ${JSON.stringify(delays)}`);
  assert.ok(!delays.some((d) => d === 120_000), 'the old 120 s cut-off must be gone');
});

test('client: an explicit timeoutMs still wins, aborts the request, and reports a retryable timeout', async () => {
  await assert.rejects(
    analyzeMapPhoto(REQ, { mode: 'proxy', proxyUrl: 'https://p', fetchFn: hangingFetch, timeoutMs: 20 }),
    (e: VisionError) => e instanceof VisionError && e.retryable && /timed out/.test(e.message),
  );
});

test('client: a proxy deadline (504) is surfaced with the proxy message and marked retryable', async () => {
  const f = (async () => new Response(JSON.stringify({ error: 'Map analysis took too long.' }), { status: 504 })) as typeof fetch;
  await assert.rejects(
    analyzeMapPhoto(REQ, { mode: 'proxy', proxyUrl: 'https://p', fetchFn: f }),
    (e: VisionError) => e.retryable && e.message === 'Map analysis took too long.',
  );
});

test('fitVisionImage: uses the 2576 px high-resolution limit instead of the old 1568 px', () => {
  // A 1290x2796 phone screenshot used to be cut to 723x1568.
  const phone = fitVisionImage(1290, 2796);
  assert.ok(phone.resized);
  assert.equal(phone.height, 2576);
  assert.ok(phone.width >= 1188 && phone.width <= 1189, `width ${phone.width}`);
  assert.ok(phone.width * phone.height <= MAX_VISION_PIXELS);
  // Anything at or under the limit is left alone (no upscaling, no needless re-encode).
  assert.equal(fitVisionImage(1568, 1000).resized, false);
  assert.equal(fitVisionImage(2576, 1400).resized, false);
  assert.equal(fitVisionImage(800, 600).resized, false);
});

test('fitVisionImage: also respects the total-pixel budget and keeps the aspect ratio', () => {
  const square = fitVisionImage(4000, 4000);
  assert.ok(square.resized);
  assert.ok(square.width * square.height <= MAX_VISION_PIXELS);
  assert.ok(square.width <= MAX_VISION_EDGE_PX && square.height <= MAX_VISION_EDGE_PX);
  assert.equal(square.width, square.height);

  const wide = fitVisionImage(8000, 3000);
  assert.ok(wide.resized);
  assert.equal(wide.width, MAX_VISION_EDGE_PX);
  assert.ok(Math.abs(wide.width / wide.height - 8000 / 3000) < 0.01);
});

test('fitVisionImage: bad dimensions never produce NaN sizes', () => {
  for (const [w, h] of [[0, 0], [-5, 100], [Number.NaN, 100], [100, Number.POSITIVE_INFINITY]] as const) {
    assert.equal(fitVisionImage(w, h).resized, false);
  }
});
