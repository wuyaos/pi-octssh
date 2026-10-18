const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * 裁决语义：规则能不能命中「它本来要授权的那个请求」，以及禁止能不能被绕开。
 *
 * 为什么这些必须进仓库：
 * - 规则命中不上，用户会看到「已始终允许」却仍被反复询问；
 * - 规则命中过宽或跨族失效，禁止就形同虚设（换 exec-async 就绕过）。
 * 两者都是静默的：没有任何报错，只有错误的结果。
 */

const IDENTITY = { alias: 'minipc', host: '10.0.0.5', port: 22, user: 'deploy' };
const OTHER_HOST = { ...IDENTITY, host: '10.0.0.6' };
const WITH_JUMP = { ...IDENTITY, jump: { alias: 'gate', host: '10.0.0.9', port: 22, user: 'hop' } };

async function policy() {
  return {
    evaluate: await loadTs('security/evaluate.ts'),
    authorize: await loadTs('security/authorize.ts'),
    rules: await loadTs('security/rules.ts'),
  };
}

test('规则回放：由请求造出的规则必须能命中同一个请求（含引号/管道/中文）', async () => {
  const { evaluate, authorize } = await policy();
  for (const command of ['git status', `echo "a b" | grep -i 'x y'`, "tar -czf 备份.tar.gz /srv/数据", `python3 -c 'print("hi")'`]) {
    const scope = { operation: 'exec', identity: IDENTITY, command: { value: command, sudo: false } };
    const rule = { id: 'r1', createdAt: new Date().toISOString(), ...authorize.scopeRule(scope, 'allow') };
    const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command, sudo: false });
    assert.equal(evaluate.evaluateOperation(request, [rule]).decision, 'allow', `回放失败：${command}`);
  }
});

test('命令规则不做前缀授权：追加内容后必须回落 ask', async () => {
  const { evaluate, authorize } = await policy();
  const scope = { operation: 'exec', identity: IDENTITY, command: { value: 'git status', sudo: false } };
  const rule = { id: 'r1', createdAt: new Date().toISOString(), ...authorize.scopeRule(scope, 'allow') };
  for (const injected of ['git status; rm -rf /', 'git status && whoami', 'git status #x', 'git statusx']) {
    const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: injected, sudo: false });
    assert.notEqual(evaluate.evaluateOperation(request, [rule]).decision, 'allow', `不应放行：${injected}`);
  }
});

test('操作族互通：exec 规则同时约束 exec-async，upload 规则约束 upload-async', async () => {
  const { evaluate, authorize } = await policy();
  const execRule = { id: 'e', createdAt: 'x', ...authorize.scopeRule({ operation: 'exec', identity: IDENTITY, command: { value: 'rm -rf /data', sudo: false } }, 'deny') };
  const asyncRequest = authorize.execRequest({ operation: 'exec-async', identity: IDENTITY, command: 'rm -rf /data', sudo: false });
  assert.equal(evaluate.evaluateOperation(asyncRequest, [execRule]).decision, 'deny', '换 exec-async 不能绕过 exec 的禁止');

  const uploadRule = { id: 'u', createdAt: 'x', ...authorize.scopeRule({ operation: 'upload', identity: IDENTITY, path: { value: '/srv/x', subtree: false } }, 'allow') };
  const uploadAsync = authorize.fileRequest({ operation: 'upload-async', identity: IDENTITY, remotePath: '/srv/x' });
  assert.equal(evaluate.evaluateOperation(uploadAsync, [uploadRule]).decision, 'allow');
});

test('族之间不互通：read 的允许不得泄漏到 edit', async () => {
  const { evaluate, authorize } = await policy();
  const readRule = { id: 'r', createdAt: 'x', ...authorize.scopeRule({ operation: 'read', identity: IDENTITY, path: { value: '/srv/a.conf', subtree: false } }, 'allow') };
  const editRequest = authorize.fileRequest({ operation: 'edit', identity: IDENTITY, remotePath: '/srv/a.conf' });
  assert.equal(evaluate.evaluateOperation(editRequest, [readRule]).decision, 'ask');
});

test('deny 优先于 allow，且与规则顺序无关', async () => {
  const { evaluate, authorize } = await policy();
  const base = { operation: 'exec', identity: IDENTITY, command: { value: 'systemctl restart app', sudo: true } };
  const allow = { id: 'a', createdAt: 'x', ...authorize.scopeRule(base, 'allow') };
  const deny = { id: 'd', createdAt: 'x', ...authorize.scopeRule(base, 'deny') };
  const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'systemctl restart app', sudo: true });
  assert.equal(evaluate.evaluateOperation(request, [allow, deny]).decision, 'deny');
  assert.equal(evaluate.evaluateOperation(request, [deny, allow]).decision, 'deny');
});

test('身份是规则的一部分：换主机、换用户、多一跳都不命中', async () => {
  const { evaluate, authorize } = await policy();
  const rule = { id: 'r', createdAt: 'x', ...authorize.scopeRule({ operation: 'exec', identity: IDENTITY, command: { value: 'uptime', sudo: false } }, 'allow') };
  const variants = [
    { ...IDENTITY, host: OTHER_HOST.host },
    { ...IDENTITY, user: 'root' },
    { ...IDENTITY, port: 2222 },
    WITH_JUMP,
  ];
  for (const identity of variants) {
    const request = authorize.execRequest({ operation: 'exec', identity, command: 'uptime', sudo: false });
    assert.notEqual(evaluate.evaluateOperation(request, [rule]).decision, 'allow', `不应命中：${JSON.stringify(identity)}`);
  }
});

