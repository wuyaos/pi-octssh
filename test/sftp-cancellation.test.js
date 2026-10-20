const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { PassThrough } = require('node:stream');
const { loadTs } = require('./helpers/load-ts.cjs');

function rawChannel() {
  const raw = new EventEmitter();
  raw.end = () => { raw.ended = true; raw.emit('close'); };
  raw.destroy = () => {};
  return raw;
}

test('cancel pending SFTP IO, ignore late success and prevent further writes', async () => {
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  const raw = rawChannel();
  let late;
  let writes = 0;
  raw.lstat = (_path, cb) => { late = cb; };
  raw.write = () => { writes++; };
  const controller = new AbortController();
  const sftp = scopeSftp(raw, controller.signal);
  let completions = 0;
  const pending = new Promise((resolve) => sftp.lstat('/file', (err) => { completions++; resolve(err); }));
  controller.abort();
  assert.equal((await pending).name, 'AbortError');
  late(null, {});
  assert.equal(completions, 1);
  const rejected = await new Promise((resolve) => sftp.write('handle', resolve));
  assert.equal(rejected.name, 'AbortError');
  assert.equal(writes, 0);
  assert.equal(raw.ended, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('SFTP callback deadline rejects a server that never responds', async () => {
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  const raw = rawChannel();
  raw.stat = () => {};
  const sftp = scopeSftp(raw, undefined, 20);
  const err = await new Promise((resolve) => sftp.stat('/file', resolve));
  assert.equal(err.name, 'TimeoutError');
  assert.equal(raw.ended, true);
});

test('cancel active read stream and release abort listener', async () => {
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  const raw = rawChannel();
  raw.createReadStream = () => new PassThrough();
  const controller = new AbortController();
  const sftp = scopeSftp(raw, controller.signal);
  const stream = sftp.createReadStream('/file');
  const failure = new Promise((resolve) => stream.once('error', resolve));
  controller.abort();
  assert.equal((await failure).name, 'AbortError');
  assert.equal(stream.destroyed, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('stream idle deadline ends stalled read; successful read preserves bytes', async () => {
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  for (const stalled of [false, true]) {
    const raw = rawChannel();
    const stream = new PassThrough();
    raw.createReadStream = () => stream;
    const sftp = scopeSftp(raw, undefined, 25);
    const read = sftp.createReadStream('/file');
    if (stalled) {
      const failure = new Promise((resolve) => read.once('error', resolve));
      assert.equal((await failure).name, 'TimeoutError');
    } else {
      const chunks = [];
      read.on('data', (chunk) => chunks.push(chunk));
      const done = new Promise((resolve) => read.once('end', resolve));
      stream.end(Buffer.from('完整内容'));
      await done;
      sftp.end();
      assert.equal(Buffer.concat(chunks).toString(), '完整内容');
    }
  }
});

test('edit cancellation before rename is not_written; during/after rename is outcome_unknown', async () => {
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  const { applyEdit } = await loadTs('remote/applyEdit.ts');
  const { encodeStrongFingerprint } = await loadTs('remote/fingerprint.ts');
  for (const stage of ['write', 'rename', 'readback']) {
    const controller = new AbortController();
    const raw = rawChannel();
    let renameCalls = 0;
    raw.write = (...args) => { if (stage === 'write') controller.abort(); else args.at(-1)(null); };
    raw.ext_openssh_rename = (_from, _to, cb) => {
      renameCalls++;
      if (stage === 'rename') controller.abort(); else cb(null);
    };
    raw.read = () => controller.abort();
    raw.unlink = (_path, cb) => cb(null);
    const sftp = scopeSftp(raw, controller.signal);
    const invoke = (method, ...args) => new Promise((resolve, reject) => sftp[method](...args, (err) => err ? reject(err) : resolve()));
    const attrs = { mode: 0o100644, uid: 1000, gid: 1000, size: 2, atime: 1, mtime: 1, kind: 'file' };
    let reads = 0;
    const ops = {
      lstat: async () => attrs,
      stat: async () => ({ inode: '7', nlink: '1' }),
      readFile: async () => {
        if (++reads > 1) { await invoke('read', 'handle'); return Buffer.from('b\n'); }
        return Buffer.from('a\n');
      },
      createTempFile: async () => '/tmp/.edit',
      writeFile: () => invoke('write', 'handle'),
      removeFile: (p) => invoke('unlink', p),
      chown: async () => {}, chmod: async () => {}, setTimes: async () => {},
      posixRename: (a, b) => invoke('ext_openssh_rename', a, b),
    };
    const result = await applyEdit({ fileOps: ops, path: '/tmp/target', oldText: 'a', newText: 'b',
      expectedVersion: encodeStrongFingerprint({ ...attrs, inode: '7', nlink: '1' }) });
    assert.equal(result.kind, stage === 'write' ? 'not_written' : 'outcome_unknown');
    assert.equal(result.tempRemoved, false);
    assert.equal(renameCalls, stage === 'write' ? 0 : 1);
    sftp.end();
  }
});


test('real ssh2 ReadStream and WriteStream do not hang on cancelled OPEN', { timeout: 2000 }, async () => {
  const { SFTP } = require('ssh2/lib/protocol/SFTP.js');
  const { scopeSftp } = await loadTs('ssh/sftpScope.ts');
  for (const method of ['createReadStream', 'createWriteStream']) {
    const raw = rawChannel();
    raw.server = false;
    raw[method] = SFTP.prototype[method];
    raw.open = () => {};
    raw.close = () => {};
    const controller = new AbortController();
    const sftp = scopeSftp(raw, controller.signal);
    const stream = sftp[method]('/file');
    const error = new Promise((resolve) => stream.once('error', resolve));
    const closed = new Promise((resolve) => stream.once('close', resolve));
    if (method === 'createReadStream') stream.resume();
    else stream.write(Buffer.from('data'));
    controller.abort();
    assert.equal((await error).name, 'AbortError');
    await closed;
    assert.equal(stream.destroyed, true);
  }
});
