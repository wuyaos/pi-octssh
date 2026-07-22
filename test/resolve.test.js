const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('resolveHostConfig applies ssh_config blocks in file order (first value wins)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-resolve-'));
  const configPath = path.join(tmp, 'config');

  fs.writeFileSync(
    configPath,
    [
      'Host foo',
      '  HostName foo.example.com',
      '  User alice',
      '  Port 2222',
      '  IdentityFile ~/.ssh/id_ed25519',
      '',
      // Defaults at the bottom should only apply if not already set.
      'Host *',
      '  User defaultUser',
      '  Port 22',
      ''
    ].join('\n'),
    'utf8'
  );

  const mod = require('../dist/ssh/config/resolve.js');
  const cfg = mod.resolveHostConfig('foo', { configPath, allowSshG: false });
  assert.equal(cfg.hostName, 'foo.example.com');
  assert.equal(cfg.user, 'alice');
  assert.equal(cfg.port, 2222);
  assert.deepEqual(cfg.identityFiles, ['~/.ssh/id_ed25519']);
});

test('resolveHostConfig supports Include and ProxyCommand warning', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-resolve-'));
  const confDir = path.join(tmp, 'conf.d');
  fs.mkdirSync(confDir, { recursive: true });

  const configPath = path.join(tmp, 'config');
  const inc = path.join(confDir, 'x.conf');

  fs.writeFileSync(
    inc,
    [
      'Host bar',
      '  HostName bar.internal',
      '  ProxyCommand ssh -W %h:%p jump',
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    configPath,
    ['Include conf.d/*.conf', ''].join('\n'),
    'utf8'
  );

  const mod = require('../dist/ssh/config/resolve.js');
  const cfg = mod.resolveHostConfig('bar', { configPath, allowSshG: false });
  assert.equal(cfg.hostName, 'bar.internal');
  assert.ok(cfg.warnings.some((w) => w.toLowerCase().includes('proxycommand')));
});

test('resolveHostConfig matches patterns with negation', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-resolve-'));
  const configPath = path.join(tmp, 'config');

  fs.writeFileSync(
    configPath,
    [
      'Host *.prod !bad.prod',
      '  User prodUser',
      ''
    ].join('\n'),
    'utf8'
  );

  const mod = require('../dist/ssh/config/resolve.js');
  const ok = mod.resolveHostConfig('good.prod', { configPath, allowSshG: false });
  const bad = mod.resolveHostConfig('bad.prod', { configPath, allowSshG: false });
  assert.equal(ok.user, 'prodUser');
  assert.equal(bad.user, undefined);
});
