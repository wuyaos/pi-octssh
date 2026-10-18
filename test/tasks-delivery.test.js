const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * 任务通知：去重、重启保留、损坏不静默、扫描语义。
 *
 * 为什么这些必须进仓库：
 * - 去重坏了 → 同一个任务反复唤醒模型（骚扰）；
 * - 重启保留坏了 → 已通知的又通知一次，或待通知的丢了；
 * - 损坏静默当空 → 已投递记录消失，同样的通知再来一遍；
 * - unknown 被当成终态 → 断网被报成「任务失败」。
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-tasks-'));
}

function self(holderId) {
  return { holderId, hostname: os.hostname(), pid: process.pid, acquiredAt: Date.now() };
}

async function modules() {
  return {
    store: await loadTs('tasks/store.ts'),
    delivery: await loadTs('tasks/delivery.ts'),
    notify: await loadTs('tasks/notify.ts'),
    state: await loadTs('tasks/state.ts'),
  };
}

function event(state, taskId = 't1', extra = {}) {
  return { eventId: state.eventId(taskId, 'done'), taskId, kind: 'screen', machine: 'm', projectId: 'p1', state: 'done', exitCode: 0, ...extra };
}

test('同一事件投两次 → 第二次 duplicate，且只发送一次', async () => {
  const { store: storeMod, delivery: deliveryMod, state } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  const sent = [];
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload) });
  const ev = event(state);
  assert.equal((await delivery.deliver(ev)).kind, 'delivered');
  assert.equal((await delivery.deliver(ev)).kind, 'duplicate');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].taskId, 't1');
  assert.equal(sent[0].stdout, undefined, '通知正文不得带日志');
});

test('重启后已投递记录仍在：新 store 实例不会重复投递', async () => {
  const { store: storeMod, delivery: deliveryMod, state } = await modules();
  const baseDir = tmpDir();
  const ev = event(state);
  const first = deliveryMod.createDelivery({ store: storeMod.createTaskStore({ baseDir }), self: self('A'), send: () => {} });
  assert.equal((await first.deliver(ev)).kind, 'delivered');

  const sent = [];
  const second = deliveryMod.createDelivery({ store: storeMod.createTaskStore({ baseDir }), self: self('B'), send: (payload) => sent.push(payload) });
  assert.equal((await second.deliver(ev)).kind, 'duplicate');
  assert.equal(sent.length, 0);
});

test('异机持有者的租约不可抢（即便注入的判活实现说它死了）', async () => {
  const { store: storeMod, delivery: deliveryMod, state } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  const foreign = { holderId: 'X', hostname: 'another-host', pid: 999999, acquiredAt: 1 };
  await store.tryAcquireLease('t1', foreign);
  const delivery = deliveryMod.createDelivery({
    store,
    self: self('B'),
    send: () => {},
    // 朴素实现：只回答「同机 pid 是否存活」，对异机返回 false
    isHolderAlive: () => false,
  });
  const outcome = await delivery.deliver(event(state));
  assert.equal(outcome.kind, 'lease_held', '异机租约必须由库内规则挡住，不能靠注入点');
  assert.equal(outcome.holder.holderId, 'X');
});

test('通道忙碌时排队且不标已投递，转为 ready 后补发一次', async () => {
  const { store: storeMod, delivery: deliveryMod, state } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  const sent = [];
  let channel = 'busy';
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload), channelState: () => channel });
  const ev = event(state);
  const queued = await delivery.deliver(ev);
  assert.equal(queued.kind, 'queued');
  assert.equal(sent.length, 0);
  assert.equal(await store.isDelivered(ev.eventId), false, '排队不等于已投递');

  channel = 'ready';
  const flushed = await delivery.flush();
  assert.equal(flushed.delivered.length, 1);
  assert.equal(flushed.remaining.length, 0);
  assert.equal(sent.length, 1);
});

test('索引损坏 → 显式上报并保留原文件，不静默当空', async () => {
  const { store: storeMod } = await modules();
  const baseDir = tmpDir();
  const store = storeMod.createTaskStore({ baseDir });
  store.saveTasks([{ taskId: 't1', kind: 'screen', projectId: 'p1', machine: 'm', state: 'running' }]);
  fs.writeFileSync(path.join(baseDir, 'tasks', 'index.json'), '{ broken');

  const reopened = storeMod.createTaskStore({ baseDir });
  assert.deepEqual(reopened.loadTasks(), []);
  const status = reopened.status();
  assert.equal(status.storeCorrupt, true);
  assert.ok(status.corruptFiles.length >= 1);
  assert.ok(fs.existsSync(status.corruptFiles[0].renamedTo), '原文件必须改名保留');
});

