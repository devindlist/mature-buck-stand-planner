import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CancelledError, isCancelled, raceAbort } from './cancel.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('raceAbort passes the result through when the work finishes first', async () => {
  const c = new AbortController();
  assert.equal(await raceAbort(Promise.resolve(42), c.signal), 42);
});

test('raceAbort passes the work’s own failure through, and that is not a cancellation', async () => {
  const c = new AbortController();
  await assert.rejects(raceAbort(Promise.reject(new Error('boom')), c.signal), (e: Error) => e.message === 'boom' && !isCancelled(e));
});

test('abort while the work is pending rejects with CancelledError and ignores the late result', async () => {
  const c = new AbortController();
  const work = wait(30).then(() => 'late');
  const raced = raceAbort(work, c.signal);
  c.abort();
  await assert.rejects(raced, (e: unknown) => e instanceof CancelledError && isCancelled(e));
  assert.equal(await work, 'late', 'the underlying work still runs; only the wait is cancelled');
});

test('an already-aborted signal rejects at once, and the abandoned work cannot raise an unhandled rejection', async () => {
  const c = new AbortController();
  c.abort();
  const work = wait(10).then(() => {
    throw new Error('late failure nobody will read');
  });
  await assert.rejects(raceAbort(work, c.signal), (e: unknown) => isCancelled(e));
  await wait(40); // an unhandled rejection here would fail the whole test run
});

test('isCancelled recognizes the error by name too, and nothing else', () => {
  const named = new Error('x');
  named.name = 'CancelledError';
  assert.equal(isCancelled(named), true);
  assert.equal(isCancelled(new Error('x')), false);
  assert.equal(isCancelled('CancelledError'), false);
  assert.equal(isCancelled(null), false);
});
