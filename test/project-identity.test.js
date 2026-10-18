const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * 项目身份：权限规则按项目隔离，身份算错就会出现两种静默故障——
 * 同一个项目被判成两个（已批准的规则不生效），或两个项目被判成一个
 * （授权跨项目串用）。
 */

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-project-'));
}

function writeMarker(dir) {
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.pi', 'octssh.json'), '{}');
}

test('git 仓库取工作树根：子目录与仓库根同一 id', async () => {
  const { projectIdFromCwd, projectDisplayPath } = await loadTs('security/project.ts');
  const repo = path.join(tmpDir(), 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });

  assert.equal(projectIdFromCwd(path.join(repo, 'src', 'deep')), projectIdFromCwd(repo));
  assert.equal(projectDisplayPath(path.join(repo, 'src', 'deep')), projectDisplayPath(repo));
});

test('非 git 项目：向上找到 .pi/octssh.json 即以该目录为根', async () => {
  const { projectIdFromCwd, projectDisplayPath, findProjectMarkerRoot } = await loadTs('security/project.ts');
  const outer = path.join(tmpDir(), 'outer');
  const inner = path.join(outer, 'inner');
  fs.mkdirSync(path.join(inner, 'deeper'), { recursive: true });
  writeMarker(inner);

  const innerId = projectIdFromCwd(inner);
  assert.equal(projectIdFromCwd(path.join(inner, 'deeper')), innerId, '子目录必须归入同一项目');
  assert.notEqual(projectIdFromCwd(outer), innerId, '标记之外的目录是另一个项目');
  assert.equal(findProjectMarkerRoot(path.join(inner, 'deeper')), inner);
  assert.equal(projectDisplayPath(path.join(inner, 'deeper')), inner);
});

test('git 优先于标记文件：仓库子目录里的 .pi/octssh.json 不切碎项目', async () => {
  const { projectIdFromCwd } = await loadTs('security/project.ts');
  const repo = path.join(tmpDir(), 'repo');
  const sub = path.join(repo, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  writeMarker(sub);

  assert.equal(projectIdFromCwd(sub), projectIdFromCwd(repo));
});

test('完全没有标记时回落启动目录：父子目录是不同 id（已知行为）', async () => {
  const { projectIdFromCwd } = await loadTs('security/project.ts');
  const base = path.join(tmpDir(), 'plain');
  const sub = path.join(base, 'x');
  fs.mkdirSync(sub, { recursive: true });
  assert.notEqual(projectIdFromCwd(base), projectIdFromCwd(sub));
});

test('不同项目 id 互不相同，规则文件也互不可见', async () => {
  const { projectIdFromCwd } = await loadTs('security/project.ts');
  const { addRule, listRules } = await loadTs('security/rules.ts');
  const { scopeRule } = await loadTs('security/authorize.ts');
  const base = tmpDir();
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });

  const idA = projectIdFromCwd(a);
  const idB = projectIdFromCwd(b);
  assert.notEqual(idA, idB);

  const rule = scopeRule({ operation: 'exec', identity: { alias: 'h', host: '10.0.0.1', port: 22, user: 'u' }, command: { value: 'uptime', sudo: false } }, 'allow');
  addRule(idA, rule, base);
  assert.equal(listRules(idA, base).length, 1);
  assert.equal(listRules(idB, base).length, 0, 'A 的规则不得出现在 B');
});
