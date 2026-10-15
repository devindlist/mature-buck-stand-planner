import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  bearerToken,
  DEFAULT_MODEL_TIMEOUT_MS,
  MAX_IMAGE_BASE64_CHARS,
  MAX_MODEL_TIMEOUT_MS,
  MIN_MODEL_TIMEOUT_MS,
  parseTimeoutMs,
  parseTokens,
  RateLimiter,
  resolveAuthPolicy,
  validateAnalyzeRequest,
  watchRequest,
  type ClosableResponse,
} from './validate.ts';
import { MAX_VISION_BASE64_CHARS } from '../../../packages/engine/src/vision/client.ts';

const img = 'A'.repeat(400);

test('accepts a well-formed request and trims the hint', () => {
  const v = validateAnalyzeRequest({ imageBase64: img, mediaType: 'image/jpeg', hint: 'onX screenshot\n'.repeat(30) });
  assert.ok(v.ok);
  if (v.ok) assert.ok((v.value.hint ?? '').length <= 200 && !v.value.hint?.includes('\n'));
});

test('rejects missing, oversized, non-base64 or wrong-type images', () => {
  assert.equal(validateAnalyzeRequest(null).ok, false);
  assert.equal(validateAnalyzeRequest({ mediaType: 'image/jpeg' }).ok, false);
  const big = validateAnalyzeRequest({ imageBase64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1), mediaType: 'image/jpeg' });
  assert.ok(!big.ok && big.status === 413);
  assert.equal(validateAnalyzeRequest({ imageBase64: `data:image/png;base64,${img}`, mediaType: 'image/png' }).ok, false);
  assert.equal(validateAnalyzeRequest({ imageBase64: img, mediaType: 'image/gif' }).ok, false);
});

test('bearer token parsing', () => {
  assert.equal(bearerToken('Bearer abc123'), 'abc123');
  assert.equal(bearerToken('bearer  xyz '), 'xyz');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
});

test('rate limiter: fixed window per key', () => {
  const rl = new RateLimiter(2, 1000);
  assert.ok(rl.allow('a', 0));
  assert.ok(rl.allow('a', 10));
  assert.ok(!rl.allow('a', 20));
  assert.ok(rl.allow('b', 20), 'separate keys');
  assert.ok(rl.allow('a', 1000), 'window resets');
});

test('oversize image error names the current 2576 px limit, and the cap stays under the API 5 MB per-image limit', () => {
  const big = validateAnalyzeRequest({ imageBase64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS + 1), mediaType: 'image/jpeg' });
  assert.ok(!big.ok && /2576/.test(big.error) && !/1568/.test(big.error));
  // Under 5 MB whichever way the API counts it: decoded bytes OR the base64 text itself.
  assert.ok((MAX_IMAGE_BASE64_CHARS * 3) / 4 < 5_000_000, 'decoded size must stay under 5 MB');
  assert.ok(MAX_IMAGE_BASE64_CHARS <= 5_000_000, 'base64 length must stay under 5,000,000 characters');
  // The app checks the same number before it sends, so it never uploads what the proxy would refuse.
  assert.equal(MAX_IMAGE_BASE64_CHARS, MAX_VISION_BASE64_CHARS, 'proxy and engine caps must match');
  assert.ok(validateAnalyzeRequest({ imageBase64: 'A'.repeat(MAX_IMAGE_BASE64_CHARS), mediaType: 'image/jpeg' }).ok, 'exactly at the cap is accepted');
  // 5.2M characters (decoded 3.9 MB, but over 5 MB read as base64 text) is refused here, not by the API.
  const over = validateAnalyzeRequest({ imageBase64: 'A'.repeat(5_200_000), mediaType: 'image/jpeg' });
  assert.ok(!over.ok && over.status === 413);
  // A 2576 px JPEG (a few MB at most) must still be accepted.
  assert.ok(validateAnalyzeRequest({ imageBase64: 'A'.repeat(4_000_000), mediaType: 'image/jpeg' }).ok);
});

test('APP_TOKENS parsing trims and drops empties', () => {
  assert.deepEqual(parseTokens(' a, b ,,c '), ['a', 'b', 'c']);
  assert.deepEqual(parseTokens(''), []);
  assert.deepEqual(parseTokens(undefined), []);
  assert.deepEqual(parseTokens(' , '), []);
});

