const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('config defaults and save/load', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-test-'));
  const cfg = require('../dist/state/config.js');

  const d = cfg.loadConfig(tmp);
  assert.equal(d.retentionDays, 7);
  assert.equal(d.maxConnections, 10);

  cfg.saveConfig({ ...d, retentionDays: 3 }, tmp);
  const reread = cfg.loadConfig(tmp);
  assert.equal(reread.retentionDays, 3);
});

test('session record persists', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-test-'));
  const sessions = require('../dist/state/sessions.js');

  const now = new Date().toISOString();
  const rec = {
    session_id: 'ses_test_1',
    machine: 'demo',
    createdAt: now,
    updatedAt: now,
    status: 'running',
    screenName: 'octssh-ses_test_1',
    remoteDir: '~/.octssh/runs/ses_test_1',
    stdoutPath: '~/.octssh/runs/ses_test_1/stdout.log',
    stderrPath: '~/.octssh/runs/ses_test_1/stderr.log',
    metaPath: '~/.octssh/runs/ses_test_1/meta.json'
  };

  sessions.saveSession(rec, tmp);
  const loaded = sessions.loadSession('ses_test_1', tmp);
  assert.equal(loaded.session_id, 'ses_test_1');
  assert.equal(loaded.status, 'running');
});
