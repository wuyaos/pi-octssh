const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

test('session approval isolates project and full identity, is revocable and not persisted', async () => {
  const { SessionApproval } = await loadTs('security/sessionApproval.ts');
  const grants = new SessionApproval();
  const identity = { alias: 'a', host: 'host', port: 22, user: 'user' };
  grants.enable('project', identity);
  assert.equal(grants.allows('project', identity), true);
  assert.equal(grants.allows('other', identity), false);
  assert.equal(grants.allows(undefined, identity), false);
  for (const change of [{ alias: 'b' }, { host: 'other' }, { port: 2222 }, { user: 'root' }, { jump: { host: 'jump', port: 22, user: 'user' } }]) {
    assert.equal(grants.allows('project', { ...identity, ...change }), false);
  }
  assert.equal(new SessionApproval().allows('project', identity), false);
  grants.disable('project', 'a');
  assert.equal(grants.allows('project', identity), false);
  grants.enable('project', identity);
  grants.clear();
  assert.deepEqual(grants.aliases('project'), []);
});

test('multicall and process wrappers require confirmation, not subcommand approval', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  const { subcommandScope } = await loadTs('security/commandShape.ts');
  for (const command of ['busybox reboot', 'toybox chmod 777 file', 'watch reboot', 'setsid reboot', 'ionice reboot', 'taskset 1 reboot', 'strace reboot', 'script -c reboot', 'chroot / reboot', 'setpriv reboot']) {
    assert.equal((await guardExecCommand({ command, client: {}, machine: 'test', allowSudo: false,
      security: { denyRegex: [], denyExecutables: [], requireConfirmRegex: [] } })).action, 'needs_confirmation', command);
    assert.equal(subcommandScope(command), undefined);
  }
});


test('registered allow-all command skips only confirmations and clears on off/session change', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-approval-'));
  const old = [process.env.OCTSSH_HOME, process.env.OCTSSH_SSH_CONFIG];
  process.env.OCTSSH_HOME = dir;
  process.env.OCTSSH_SSH_CONFIG = path.join(dir, 'sshconfig');
  fs.writeFileSync(process.env.OCTSSH_SSH_CONFIG, 'Host fixture\n HostName 127.0.0.1\n User fixture\n');
  const { createOctsshRuntime } = await loadTs('index.ts');
  const { resolveIdentity } = await loadTs('ssh/machine.ts');
  const { default: extension } = await loadTs('../extensions/octssh.ts');
  const proto = Object.getPrototypeOf(createOctsshRuntime());
  const originalExec = proto.exec;
  const originalAuthorize = proto.authorize;
  let blocked = false;
  proto.authorize = () => ({ token: 'fixture' });
  proto.exec = async (params) => {
    if (blocked) return { kind: 'blocked', reason: 'project_deny', message: 'denied' };
    if (params.authorization) return { kind: 'success', exitCode: 0 };
    return { kind: 'needs_confirmation', authorizationRequest: { id: 'fixture', operation: 'exec', message: 'confirm',
      preview: { total: 1, truncated: false, sample: [] }, scope: { operation: 'exec', identity: resolveIdentity('fixture') } } };
  };
  const tools = new Map(), events = new Map(), commands = new Map(), statuses = new Map();
  extension({ registerTool: (x) => tools.set(x.name, x), registerCommand: (name, x) => commands.set(name, x), on: (name, fn) => events.set(name, fn) });
  let questions = 0;
  const ctx = { cwd: process.cwd(), mode: 'tui', hasUI: true, ui: {
    notify() {}, setStatus: (key, value) => statuses.set(key, value), theme: { fg: (_color, value) => value },
    confirm: async () => true, select: async () => { questions++; return undefined; },
  } };
  const invoke = () => tools.get('octssh_exec').execute('test', { machine: 'fixture', command: 'reboot' }, undefined, () => {}, ctx);
  try {
    await events.get('session_start')({}, ctx);
    await commands.get('octssh').handler('allow-all fixture', ctx);
    assert.match(statuses.get('octssh-approval'), /fixture/);
    assert.equal((await invoke()).isError, undefined);
    assert.equal(questions, 0);
    blocked = true;
    assert.equal((await invoke()).isError, true);
    assert.equal(questions, 0);
    blocked = false;
    await commands.get('octssh').handler('allow-all fixture off', ctx);
    assert.equal((await invoke()).isError, true);
    assert.equal(questions, 1);
    await commands.get('octssh').handler('allow-all fixture', ctx);
    await events.get('session_start')({}, ctx);
    assert.equal(statuses.get('octssh-approval'), undefined);
    assert.equal((await invoke()).isError, true);
    assert.equal(questions, 2);
  } finally {
    await events.get('session_shutdown')();
    proto.exec = originalExec;
    proto.authorize = originalAuthorize;
    for (const [key, value] of [['OCTSSH_HOME', old[0]], ['OCTSSH_SSH_CONFIG', old[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