test('auth fails closed: no APP_TOKENS means no start unless ALLOW_NO_AUTH=1, even when NODE_ENV is unset', () => {
  // The regression: Fly.io / Cloud Run / a VPS rarely set NODE_ENV, and the proxy used to run wide open.
  const unset = resolveAuthPolicy([], {});
  assert.ok(!unset.ok && /APP_TOKENS/.test(unset.error) && /ALLOW_NO_AUTH/.test(unset.error));
  assert.equal(resolveAuthPolicy([], { NODE_ENV: 'development' }).ok, false);
  assert.equal(resolveAuthPolicy([], { NODE_ENV: 'production' }).ok, false);
  assert.equal(resolveAuthPolicy([], { ALLOW_NO_AUTH: '' }).ok, false);
  assert.equal(resolveAuthPolicy([], { ALLOW_NO_AUTH: 'true' }).ok, false, 'only the exact value 1 opts in');
});

test('ALLOW_NO_AUTH=1 is an explicit dev opt-out, flagged open, and refused in production', () => {
  const dev = resolveAuthPolicy([], { ALLOW_NO_AUTH: '1' });
  assert.ok(dev.ok && dev.open, 'open means the caller must bind to loopback');
  const prod = resolveAuthPolicy([], { ALLOW_NO_AUTH: '1', NODE_ENV: 'production' });
  assert.ok(!prod.ok && /production/.test(prod.error));
});

test('with tokens the proxy starts authenticated whatever else is set', () => {
  for (const env of [{}, { NODE_ENV: 'production' }, { ALLOW_NO_AUTH: '1' }]) {
    const p = resolveAuthPolicy(['tok'], env);
    assert.ok(p.ok && !p.open);
  }
});

test('model timeout: default 240 s, clamped to [30 s, 270 s] so it stays under the app\'s 300 s wait', () => {
  assert.equal(DEFAULT_MODEL_TIMEOUT_MS, 240_000);
  assert.ok(MAX_MODEL_TIMEOUT_MS < 300_000, 'app waits 300 s; the proxy must always give up first');
  assert.equal(parseTimeoutMs(undefined), DEFAULT_MODEL_TIMEOUT_MS);
  assert.equal(parseTimeoutMs(''), DEFAULT_MODEL_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('abc'), DEFAULT_MODEL_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('120000'), 120_000);
  assert.equal(parseTimeoutMs('900000'), MAX_MODEL_TIMEOUT_MS);
  assert.equal(parseTimeoutMs('5'), MIN_MODEL_TIMEOUT_MS);
});

/** A stand-in for http.ServerResponse: emits 'close' like the real one when the connection ends. */
class FakeRes extends EventEmitter implements ClosableResponse {
  writableFinished = false;
  destroyed = false;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('watchRequest: client disconnect aborts the upstream call right away', () => {
  const res = new FakeRes();
  const w = watchRequest(res, 60_000);
  assert.equal(w.signal.aborted, false);
  assert.equal(w.reason(), null);
  res.destroyed = true;
  res.emit('close'); // connection dropped before the response was written
  assert.equal(w.signal.aborted, true);
  assert.equal(w.reason(), 'client');
  w.dispose();
});

test('watchRequest: a normal finish is not an abort', () => {
  const res = new FakeRes();
  const w = watchRequest(res, 60_000);
  res.writableFinished = true;
  res.emit('close'); // 'close' also fires after a completed response
  assert.equal(w.signal.aborted, false);
  assert.equal(w.reason(), null);
  w.dispose();
});

test('watchRequest: the deadline aborts a call that runs too long', async () => {
  const res = new FakeRes();
  const w = watchRequest(res, 20);
  await wait(60);
  assert.equal(w.signal.aborted, true);
  assert.equal(w.reason(), 'deadline');
  w.dispose();
});

test('watchRequest: dispose cancels the deadline and stops listening', async () => {
  const res = new FakeRes();
  const w = watchRequest(res, 20);
  w.dispose();
  await wait(60);
  assert.equal(w.signal.aborted, false);
  assert.equal(res.listenerCount('close'), 0);
  res.destroyed = true;
  res.emit('close');
  assert.equal(w.signal.aborted, false);
});

test('watchRequest: first cause wins, and a client that left during upload is caught at creation', async () => {
  const res = new FakeRes();
  const w = watchRequest(res, 20);
  res.destroyed = true;
  res.emit('close');
  await wait(60);
  assert.equal(w.reason(), 'client', 'a later deadline must not overwrite the reason');
  w.dispose();

  const gone = new FakeRes();
  gone.destroyed = true; // 'close' already fired before we started watching
  const w2 = watchRequest(gone, 60_000);
  assert.equal(w2.signal.aborted, true);
  assert.equal(w2.reason(), 'client');
  w2.dispose();
});
