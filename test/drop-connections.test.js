const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * 「清凭据并断开连接」依赖两块基础设施：
 *  - 池的 dropAll()：断开全部缓存连接，但池必须继续可用；
 *  - 活跃传输摘要：确认框里必须准确说出「谁在跑」，否则会静默踩掉正在传的文件。
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-drop-'));
}

test('pool.dropAll 断开全部连接，且池随后仍可继续使用', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const closed = [];
  let created = 0;
  const pool = new ConnectionPool({
    create: async (key) => ({ key, id: ++created }),
    close: (value) => { closed.push(value.id); },
    options: { maxConnections: 5, idleTtlMs: 60_000 },
  });

  const a = await pool.get('a');
  await pool.get('b');
  assert.equal(pool.size(), 2);

  const dropped = await pool.dropAll();
  assert.equal(dropped, 2, '应报告断开的连接数');
  assert.deepEqual(closed.sort(), [1, 2], '每条连接都要走 close');
  assert.equal(pool.size(), 0);

  // 关键回归：dropAll 不能像 closeAll 那样把池置为关闭，否则「清凭据」之后再也连不上
  const again = await pool.get('a');
  assert.equal(again.value.id, 3, 'dropAll 之后必须还能新建连接');
  a.release();
  again.release();
});

test('pool.closeAll 是关闭语义（与 dropAll 区分开）', async () => {
  const { ConnectionPool } = await loadTs('ssh/connectionPool.ts');
  const pool = new ConnectionPool({
    create: async (key) => ({ key }),
    close: () => {},
    options: { maxConnections: 2, idleTtlMs: 1000 },
  });
  await pool.get('a');
  await pool.closeAll();
  await assert.rejects(() => pool.get('a'), /closed/);
});

test('活跃传输摘要：只认传输会话，读得出方向与路径', async () => {
  const { summarizeTransfers } = await loadTs('transfer/manager.ts');
  const { saveSession } = await loadTs('state/sessions.ts');
  const base = tmpDir();
  const now = new Date().toISOString();
  saveSession({
    kind: 'transfer',
    session_id: 't-1',
    machine: 'fnos',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    direction: 'upload',
    localPath: './app.tar.gz',
    remotePath: '/srv/app.tar.gz',
    bytesTotal: 100,
    bytesDone: 0,
    localLogPath: path.join(base, 't-1.log'),
  }, base);
  saveSession({
    session_id: 's-1',
    machine: 'fnos',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    backend: 'nohup',
    remoteDir: '.octssh/runs/s-1',
    stdoutPath: '.octssh/runs/s-1/stdout.log',
    stderrPath: '.octssh/runs/s-1/stderr.log',
    metaPath: '.octssh/runs/s-1/meta.json',
  }, base);

  const summary = summarizeTransfers(['t-1', 's-1', 'missing'], base);
  assert.equal(summary.length, 1, '远端后台任务与不存在的会话都不算活跃传输');
  assert.deepEqual(summary[0], {
    sessionId: 't-1',
    direction: 'upload',
    machine: 'fnos',
    localPath: './app.tar.gz',
    remotePath: '/srv/app.tar.gz',
  });
});
