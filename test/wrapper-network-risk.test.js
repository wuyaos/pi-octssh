const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const security = { denyRegex: [], denyExecutables: [], requireConfirmRegex: [] };

// 所有命令仅作为分类函数输入；不执行 shell，不发网络请求。
test('execution wrappers require confirmation and never gain subcommand scope', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  const { subcommandScope } = await loadTs('security/commandShape.ts');
  for (const command of ["bash -c 'chmod -R 777 ~'", "sh -c 'pkill -9 x'", 'nohup truncate -s 0 file', 'env reboot', 'xargs chmod', 'nice reboot', 'timeout 3 reboot', 'stdbuf -oL reboot', 'command reboot', '/bin/bash script.sh']) {
    assert.equal((await guardExecCommand({ command, client: {}, security, machine: 'fixture', allowSudo: false })).action, 'needs_confirmation', command);
    assert.equal(subcommandScope(command), undefined, command);
  }
});

test('curl write/upload/config/modified requests and default wget require confirmation', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const args of ['-fsSLo /tmp/file https://example.test', '-o/tmp/file https://example.test', '-O https://example.test/file', '--output=/tmp/file https://example.test', '-Dheaders https://example.test', '--cookie-jar=cookies https://example.test', '-Tfile https://example.test', '-ddata https://example.test', '-XPOST https://example.test', '--request=DELETE https://example.test', '-Kconfig', '--config=config', '--next https://example.test', '-sXDELETE https://example.test', '--trace=trace https://example.test', '--url=file:///tmp/local', '--unknown https://example.test']) {
    const command = `curl ${args}`;
    assert.equal((await guardExecCommand({ command, client: {}, security, machine: 'fixture', allowSudo: false })).action, 'needs_confirmation', command);
  }
  for (const command of ['wget https://example.test', 'wget -O /tmp/file https://example.test', 'wget --post-data=data https://example.test']) {
    assert.equal((await guardExecCommand({ command, client: {}, security, machine: 'fixture', allowSudo: false })).action, 'needs_confirmation', command);
  }
});

test('ordinary curl queries remain allowed, explicit confirmation configuration still wins', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const command of ['curl -fsSL https://example.test', 'curl -I https://example.test', 'curl -sXGET https://example.test', 'curl --request HEAD --url=https://example.test', 'curl --max-time 5 https://example.test', 'curl -H "Accept: application/json" https://example.test', 'wget --version']) {
    assert.equal((await guardExecCommand({ command, client: {}, security, machine: 'fixture', allowSudo: false })).action, 'allow', command);
  }
  assert.equal((await guardExecCommand({ command: 'curl https://example.test', client: {}, security: { ...security, requireConfirmRegex: ['curl'] }, machine: 'fixture', allowSudo: false })).action, 'needs_confirmation');
});
