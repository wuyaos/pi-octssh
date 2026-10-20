const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-sweep-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('busy lock fails immediately without sleeping or modifying owner', async (t) => {
  const { withLock, LockBusyError } = await loadTs('util/lockfile.ts');
  const lock = path.join(home(t), 'state.lock');
  const content = JSON.stringify({ pid: process.pid, instanceId: `${os.hostname()}#${process.pid}`, startedAt: new Date().toISOString() });
  fs.writeFileSync(lock, content);
  const wait = Atomics.wait;
  Atomics.wait = () => assert.fail('must not block Pi event loop');
  try {
    assert.throws(() => withLock(lock, () => assert.fail('must not enter busy critical section')), LockBusyError);
    assert.equal(fs.readFileSync(lock, 'utf8'), content);
  } finally { Atomics.wait = wait; }
});

test('lock releases on callback failure; nested acquisition fails without removing outer lock', async (t) => {
  const { withLock, LockBusyError } = await loadTs('util/lockfile.ts');
  const lock = path.join(home(t), 'state.lock');
  assert.throws(() => withLock(lock, () => {
    assert.throws(() => withLock(lock, () => {}), LockBusyError);
    assert.equal(fs.existsSync(lock), true);
    throw new Error('fixture');
  }), /fixture/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withLock(lock, () => 42), 42);
});

test('unknown or foreign lock owner cannot be taken over', async (t) => {
  const { withLock, LockBusyError } = await loadTs('util/lockfile.ts');
  const lock = path.join(home(t), 'state.lock');
  for (const contents of ['broken', JSON.stringify({ pid: 99999999, instanceId: 'foreign-host#99999999', startedAt: 'old' })]) {
    fs.writeFileSync(lock, contents);
    assert.throws(() => withLock(lock, () => {}), LockBusyError);
    assert.equal(fs.readFileSync(lock, 'utf8'), contents);
  }
});

test('Runtime shares same-project scan and releases gate after failure; shutdown aborts scan', async (t) => {
  const dir = home(t);
  const old = process.env.OCTSSH_HOME;
  process.env.OCTSSH_HOME = dir;
  t.after(() => { if (old === undefined) delete process.env.OCTSSH_HOME; else process.env.OCTSSH_HOME = old; });
  const { createOctsshRuntime } = await loadTs('core/runtime.ts');
  const rt = createOctsshRuntime();
  rt.start();
  t.after(() => rt.shutdown());
  let calls = 0;
  let reject;
  rt.performTaskSweep = (_params, signal) => {
    calls++;
    return new Promise((_resolve, fail) => {
      reject = fail;
      signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    });
  };
  const first = rt.sweepTasks({ projectId: 'a' });
  const second = rt.sweepTasks({ projectId: 'a' });
  assert.equal(first, second);
  assert.equal(calls, 1);
  await assert.rejects(rt.sweepTasks({ projectId: 'b' }), /扫描忙/);
  reject(new Error('fixture failure'));
  await assert.rejects(first, /fixture failure/);
  const third = rt.sweepTasks({ projectId: 'a' });
  assert.equal(calls, 2);
  const cancelled = assert.rejects(third, { name: 'AbortError' });
  await rt.shutdown();
  await cancelled;
});

test('cancelled observation does not persist state, emit completion or scan next task', async () => {
  const { runTaskSweep } = await loadTs('tasks/notify.ts');
  const controller = new AbortController();
  let observations = 0;
  const summary = await runTaskSweep({
    signal: controller.signal,
    store: { loadTasks: () => [{ taskId: 'a' }, { taskId: 'b' }], status: () => ({ storeCorrupt: false, corruptFiles: [] }),
      upsertTask: () => assert.fail('persist after cancellation') },
    delivery: { deliver: () => assert.fail('notify after cancellation') },
    observe: async () => { observations++; controller.abort(); return { observation: 'reachable', state: 'done' }; },
  });
  assert.equal(observations, 1);
  assert.equal(summary.eventsProduced, 0);
  assert.equal(summary.recordsUpdated, 0);
});
