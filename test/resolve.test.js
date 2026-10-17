const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

function writeConfig(lines) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-resolve-'));
  const configPath = path.join(tmp, 'config');
  fs.writeFileSync(configPath, lines.join('\n'), 'utf8');
  return { tmp, configPath };
}

test('resolveHostConfig applies ssh_config blocks in file order (first value wins)', async () => {
  const { resolveHostConfig } = await loadTs('ssh/config/resolve.ts');
  const { configPath } = writeConfig([
    'Host foo',
    '  HostName foo.example.com',
    '  User alice',
    '  Port 2222',
    '  IdentityFile ~/.ssh/id_ed25519',
    '',
    'Host *',
    '  User defaultUser',
    '  Port 22',
    '',
  ]);
  const cfg = resolveHostConfig('foo', { configPath, allowSshG: false });
  assert.equal(cfg.hostName, 'foo.example.com');
  assert.equal(cfg.user, 'alice');
  assert.equal(cfg.port, 2222);
  assert.deepEqual(cfg.identityFiles, ['~/.ssh/id_ed25519']);
});

test('resolveHostConfig supports Include and ProxyCommand warning', async () => {
  const { resolveHostConfig } = await loadTs('ssh/config/resolve.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-resolve-'));
  const confDir = path.join(tmp, 'conf.d');
  fs.mkdirSync(confDir, { recursive: true });
  const configPath = path.join(tmp, 'config');
  fs.writeFileSync(path.join(confDir, 'x.conf'), 'Host bar\n  HostName bar.internal\n  ProxyCommand ssh -W %h:%p jump\n', 'utf8');
  fs.writeFileSync(configPath, 'Include conf.d/*.conf\n', 'utf8');
  const cfg = resolveHostConfig('bar', { configPath, allowSshG: false });
  assert.equal(cfg.hostName, 'bar.internal');
  assert.ok(cfg.warnings.some((warning) => warning.toLowerCase().includes('proxycommand')));
});

test('resolveHostConfig parses ServerAlive settings', async () => {
  const { resolveHostConfig } = await loadTs('ssh/config/resolve.ts');
  const { configPath } = writeConfig(['Host keepalive', '  ServerAliveInterval 15', '  ServerAliveCountMax 4']);
  const cfg = resolveHostConfig('keepalive', { configPath, allowSshG: false });
  assert.equal(cfg.serverAliveInterval, 15);
  assert.equal(cfg.serverAliveCountMax, 4);
});

test('resolveHostConfig matches patterns with negation', async () => {
  const { resolveHostConfig } = await loadTs('ssh/config/resolve.ts');
  const { configPath } = writeConfig(['Host *.prod !bad.prod', '  User prodUser']);
  assert.equal(resolveHostConfig('good.prod', { configPath, allowSshG: false }).user, 'prodUser');
  assert.equal(resolveHostConfig('bad.prod', { configPath, allowSshG: false }).user, undefined);
});
