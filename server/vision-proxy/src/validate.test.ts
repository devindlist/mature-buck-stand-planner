import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, RateLimiter, validateAnalyzeRequest, MAX_IMAGE_BASE64_CHARS } from './validate.ts';

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
