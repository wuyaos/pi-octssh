const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

test('ConnectionPool reuses per-key connections and enforces cap', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const closed = [];
  const pool = new ConnectionPool({
    create: async (key) => ({ key }),
    close: async (value) => { closed.push(value.key); },
    options: { maxConnections: 2, idleTtlMs: 10_000 },
  });

  const a1 = await pool.get('a');
  a1.release();
  const b1 = await pool.get('b');
  b1.release();
  assert.equal(pool.size(), 2);

  const a2 = await pool.get('a');
  assert.equal(a2.value.key, 'a');
  a2.release();

  const c = await pool.get('c');
  c.release();
  assert.equal(pool.size(), 2);
  assert.equal(closed.length, 1);
});

test('ConnectionPool sweep evicts idle entries after TTL', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  let closed = 0;
  const pool = new ConnectionPool({
    create: async (key) => ({ key }),
    close: async () => { closed += 1; },
    options: { maxConnections: 10, idleTtlMs: 1 },
  });

  const lease = await pool.get('a');
  lease.release();
  await pool.sweep(Date.now() + 10);
  assert.equal(closed, 1);
  assert.equal(pool.size(), 0);
});

test('ConnectionPool isolates one waiters abort from a shared connection attempt', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  let resolveCreate;
  const connecting = new Promise((resolve) => { resolveCreate = resolve; });
  const pool = new ConnectionPool({
    create: () => connecting,
    close: () => {},
    options: { maxConnections: 2, idleTtlMs: 10_000 },
  });

  const firstAbort = new AbortController();
  const first = pool.get('shared', firstAbort.signal);
  const second = pool.get('shared');
  firstAbort.abort();
  await assert.rejects(first, { name: 'AbortError' });

  resolveCreate({ key: 'shared' });
  const lease = await second;
  assert.equal(lease.value.key, 'shared');
  lease.release();
});

test('ConnectionPool invalidate only closes the expected stale value', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const closed = [];
  const pool = new ConnectionPool({
    create: async (key) => ({ key }),
    close: async (value) => { closed.push(value); },
    options: { maxConnections: 2, idleTtlMs: 10_000 },
  });
  const initial = await pool.get('host');
  initial.release();
  assert.equal(await pool.invalidate('host', { key: 'other' }), false);
  assert.equal(pool.size(), 1);
  assert.equal(await pool.invalidate('host', initial.value), true);
  assert.equal(pool.size(), 0);
  assert.deepEqual(closed, [initial.value]);
});
