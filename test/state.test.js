const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

test('config defaults and save/load', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-test-'));
  const cfg = await loadTs('state/config.ts');
  const defaults = cfg.loadConfig(tmp);
  assert.equal(defaults.retentionDays, 7);
  assert.equal(defaults.maxConnections, 10);
  cfg.saveConfig({ ...defaults, retentionDays: 3 }, tmp);
  assert.equal(cfg.loadConfig(tmp).retentionDays, 3);
});

test('session record persists', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-test-'));
  const sessions = await loadTs('state/sessions.ts');
  const now = new Date().toISOString();
  const record = {
    session_id: 'ses_test_1', machine: 'demo', createdAt: now, updatedAt: now, status: 'running',
    screenName: 'octssh-ses_test_1', remoteDir: '~/.octssh/runs/ses_test_1',
    stdoutPath: '~/.octssh/runs/ses_test_1/stdout.log', stderrPath: '~/.octssh/runs/ses_test_1/stderr.log',
    metaPath: '~/.octssh/runs/ses_test_1/meta.json',
  };
  sessions.saveSession(record, tmp);
  const loaded = sessions.loadSession('ses_test_1', tmp);
  assert.equal(loaded.session_id, 'ses_test_1');
  assert.equal(loaded.status, 'running');
});
