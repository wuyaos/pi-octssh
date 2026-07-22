const test = require('node:test');
const assert = require('node:assert/strict');

test('ConnectionPool reuses per-key connections and enforces cap', async () => {
  const { ConnectionPool } = require('../dist/ssh/connectionPool.js');

  const closed = [];
  const pool = new ConnectionPool({
    create: async (k) => ({ key: k }),
    close: async (v) => {
      closed.push(v.key);
    },
    options: { maxConnections: 2, idleTtlMs: 10_000 }
  });

  const a1 = await pool.get('a');
  a1.release();
  const b1 = await pool.get('b');
  b1.release();
  assert.equal(pool.size(), 2);

  // Access 'a' again; should reuse.
  const a2 = await pool.get('a');
  assert.equal(a2.value.key, 'a');
  a2.release();

  // Adding a third key should evict one idle connection.
  const c = await pool.get('c');
  c.release();
  assert.equal(pool.size(), 2);
  assert.equal(closed.length, 1);
});

test('ConnectionPool sweep evicts idle entries after TTL', async () => {
  const { ConnectionPool } = require('../dist/ssh/connectionPool.js');

  let closed = 0;
  const pool = new ConnectionPool({
    create: async (k) => ({ key: k }),
    close: async () => {
      closed += 1;
    },
    options: { maxConnections: 10, idleTtlMs: 1 }
  });

  const lease = await pool.get('a');
  lease.release();
  await pool.sweep(Date.now() + 10);
  assert.equal(closed, 1);
  assert.equal(pool.size(), 0);
});
