const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

test('octssh command completion lists subcommands and nested choices', async () => {
  const { completeOctsshArguments } = await loadTs('tui/commandCompletion.ts');
  const values = (prefix) => (completeOctsshArguments(prefix) ?? []).map((item) => item.value);
  assert.deepEqual(values(''), ['allow-all', 'trust', 'permissions', 'tasks', 'credentials']);
  assert.deepEqual(values('cr'), ['credentials']);
  assert.deepEqual(values('credentials '), ['credentials clear']);
  assert.deepEqual(values('tasks '), ['tasks wake']);
  assert.deepEqual(values('tasks wake '), ['tasks wake on', 'tasks wake off']);
  assert.deepEqual(values('allow-all example-host '), ['allow-all example-host on', 'allow-all example-host off']);
  assert.deepEqual(values('trust '), ['trust forget']);
  assert.deepEqual(values('permissions '), ['permissions remove']);
  assert.deepEqual(values('unknown '), []);
  assert.deepEqual(values('credentials clear '), []);
});


test('host completion uses local SSH config and Pi replaces the full argument prefix', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-completion-'));
  const previous = process.env.OCTSSH_SSH_CONFIG;
  try {
    const config = path.join(dir, 'config');
    fs.writeFileSync(config, 'Host example-host other-host\n HostName localhost\nHost *\n');
    process.env.OCTSSH_SSH_CONFIG = config;
    const { completeOctsshArguments } = await loadTs('tui/commandCompletion.ts');
    assert.deepEqual(completeOctsshArguments('allow-all ex').map((x) => x.value), ['allow-all example-host']);
    assert.deepEqual(completeOctsshArguments('tasks wake of').map((x) => x.value), ['tasks wake off']);
  } finally {
    if (previous === undefined) delete process.env.OCTSSH_SSH_CONFIG;
    else process.env.OCTSSH_SSH_CONFIG = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
