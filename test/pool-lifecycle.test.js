const test = require('node:test');
const assert = require('node:assert/strict');
const { getEventListeners } = require('node:events');
const { setImmediate: tick } = require('node:timers/promises');
const { loadTs } = require('./helpers/load-ts.cjs');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('pool deadline releases waiters and closes a late factory result', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const old = deferred();
  let factorySignal;
  const closed = [];
  const pool = new ConnectionPool({
    create: (_key, signal) => { factorySignal = signal; return old.promise; },
    close: (value) => { closed.push(value); },
    options: { maxConnections: 2, idleTtlMs: 1000, connectTimeoutMs: 20 },
  });
  await assert.rejects(pool.get('a'), { name: 'TimeoutError' });
  assert.equal(factorySignal.aborted, true);
  assert.equal(pool.size(), 0);
  old.resolve('late');
  await tick();
  assert.deepEqual(closed, ['late']);
  assert.equal(pool.size(), 0);
  await pool.closeAll();
});

test('closeAll does not wait for an uncooperative factory and rejects its waiters', { timeout: 1000 }, async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const pool = new ConnectionPool({
    create: () => new Promise(() => {}),
    close: () => {},
    options: { maxConnections: 2, idleTtlMs: 1000 },
  });
  const waiting = assert.rejects(pool.get('a'), { name: 'AbortError' });
  await tick();
  await pool.closeAll();
  await waiting;
  await assert.rejects(pool.get('a'), /closed/);
});

test('dropAll allows a new attempt while old completion cannot overwrite or remove it', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const old = deferred();
  const replacement = deferred();
  const closed = [];
  let creates = 0;
  const pool = new ConnectionPool({
    create: () => (++creates === 1 ? old.promise : replacement.promise),
    close: (value) => { closed.push(value); },
    options: { maxConnections: 2, idleTtlMs: 1000 },
  });
  const oldWaiter = assert.rejects(pool.get('a'), { name: 'AbortError' });
  await tick();
  await pool.dropAll();
  const newWaiter = pool.get('a');
  await oldWaiter;
  old.resolve('old');
  await tick();
  const sharedWaiter = pool.get('a');
  replacement.resolve('new');
  const fresh = await newWaiter;
  const shared = await sharedWaiter;
  assert.equal(fresh.value, 'new');
  assert.equal(shared.value, 'new');
  assert.equal(creates, 2);
  assert.deepEqual(closed, ['old']);
  fresh.release();
  shared.release();
  await pool.closeAll();
  assert.deepEqual(closed, ['old', 'new']);
});

test('one caller abort leaves pool-owned creation signal and other waiter active', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const pending = deferred();
  let factorySignal;
  const pool = new ConnectionPool({
    create: (_key, signal) => { factorySignal = signal; return pending.promise; },
    close: () => {},
    options: { maxConnections: 2, idleTtlMs: 1000 },
  });
  const abort = new AbortController();
  const cancelled = assert.rejects(pool.get('a', abort.signal), { name: 'AbortError' });
  const other = pool.get('a');
  await tick();
  abort.abort();
  await cancelled;
  assert.equal(factorySignal.aborted, false);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  pending.resolve('connection');
  const lease = await other;
  assert.equal(lease.value, 'connection');
  lease.release();
  await pool.closeAll();
});
