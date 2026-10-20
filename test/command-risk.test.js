const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');
const security = { denyRegex: [], denyExecutables: [], requireConfirmRegex: [] };
const identity = { alias: 'fixture', host: 'localhost', port: 22, user: 'fixture' };

test('query commands including firewall queries pass without remote preview', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const command of ['docker ps', 'docker logs app', 'docker compose ps', 'systemctl status app', 'uname -a', 'ufw status verbose', 'iptables -L -n', 'nft list ruleset', 'firewall-cmd --list-all']) {
    assert.equal((await guardExecCommand({ command, security, client: {}, machine: 'fixture', allowSudo: false })).action, 'allow', command);
  }
});

test('dangerous subcommands and non-rm configured patterns ask instead of failing preview', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const command of ['docker restart app', 'docker system prune -a', 'docker compose down', 'systemctl stop app', 'chmod 777 file', 'rm file', 'shutdown now', 'custom-command']) {
    const result = await guardExecCommand({ command, security: { ...security, requireConfirmRegex: ['custom-command'] }, client: {}, machine: 'fixture', allowSudo: false });
    assert.equal(result.action, 'needs_confirmation', command);
  }
});

test('hard blocks precede authorization and explicit deny still overrides firewall query', async () => {
  const { guardExecCommand } = await loadTs('security/policy.ts');
  for (const command of ['rm -rf /', 'rm -rf /*', 'ufw disable', 'iptables -F', 'nft flush ruleset', 'systemctl stop firewalld', 'mkfs.ext4 /dev/sda']) {
    assert.equal((await guardExecCommand({ command, security, client: {}, machine: 'fixture', allowSudo: false, authorized: true })).action, 'block', command);
  }
  assert.equal((await guardExecCommand({ command: 'ufw status', security: { ...security, denyExecutables: ['ufw'] }, client: {}, machine: 'fixture', allowSudo: false })).action, 'block');
});

test('subcommand authorization matches args but not shell syntax, changed action, target or sudo', async () => {
  const { subcommandScope } = await loadTs('security/commandShape.ts');
  const { scopeRule } = await loadTs('security/authorize.ts');
  const { evaluateOperation } = await loadTs('security/evaluate.ts');
  assert.equal(subcommandScope('docker compose restart app'), 'docker compose restart');
  assert.equal(subcommandScope('docker compose'), undefined);
  const rule = { ...scopeRule({ operation: 'exec', identity, command: { value: 'docker restart', match: 'subcommand', sudo: false } }, 'allow'), id: 'fixture', createdAt: new Date().toISOString() };
  const evaluate = (value, sudo = false) => evaluateOperation({ operation: 'exec', identity, command: { value, sudo } }, [rule]);
  assert.equal(evaluate('docker restart other --time 20').decision, 'allow');
  for (const command of ['docker stop app', 'docker restart app; rm -rf /', 'docker restart $(id)', 'docker restart app > out', 'docker --context prod restart app', 'docker restart app\nwhoami', 'docker restart app && true', 'docker restart "unterminated']) {
    assert.notEqual(evaluate(command).decision, 'allow', command);
  }
  assert.notEqual(evaluate('docker restart app', true).decision, 'allow');
  assert.equal(evaluateOperation({ operation: 'exec', identity, command: { value: 'docker restart app' } }, [rule, { ...rule, id: 'deny', effect: 'deny' }]).decision, 'deny');
});
