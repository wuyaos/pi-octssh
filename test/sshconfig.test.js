const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('discoverHostAliases lists only concrete aliases and follows Include', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-sshconfig-'));
  const confDir = path.join(tmp, 'conf.d');
  fs.mkdirSync(confDir, { recursive: true });

  const mainConfig = path.join(tmp, 'config');
  const inc1 = path.join(confDir, 'a.conf');
  const inc2 = path.join(confDir, 'b.conf');

  fs.writeFileSync(
    mainConfig,
    [
      '# main',
      'Host good1 good2 *.prod !negated',
      '  HostName example.com',
      `Include conf.d/*.conf`,
      ''
    ].join('\n'),
    'utf8'
  );

  fs.writeFileSync(
    inc1,
    ['Host incAlias', '  User root', ''].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    inc2,
    ['Host *', '  Port 2222', ''].join('\n'),
    'utf8'
  );

  const hosts = require('../dist/ssh/config/hosts.js');
  const got = hosts.discoverHostAliases({ configPath: mainConfig });
  assert.deepEqual(got, ['good1', 'good2', 'incAlias']);
});