test('裁剪只动已投递记录：超出 maxEntries 的被删，最近的保留', async () => {
  const { store: storeMod } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  const ids = ['a', 'b', 'c', 'd'];
  for (const id of ids) await store.markDelivered(`evt-${id}`);
  const pruned = store.pruneDelivered({ maxEntries: 2 });
  assert.equal(pruned.removed.length, 2);
  assert.equal(pruned.kept.length, 2);
  assert.equal(await store.isDelivered('evt-d'), true, '最近一条必须保留');
  assert.equal(await store.isDelivered('evt-a'), false);
});

test('eventId 稳定：同一 (任务, 终态) 反复扫描必然相同', async () => {
  const { state } = await modules();
  assert.equal(state.eventId('t1', 'done'), state.eventId('t1', 'done'));
  assert.notEqual(state.eventId('t1', 'done'), state.eventId('t1', 'failed'));
});

test('扫描：终态任务产出一次事件并写回 emittedEventId，第二轮不再重复', async () => {
  const { store: storeMod, delivery: deliveryMod, notify } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  store.saveTasks([{ taskId: 't1', kind: 'screen', projectId: 'p1', machine: 'm', state: 'running' }]);
  const sent = [];
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload) });
  const observe = async () => ({ observation: 'reachable', state: 'done', exitCode: 0 });

  const first = await notify.runTaskSweep({ store, delivery, observe, hasSessionForProject: () => true });
  assert.equal(first.eventsProduced, 1);
  assert.equal(first.delivered.length, 1);
  assert.ok(store.loadTasks()[0].emittedEventId, '必须写回 emittedEventId');

  const second = await notify.runTaskSweep({ store, delivery, observe, hasSessionForProject: () => true });
  assert.equal(second.eventsProduced, 0);
  assert.equal(sent.length, 1);
});

test('扫描：观测 unknown 不产事件、不改状态；观测抛错不影响其它任务', async () => {
  const { store: storeMod, delivery: deliveryMod, notify } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  store.saveTasks([
    { taskId: 'flaky', kind: 'screen', projectId: 'p1', machine: 'm', state: 'running' },
    { taskId: 'good', kind: 'screen', projectId: 'p1', machine: 'm', state: 'running' },
  ]);
  const sent = [];
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload) });
  const observe = async (record) => {
    if (record.taskId === 'flaky') throw new Error('network down');
    if (record.taskId === 'unknown-one') return { observation: 'unknown' };
    return { observation: 'reachable', state: 'done', exitCode: 0 };
  };

  const summary = await notify.runTaskSweep({ store, delivery, observe, hasSessionForProject: () => true });
  assert.equal(summary.eventsProduced, 1, '只有 good 产出事件');
  assert.equal(sent.length, 1);
  assert.equal(summary.observationFailures.length, 1);
  const flaky = store.loadTasks().find((r) => r.taskId === 'flaky');
  assert.equal(flaky.state, 'running', '观测失败不得改变任务状态');
  assert.equal(flaky.emittedEventId, undefined);
});

test('扫描：缺项目归属不猜、不产事件，只记 notAwakened', async () => {
  const { store: storeMod, delivery: deliveryMod, notify } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  store.saveTasks([{ taskId: 'old', kind: 'screen', machine: 'm', state: 'running' }]);
  const sent = [];
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload) });
  const observe = async () => ({ observation: 'reachable', state: 'done', exitCode: 0 });

  const summary = await notify.runTaskSweep({ store, delivery, observe, hasSessionForProject: () => true });
  assert.equal(summary.eventsProduced, 0);
  assert.equal(sent.length, 0);
  assert.deepEqual(summary.notAwakened, [{ taskId: 'old', state: 'done', reason: 'missing_project_id' }]);
});

test('扫描：无同项目会话时不产事件也不投递，留下轮重新推导', async () => {
  const { store: storeMod, delivery: deliveryMod, notify } = await modules();
  const store = storeMod.createTaskStore({ baseDir: tmpDir() });
  store.saveTasks([{ taskId: 't1', kind: 'screen', projectId: 'p1', machine: 'm', state: 'running' }]);
  const sent = [];
  const delivery = deliveryMod.createDelivery({ store, self: self('A'), send: (payload) => sent.push(payload) });
  const observe = async () => ({ observation: 'reachable', state: 'done', exitCode: 0 });

  const summary = await notify.runTaskSweep({ store, delivery, observe, hasSessionForProject: () => false });
  assert.equal(summary.eventsProduced, 0);
  assert.equal(sent.length, 0);
  assert.equal(store.loadTasks()[0].emittedEventId, undefined, '未被唤醒的任务不得标记为已发事件');
});
