const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

function temporaryHome(t) {
  const previous = process.env.OCTSSH_HOME;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-cancel-'));
  process.env.OCTSSH_HOME = dir;
  t.after(() => {
    if (previous === undefined) delete process.env.OCTSSH_HOME;
    else process.env.OCTSSH_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}
function fakeClient(onExec) {
  const client = new EventEmitter();
  client.exec = (command, ...args) => {
    const cb = args.at(-1);
    const channel = new EventEmitter();
    channel.stderr = new EventEmitter();
    channel.close = () => { channel.closed = true; channel.emit('close', 0); };
    channel.destroy = () => {};
    channel.end = () => queueMicrotask(() => onExec(command, channel));
    cb(null, channel);
  };
  return client;
}
function complete(channel, code = 0, stdout = '', stderr = '') {
  if (stdout) channel.emit('data', Buffer.from(stdout));
  if (stderr) channel.stderr.emit('data', Buffer.from(stderr));
  channel.emit('close', code);
}

test('runtime session operations propagate abort through lease and exec and release lease', async (t) => {
  temporaryHome(t);
  const { createOctsshRuntime } = await loadTs('core/runtime.ts');
  const { saveSession } = await loadTs('state/sessions.ts');
  const now = new Date().toISOString();
  saveSession({ session_id: 'fixture', machine: 'fixture', status: 'running', createdAt: now, updatedAt: now,
    backend: 'nohup', cmdPid: 123, remoteDir: '.octssh/runs/fixture', stdoutPath: '.octssh/runs/fixture/stdout.log',
    stderrPath: '.octssh/runs/fixture/stderr.log', metaPath: '.octssh/runs/fixture/meta.json',
    stdinPath: '.octssh/runs/fixture/stdin.fifo', stdinLogPath: '.octssh/runs/fixture/stdin.log' });
  const calls = [
    (rt, signal) => rt.getSession('fixture', 10, undefined, signal),
    (rt, signal) => rt.grepSession('fixture', 'error', {}, undefined, signal),
    (rt, signal) => rt.writeStdin('fixture', 'hello', {}, undefined, undefined, signal),
    (rt, signal) => rt.cancelSession('fixture', 'TERM', undefined, undefined, signal),
  ];
  for (const call of calls) {
    const rt = createOctsshRuntime();
    const controller = new AbortController();
    let released = 0;
    let opened = 0;
    const client = fakeClient((_command, channel) => {
      opened++;
      controller.abort();
      assert.equal(channel.closed, true);
    });
    // 这里只隔离网络与确认 UI；被测的是实际 Runtime 调度和 runCommand 生命周期。
    rt.sessionConfirmation = async () => undefined;
    rt.pool = {
      get: async (_machine, signal) => {
        assert.equal(signal, controller.signal);
        return { value: { ssh: { client } }, release: () => { released++; } };
      },
      closeAll: async () => {},
    };
    rt.start();
    try {
      await assert.rejects(call(rt, controller.signal), { name: 'AbortError' });
      assert.equal(released, 1);
      assert.equal(opened, 1);
    } finally { await rt.shutdown(); }
  }
});

test('host info and deletion preview HOME probe are cancellable', async () => {
  const { collectExtendedInfo } = await loadTs('init/extended.ts');
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const call of [
    (client, signal) => collectExtendedInfo(client, signal),
    (client, signal) => guardExecCommand({ client, signal, machine: 'fixture', command: 'rm -r /tmp/example',
      allowSudo: false, security: { denyRegex: [], denyExecutables: [], requireConfirmRegex: [] } }),
  ]) {
    const controller = new AbortController();
    const client = fakeClient(() => controller.abort());
    await assert.rejects(call(client, controller.signal), { name: 'AbortError' });
  }
});

test('async startup cancellation covers probes and launcher, with no relaunch', async (t) => {
  const home = temporaryHome(t);
  const { startAsyncInScreen } = await loadTs('ssh/asyncScreen.ts');
  for (const stopAt of [1, 2, 3]) {
    const controller = new AbortController();
    let calls = 0;
    const client = fakeClient((_command, channel) => {
      calls++;
      if (calls === stopAt) controller.abort();
      else complete(channel, calls === 1 ? 1 : 0);
    });
    await assert.rejects(startAsyncInScreen(client, { machine: 'fixture', command: 'job', sudo: false, signal: controller.signal }), (error) => {
      assert.equal(error.name, 'AbortError');
      if (stopAt === 3) {
        assert.match(error.message, /session_id=/);
        assert.match(error.message, /勿重复启动/);
      }
      return true;
    });
    assert.equal(calls, stopAt);
  }
  assert.equal(fs.existsSync(path.join(home, 'sessions')), false);
});

test('launcher tty error is not permission to run the job a second time', async (t) => {
  temporaryHome(t);
  const { startAsyncInScreen } = await loadTs('ssh/asyncScreen.ts');
  let calls = 0;
  let launches = 0;
  const client = fakeClient((command, channel) => {
    calls++;
    if (command.includes('wrapper.sh')) launches++;
    if (calls <= 2) complete(channel);
    else if (calls === 3) complete(channel, 1, '', 'cannot open your terminal');
    else complete(channel);
  });
  await assert.rejects(startAsyncInScreen(client, { machine: 'fixture', command: 'job', sudo: false }), /启动结果未确认/);
  assert.equal(launches, 1);
});

test('registered tools reject pre-aborted calls and expose bounded sync timeout', async (t) => {
  temporaryHome(t);
  const { default: extension } = await loadTs('../extensions/octssh.ts');
  const tools = new Map();
  const events = new Map();
  extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on: (event, fn) => events.set(event, fn) });
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true,
    ui: { notify() {}, setStatus() {}, theme: { fg: (_color, text) => text }, select: () => assert.fail('dialog after abort') } };
  await events.get('session_start')({}, ctx);
  try {
    const controller = new AbortController();
    controller.abort(new Error('fixture-cancelled'));
    for (const [name, params] of [
      ['octssh_read', { machine: 'missing-fixture', path: '/tmp/test' }],
      ['octssh_exec', { machine: 'missing-fixture', command: 'true' }],
      ['octssh_session', { action: 'get', sessionId: 'missing-fixture' }],
      ['octssh_session', { action: 'grep', sessionId: 'missing-fixture', pattern: 'x' }],
      ['octssh_session', { action: 'write-stdin', sessionId: 'missing-fixture', data: 'x' }],
      ['octssh_session', { action: 'cancel', sessionId: 'missing-fixture' }],
    ]) {
      const result = await tools.get(name).execute('fixture', params, controller.signal, () => {}, ctx);
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /fixture-cancelled/);
    }
    const timeout = tools.get('octssh_exec').parameters.properties.timeoutSeconds;
    assert.equal(timeout.minimum, 1);
    assert.equal(timeout.maximum, 3600);
  } finally { await events.get('session_shutdown')(); }
});


test('SFTP acquisition abort closes late channel without entering operation', async () => {
  const { withSftp } = await loadTs('ssh/sftp.ts');
  const client = new EventEmitter();
  let callback;
  client.sftp = (cb) => { callback = cb; };
  const controller = new AbortController();
  const running = withSftp(client, () => assert.fail('operation after abort'), controller.signal);
  controller.abort();
  await assert.rejects(running, { name: 'AbortError' });
  const late = new EventEmitter();
  let ended = false;
  late.end = () => { ended = true; };
  late.destroy = () => {};
  callback(null, late);
  assert.equal(ended, true);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
  late.emit('error', new Error('late'));
});

test('SFTP acquisition timeout is bounded and does not enter operation', async () => {
  const { getSftp } = await loadTs('ssh/sftp.ts');
  const client = new EventEmitter();
  client.sftp = () => {};
  await assert.rejects(getSftp(client, undefined, 20), { name: 'TimeoutError' });
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
});
