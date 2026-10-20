const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Writable } = require('node:stream');
const { loadTs } = require('./helpers/load-ts.cjs');

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-auth-'));
  const previous = [process.env.OCTSSH_HOME, process.env.OCTSSH_SSH_CONFIG];
  process.env.OCTSSH_HOME = dir;
  process.env.OCTSSH_SSH_CONFIG = path.join(dir, 'config');
  fs.writeFileSync(process.env.OCTSSH_SSH_CONFIG, 'Host fixture\n HostName 127.0.0.1\n User fixture\n');
  const local = path.join(dir, 'input.txt');
  fs.writeFileSync(local, 'payload');
  const { createOctsshRuntime } = await loadTs('core/runtime.ts');
  const rt = createOctsshRuntime();
  rt.start();
  t.after(async () => {
    await rt.shutdown();
    for (const [key, value] of [['OCTSSH_HOME', previous[0]], ['OCTSSH_SSH_CONFIG', previous[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  let writes = 0;
  let leases = 0;
  const client = { sftp(cb) { cb(null, {
    stat(_p, cb) { cb(null, { isDirectory: () => false }); },
    mkdir(_p, cb) { cb(null); },
    createWriteStream() { return new Writable({ write(_chunk, _encoding, done) { writes++; done(); } }); },
    end() {},
  }); } };
  rt.pool = { get: async () => { leases++; return { value: { ssh: { client } }, release() {} }; }, closeAll: async () => {} };
  return { rt, local, dir, writes: () => writes, leases: () => leases };
}

test('upload policy ask and overwrite share one confirmation, not a token loop', async (t) => {
  const f = await fixture(t);
  const params = { machine: 'fixture', localPath: f.local, remotePath: '/target', projectId: 'project' };
  const first = await f.rt.upload(params);
  assert.equal(first.kind, 'needs_confirmation');
  assert.equal(first.authorizationRequest.preview.type, 'upload-conflicts');
  const authorization = f.rt.authorize(first.authorizationRequest);
  const result = await f.rt.upload({ ...params, authorization });
  assert.equal(result.kind, 'success');
  assert.equal(f.writes(), 1);
});

test('project deny blocks upload and download before acquiring a connection', async (t) => {
  const f = await fixture(t);
  const { resolveIdentity } = await loadTs('ssh/machine.ts');
  const { scopeRule } = await loadTs('security/authorize.ts');
  const { addRule } = await loadTs('security/rules.ts');
  for (const operation of ['upload', 'download']) {
    addRule('project', scopeRule({ operation, identity: resolveIdentity('fixture'), path: { value: '/target', subtree: false } }, 'deny'));
    for (const suffix of ['', 'Async']) {
      const result = await f.rt[operation + suffix]({ machine: 'fixture', localPath: f.local, remotePath: '/target', projectId: 'project' });
      assert.equal(result.kind, 'blocked');
    }
  }
  assert.equal(f.leases(), 0);
});

test('permanent single-file upload scope uses actual target and allows replay', async (t) => {
  const f = await fixture(t);
  const { scopeRule } = await loadTs('security/authorize.ts');
  const { addRule } = await loadTs('security/rules.ts');
  const params = { machine: 'fixture', localPath: f.local, remotePath: '/target-dir/', projectId: 'project' };
  const first = await f.rt.upload(params);
  assert.equal(first.authorizationRequest.scope.path.value, '/target-dir/input.txt');
  assert.equal(first.authorizationRequest.allowPermanent, true);
  addRule('project', scopeRule(first.authorizationRequest.scope, 'allow'));
  assert.equal((await f.rt.upload(params)).kind, 'success');
  assert.equal(f.writes(), 1);
});

test('directory upload never offers permanent scope for the whole input directory', async (t) => {
  const f = await fixture(t);
  const directory = path.join(f.dir, 'upload');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'file'), 'data');
  for (const method of ['upload', 'uploadAsync']) {
    const result = await f.rt[method]({ machine: 'fixture', localPath: directory, remotePath: '/target', projectId: 'project' });
    assert.equal(result.kind, 'needs_confirmation');
    assert.equal(result.authorizationRequest.allowPermanent, false);
  }
});


test('registered transfer tool passes project identity and confirmation token for all modes', async (t) => {
  await fixture(t);
  const { createOctsshRuntime } = await loadTs('index.ts');
  const { default: extension } = await loadTs('../extensions/octssh.ts');
  const prototype = Object.getPrototypeOf(createOctsshRuntime());
  const originals = new Map();
  const token = { token: 'fixture-token' };
  const methods = ['upload', 'uploadAsync', 'download', 'downloadAsync', 'authorize'];
  let calls = [];
  for (const method of methods) {
    originals.set(method, prototype[method]);
    prototype[method] = method === 'authorize' ? () => token : async function (params) {
      calls.push(params);
      if (calls.length === 1) return { kind: 'needs_confirmation', authorizationRequest: {
        id: 'fixture', operation: method, message: '确认', preview: { total: 1, truncated: false, sample: [] }, expiresAt: Date.now() + 60000,
      } };
      return { kind: 'success' };
    };
  }
  const tools = new Map();
  const events = new Map();
  extension({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on: (name, fn) => events.set(name, fn) });
  const ctx = { cwd: process.cwd(), hasUI: true, mode: 'tui', ui: {
    notify() {}, setStatus() {}, theme: { fg: (_color, value) => value }, select: async (_title, options) => options[0],
  } };
  await events.get('session_start')({}, ctx);
  try {
    for (const direction of ['upload', 'download']) for (const async of [false, true]) {
      calls = [];
      const result = await tools.get('octssh_transfer').execute('fixture', {
        direction, async, machine: 'fixture', localPath: '/local', remotePath: '/remote',
      }, new AbortController().signal, () => {}, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(calls.length, 2);
      assert.match(calls[0].projectId, /^proj-v1:/);
      assert.equal(calls[1].projectId, calls[0].projectId);
      assert.equal(calls[1].authorization, token);
    }
  } finally {
    await events.get('session_shutdown')();
    for (const [method, original] of originals) prototype[method] = original;
  }
});
