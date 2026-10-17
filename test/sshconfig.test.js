const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

test('discoverHostAliases lists only concrete aliases and follows Include', async () => {
  const { discoverHostAliases } = await loadTs('ssh/config/hosts.ts');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-sshconfig-'));
  const confDir = path.join(tmp, 'conf.d');
  fs.mkdirSync(confDir, { recursive: true });
  const mainConfig = path.join(tmp, 'config');
  fs.writeFileSync(mainConfig, ['Host good1 good2 *.prod !negated', '  HostName example.com', 'Include conf.d/*.conf', ''].join('\n'));
  fs.writeFileSync(path.join(confDir, 'a.conf'), 'Host incAlias\n  User root\n');
  fs.writeFileSync(path.join(confDir, 'b.conf'), 'Host *\n  Port 2222\n');
  assert.deepEqual(discoverHostAliases({ configPath: mainConfig }), ['good1', 'good2', 'incAlias']);
});
