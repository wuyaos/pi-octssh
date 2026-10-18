const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

/**
 * ssh-agent 地址解析。
 *
 * 这里的回归点很隐蔽：把 `SSH_AGENT_PID`（一个数字）当成 agent 地址交给 ssh2，
 * 在没设该变量的机器上完全看不出来；一旦设了（启动了 OpenSSH agent 服务、
 * 或某些安装脚本导出它），agent 认证就会失败，甚至把本来好用的密钥登录弄坏。
 */

test('Windows 只用 OpenSSH agent 的命名管道，且必须真实存在', async () => {
  const { resolveAgentAddress, WINDOWS_OPENSSH_AGENT_PIPE } = await loadTs('ssh/machine.ts');
  assert.equal(resolveAgentAddress({ platform: 'win32', exists: () => true }), WINDOWS_OPENSSH_AGENT_PIPE);
  assert.equal(resolveAgentAddress({ platform: 'win32', exists: () => false }), undefined);
});

test('Windows 上绝不把 SSH_AGENT_PID / MSYS 的 SSH_AUTH_SOCK 当地址', async () => {
  const { resolveAgentAddress } = await loadTs('ssh/machine.ts');
  assert.equal(
    resolveAgentAddress({ platform: 'win32', env: { SSH_AGENT_PID: '12345' }, exists: () => false }),
    undefined,
  );
  assert.equal(
    resolveAgentAddress({ platform: 'win32', env: { SSH_AUTH_SOCK: '/tmp/ssh-abc/agent.123' }, exists: () => false }),
    undefined,
    'Git Bash 的虚拟路径 Node 连不上，不能传下去',
  );
});

test('非 Windows 用 SSH_AUTH_SOCK，缺省时无 agent', async () => {
  const { resolveAgentAddress } = await loadTs('ssh/machine.ts');
  assert.equal(resolveAgentAddress({ platform: 'linux', env: { SSH_AUTH_SOCK: '/run/agent.sock' } }), '/run/agent.sock');
  assert.equal(resolveAgentAddress({ platform: 'darwin', env: {} }), undefined);
  assert.equal(resolveAgentAddress({ platform: 'darwin', env: { SSH_AGENT_PID: '999' } }), undefined);
});
