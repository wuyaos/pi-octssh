const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { loadTs } = require('./helpers/load-ts.cjs');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-transfer-'));
}

test('walkLocal rejects symlinks instead of following directory loops', async () => {
  const { walkLocal } = await loadTs('transfer/localWalk.ts');
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'data.txt'), 'safe');
  fs.symlinkSync(root, path.join(root, 'nested', 'loop'));
  assert.throws(() => walkLocal(root), /symlinks are not allowed/);
});

test('walkLocal rejects junctions (same reparse-point defense, no admin required)', async (t) => {
  // 上面那条用例需要 SeCreateSymbolicLinkPrivilege（Windows 上等于管理员或开发者模式），
  // 在没开开发者模式的机器上它连 symlink 都建不出来。junction 不需要特权，而 Node 的
  // lstat 同样把它报成符号链接，因此这条覆盖的是同一段防御。
  const { walkLocal } = await loadTs('transfer/localWalk.ts');
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'nested'));
  fs.writeFileSync(path.join(root, 'nested', 'data.txt'), 'safe');
  try {
    fs.symlinkSync(root, path.join(root, 'nested', 'loop'), 'junction');
  } catch (error) {
    t.skip(`本机不允许创建 junction: ${error.code}`);
    return;
  }
  assert.throws(() => walkLocal(root), /symlinks are not allowed/);
});

test('planDownload does not create local directories', async () => {
  const { planDownload } = await loadTs('transfer/download.ts');
  const root = tempDir();
  const target = path.join(root, 'not-created');
  const client = {
    sftp(callback) {
      callback(null, {
        end() {},
        stat(_remote, done) { done(null, { size: 0, isFile: () => false, isDirectory: () => true }); },
        readdir(_remote, done) { done(null, []); },
      });
    },
  };
  const plan = await planDownload(client, '/remote', target);
  assert.equal(plan.isDir, true);
  assert.equal(fs.existsSync(target), false);
});

test('sftpGet writes atomically and abort does not create a destination', async () => {
  const { sftpGet, sftpPut } = await loadTs('ssh/sftp.ts');
  const root = tempDir();
  const source = path.join(root, 'source.txt');
  const destination = path.join(root, 'destination.txt');
  fs.writeFileSync(source, 'stream payload');

  let uploaded = '';
  const uploadSftp = {
    createWriteStream() {
      const stream = new PassThrough();
      stream.on('data', (chunk) => { uploaded += chunk.toString('utf8'); });
      return stream;
    },
  };
  await sftpPut(uploadSftp, source, '/remote/file');
  assert.equal(uploaded, 'stream payload');

  const downloadSftp = { createReadStream() { return fs.createReadStream(source); } };
  await sftpGet(downloadSftp, '/remote/file', destination);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'stream payload');

  const abort = new AbortController();
  abort.abort();
  const abortedTarget = path.join(root, 'aborted.txt');
  await assert.rejects(() => sftpGet(downloadSftp, '/remote/file', abortedTarget, abort.signal), { name: 'AbortError' });
  assert.equal(fs.existsSync(abortedTarget), false);
});

test('sftpStat preserves permission failures while returning null for not-found', async () => {
  const { sftpStat } = await loadTs('ssh/sftp.ts');
  await assert.rejects(
    () => sftpStat({ stat(_path, done) { done({ code: 3 }); } }, '/restricted'),
    (error) => error.code === 3,
  );
  assert.equal(await sftpStat({ stat(_path, done) { done({ code: 2 }); } }, '/missing'), null);
});
