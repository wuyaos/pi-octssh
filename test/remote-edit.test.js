const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * applyEdit 的结果语义与调用顺序。
 *
 * 为什么这些必须进仓库：行内语义一旦回归（例如 rename 之后的失败又被报成
 * `not_written`），上层会告诉用户「文件没动」，而文件其实已经换了内容。
 * 这类错误不会让任何东西崩溃，只会让人做错决定。
 */

const BASE_ATTRS = { mode: 0o100644, uid: 1000, gid: 1000, atime: 1_700_000_000, mtime: 1_700_000_000, kind: 'file' };
const TARGET = '/d/f.txt';

async function makeOps(options = {}) {
  const fp = await loadTs('remote/fingerprint.ts');
  const calls = [];
  let reads = 0;
  let target = Buffer.from('a\nb\n');
  let tempBytes = null;
  const tempPath = '/d/.octssh-tmp-1';

  const tokenFor = (bytes) => fp.encodeStrongFingerprint({ ...BASE_ATTRS, size: bytes.length, inode: '7', nlink: '1' });

  const ops = {
    calls,
    tokenFor,
    get target() { return target; },
    async lstat(path) {
      calls.push(`lstat:${path}`);
      if (options.missing) return null;
      if (options.symlink) return { ...BASE_ATTRS, size: target.length, kind: 'symlink' };
      if (path === tempPath) return { ...BASE_ATTRS, mode: 0o100600, size: tempBytes ? tempBytes.length : 0 };
      return { ...BASE_ATTRS, size: target.length };
    },
    async stat(path) {
      calls.push(`stat:${path}`);
      if (options.noStatTemplate) return null;
      return { inode: '7', nlink: options.nlink ?? '1' };
    },
    async readFile(path) {
      reads += 1;
      calls.push(`read:${path}`);
      if (options.readThrowAt && reads === options.readThrowAt) throw new Error('connection reset during read');
      if (options.readMismatchAt && reads === options.readMismatchAt) return Buffer.from('different-bytes');
      return Buffer.from(target);
    },
    async createTempFile() {
      calls.push('createTemp');
      if (options.tempFails) throw new Error('cannot create temp');
      return tempPath;
    },
    async writeFile(path, bytes) {
      calls.push(`write:${path}`);
      if (options.writeFails) throw new Error('disk full');
      tempBytes = Buffer.from(bytes);
    },
    async removeFile(path) { calls.push(`remove:${path}`); },
    async chmod(path, mode) { calls.push(`chmod:${path}:${mode.toString(8)}`); },
    async chown(path, uid, gid) {
      calls.push(`chown:${path}:${uid}:${gid}`);
      if (options.chownFails) throw new Error('EPERM: operation not permitted');
    },
    async setTimes(path) { calls.push(`setTimes:${path}`); },
    async posixRename(from, to) {
      calls.push(`rename:${from}->${to}`);
      if (options.renameUnsupported) {
        const error = new Error('server does not support posix-rename');
        error.code = 'POSIX_RENAME_UNSUPPORTED';
        throw error;
      }
      if (options.renameThrows) throw new Error('connection dropped during rename');
      target = Buffer.from(tempBytes);
    },
  };
  return ops;
}

async function runEdit(ops, overrides = {}) {
  const { applyEdit } = await loadTs('remote/applyEdit.ts');
  return applyEdit({
    fileOps: ops,
    path: TARGET,
    expectedVersion: ops.tokenFor(Buffer.from('a\nb\n')),
    oldText: 'b',
    newText: 'B',
    ...overrides,
  });
}

test('applyEdit 成功：内容替换、属性复原、返回新 token', async () => {
  const ops = await makeOps();
  const result = await runEdit(ops);
  assert.equal(result.kind, 'success');
  assert.equal(ops.target.toString(), 'a\nB\n');
  assert.equal(result.bytesWritten, 4);
  // 属性必须作用在临时文件上，目标文件只被 rename 动一次
  assert.ok(ops.calls.some((c) => c.startsWith('chmod:/d/.octssh-tmp-1')), 'chmod 应作用于临时文件');
  assert.ok(ops.calls.some((c) => c.startsWith('chown:/d/.octssh-tmp-1')), 'chown 应作用于临时文件');
  assert.ok(ops.calls.includes('setTimes:/d/.octssh-tmp-1'));
  assert.equal(ops.calls.filter((c) => c.startsWith('rename:')).length, 1);
  assert.match(result.newVersion, /^v1i\|/);
});

test('applyEdit 顺序：建临时文件与第二次指纹核验都在 rename 之前，rename 之后只读', async () => {
  const ops = await makeOps();
  await runEdit(ops);
  const renameIndex = ops.calls.findIndex((c) => c.startsWith('rename:'));
  const tempIndex = ops.calls.indexOf('createTemp');
  assert.ok(tempIndex > -1 && tempIndex < renameIndex, 'createTemp 必须在 rename 之前');
  // rename 前应已对目标做过至少两轮 lstat+stat（一次取指纹，一次复核）
  const beforeRename = ops.calls.slice(0, renameIndex);
  assert.ok(beforeRename.filter((c) => c === `lstat:${TARGET}`).length >= 2, 'rename 前应复核过目标指纹');
  const afterRename = ops.calls.slice(renameIndex + 1);
  for (const call of afterRename) {
    assert.ok(/^(read|lstat|stat):/.test(call), `rename 之后不应再有修改操作，实际出现 ${call}`);
  }
});