test('sudo 与 cwd 是独立条件，缺 cwd 时 fail closed', async () => {
  const { evaluate, authorize } = await policy();
  const scope = { operation: 'exec', identity: IDENTITY, command: { value: 'npm run build', cwd: '/srv/app', sudo: false } };
  const rule = { id: 'r', createdAt: 'x', ...authorize.scopeRule(scope, 'allow') };
  const withCwd = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'npm run build', sudo: false, cwd: '/srv/app' });
  assert.equal(evaluate.evaluateOperation(withCwd, [rule]).decision, 'allow');
  const withoutCwd = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'npm run build', sudo: false });
  assert.notEqual(evaluate.evaluateOperation(withoutCwd, [rule]).decision, 'allow', '缺 cwd 不得命中');
  const withSudo = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'npm run build', sudo: true, cwd: '/srv/app' });
  assert.notEqual(evaluate.evaluateOperation(withSudo, [rule]).decision, 'allow', 'sudo 是独立条件');
});

test('路径规则按路径段边界：/app 子树不匹配 /application，精确文件不匹配同前缀文件', async () => {
  const { evaluate, authorize } = await policy();
  const subtree = { id: 's', createdAt: 'x', ...authorize.scopeRule({ operation: 'upload', identity: IDENTITY, path: { value: '/app', subtree: true } }, 'allow') };
  const inside = authorize.fileRequest({ operation: 'upload', identity: IDENTITY, remotePath: '/app/x' });
  const sibling = authorize.fileRequest({ operation: 'upload', identity: IDENTITY, remotePath: '/application' });
  assert.equal(evaluate.evaluateOperation(inside, [subtree]).decision, 'allow');
  assert.notEqual(evaluate.evaluateOperation(sibling, [subtree]).decision, 'allow');

  const exact = { id: 'f', createdAt: 'x', ...authorize.scopeRule({ operation: 'edit', identity: IDENTITY, path: { value: '/srv/a.conf', subtree: false } }, 'allow') };
  assert.equal(evaluate.evaluateOperation(authorize.fileRequest({ operation: 'edit', identity: IDENTITY, remotePath: '/srv/a.conf' }), [exact]).decision, 'allow');
  assert.notEqual(evaluate.evaluateOperation(authorize.fileRequest({ operation: 'edit', identity: IDENTITY, remotePath: '/srv/a.conf.bak' }), [exact]).decision, 'allow');
});

test('内建硬禁止压过项目 allow 规则', async () => {
  const { evaluate, authorize } = await policy();
  const rule = { id: 'a', createdAt: 'x', ...authorize.scopeRule({ operation: 'exec', identity: IDENTITY, command: { value: 'iptables -F', sudo: true } }, 'allow') };
  const guard = { action: 'block', reason: 'iptables', message: 'blocked' };
  const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'iptables -F', sudo: true, guard });
  const result = evaluate.evaluateOperation(request, [rule]);
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /^builtin:/);
});

test('非法规则一律拒绝（不能变成「没有规则」），无匹配时回落 ask', async () => {
  const { evaluate, authorize } = await policy();
  const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'uptime', sudo: false });
  assert.equal(evaluate.evaluateOperation(request, []).decision, 'ask');
  assert.equal(evaluate.evaluateOperation(request, [{ id: 'bad' }]).reason, 'invalid_rule');
});

test('规则文件损坏 → RulesUnreadableError 且裁决结果必须是 deny', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-policy-'));
  const { rules, evaluate, authorize } = await policy();
  const projectId = 'proj-test';
  const request = authorize.execRequest({ operation: 'exec', identity: IDENTITY, command: 'uptime', sudo: false });
  assert.equal(evaluate.evaluateForProject(projectId, request, tmp).decision, 'ask');

  const file = rules.getProjectRulesPath(projectId, tmp);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{ this is not json');
  assert.throws(() => rules.loadProjectRules(projectId, tmp), rules.RulesUnreadableError);
  assert.equal(evaluate.evaluateForProject(projectId, request, tmp).decision, 'deny');
});

test('规则存储：增删查与项目隔离', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-policy-'));
  const { rules, authorize } = await policy();
  const newRule = authorize.scopeRule({ operation: 'exec', identity: IDENTITY, command: { value: 'uptime', sudo: false } }, 'allow');
  const added = rules.addRule('proj-a', newRule, tmp);
  rules.addRule('proj-b', newRule, tmp);
  assert.equal(rules.listRules('proj-a', tmp).length, 1);
  assert.equal(rules.listRules('proj-b', tmp).length, 1);
  assert.equal(rules.removeRule('proj-a', added.id, tmp), true);
  assert.equal(rules.listRules('proj-a', tmp).length, 0);
  assert.equal(rules.listRules('proj-b', tmp).length, 1, '删 A 不得影响 B');
});