test('applyEdit 写失败 → not_written，清掉临时文件且不 rename', async () => {
  const ops = await makeOps({ writeFails: true });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'not_written');
  assert.ok(ops.calls.includes('remove:/d/.octssh-tmp-1'), '临时文件必须清理');
  assert.ok(!ops.calls.some((c) => c.startsWith('rename:')), '不得 rename');
  assert.equal(ops.target.toString(), 'a\nb\n');
});

test('applyEdit chown 不可复原 → unsupported，不 rename', async () => {
  const ops = await makeOps({ chownFails: true });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.reason, 'chown_not_restorable');
  assert.ok(!ops.calls.some((c) => c.startsWith('rename:')));
});

test('applyEdit 不支持 posix-rename → unsupported，目标不动', async () => {
  const ops = await makeOps({ renameUnsupported: true });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'unsupported');
  assert.equal(result.reason, 'posix_rename_unsupported');
  assert.equal(ops.target.toString(), 'a\nb\n');
  assert.ok(ops.calls.includes('remove:/d/.octssh-tmp-1'));
});

test('applyEdit rename 本身抛错 → outcome_unknown（不得声称未写入）', async () => {
  const ops = await makeOps({ renameThrows: true });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'outcome_unknown');
  assert.equal(result.tempRemoved, false);
});

test('applyEdit rename 之后回读抛错 → outcome_unknown，绝不报 not_written', async () => {
  // 回归点：rename 已生效，文件其实换了内容；报 not_written 就是谎报。
  // 第一次 read 是读取原文（读成功），第二次是回读核验。
  const ops = await makeOps({ readThrowAt: 2 });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'outcome_unknown');
  assert.ok(ops.calls.some((c) => c.startsWith('rename:')), '该用例的前提是 rename 已执行');
});

test('applyEdit rename 之后回读内容不一致 → outcome_unknown，不是 conflict', async () => {
  const ops = await makeOps({ readMismatchAt: 2 });
  const result = await runEdit(ops);
  assert.equal(result.kind, 'outcome_unknown');
});

test('applyEdit 硬链接 / 符号链接 / 不存在 / 模板不可用 → unsupported 且不建临时文件', async () => {
  for (const [options, reason] of [
    [{ nlink: '2' }, 'hard_linked'],
    [{ symlink: true }, 'symlink'],
    [{ missing: true }, 'not_found'],
    [{ noStatTemplate: true }, 'stat_template_unavailable'],
  ]) {
    const ops = await makeOps(options);
    const result = await runEdit(ops);
    assert.equal(result.kind, 'unsupported', `${reason} 应判 unsupported`);
    assert.equal(result.reason, reason);
    assert.ok(!ops.calls.includes('createTemp'), `${reason} 不得创建临时文件`);
    assert.ok(!ops.calls.some((c) => c.startsWith('rename:')));
  }
});

test('applyEdit 版本不符 → conflict 且不建临时文件', async () => {
  const ops = await makeOps();
  const { applyEdit } = await loadTs('remote/applyEdit.ts');
  const staleToken = ops.tokenFor(Buffer.from('stale-and-longer'));
  const result = await applyEdit({ fileOps: ops, path: TARGET, expectedVersion: staleToken, oldText: 'b', newText: 'B' });
  assert.equal(result.kind, 'conflict');
  assert.ok(!ops.calls.includes('createTemp'));
});

test('applyEdit 弱 token 一律 unsupported，不得降级当 CAS', async () => {
  const ops = await makeOps();
  const fp = await loadTs('remote/fingerprint.ts');
  const weak = fp.encodeWeakFingerprint({ ...BASE_ATTRS, size: 4, type: 'file' });
  const { applyEdit } = await loadTs('remote/applyEdit.ts');
  const result = await applyEdit({ fileOps: ops, path: TARGET, expectedVersion: weak, oldText: 'b', newText: 'B' });
  assert.equal(result.kind, 'unsupported');
  assert.ok(!ops.calls.includes('createTemp'));
});

test('applyEdit 空操作 → no_change，且完全不碰远端', async () => {
  const ops = await makeOps();
  const result = await runEdit(ops, { newText: 'b' });
  assert.equal(result.kind, 'no_change');
  assert.equal(result.remoteNotChecked, true);
  assert.deepEqual(ops.calls, [], '空操作不应产生任何远端调用');
});

test('applyEdit dryRun → 只返回计划，不建临时文件', async () => {
  const ops = await makeOps();
  const result = await runEdit(ops, { dryRun: true });
  assert.equal(result.kind, 'dry_run');
  assert.ok(Array.isArray(result.diff.lines));
  assert.ok(!ops.calls.includes('createTemp'));
  assert.ok(!ops.calls.some((c) => c.startsWith('rename:')));
});
