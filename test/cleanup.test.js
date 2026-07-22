const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('findExpiredSessions returns only non-running sessions older than TTL', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-cleanup-'));
  const sessions = require('../dist/state/sessions.js');
  const cleanup = require('../dist/state/cleanup.js');

  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  sessions.saveSession(
    {
      session_id: 'old_done',
      machine: 'm',
      createdAt: old,
      updatedAt: old,
      status: 'done',
      screenName: 'octssh-old_done',
      remoteDir: '.octssh/runs/old_done',
      stdoutPath: '.octssh/runs/old_done/stdout.log',
      stderrPath: '.octssh/runs/old_done/stderr.log',
      metaPath: '.octssh/runs/old_done/meta.json'
    },
    tmp
  );
  sessions.saveSession(
    {
      session_id: 'new_done',
      machine: 'm',
      createdAt: now,
      updatedAt: now,
      status: 'done',
      screenName: 'octssh-new_done',
      remoteDir: '.octssh/runs/new_done',
      stdoutPath: '.octssh/runs/new_done/stdout.log',
      stderrPath: '.octssh/runs/new_done/stderr.log',
      metaPath: '.octssh/runs/new_done/meta.json'
    },
    tmp
  );
  sessions.saveSession(
    {
      session_id: 'old_running',
      machine: 'm',
      createdAt: old,
      updatedAt: old,
      status: 'running',
      screenName: 'octssh-old_running',
      remoteDir: '.octssh/runs/old_running',
      stdoutPath: '.octssh/runs/old_running/stdout.log',
      stderrPath: '.octssh/runs/old_running/stderr.log',
      metaPath: '.octssh/runs/old_running/meta.json'
    },
    tmp
  );

  const expired = cleanup.findExpiredSessions({ baseDir: tmp, retentionDays: 7, now: new Date() });
  assert.equal(expired.length, 1);
  assert.equal(expired[0].session_id, 'old_done');

  cleanup.deleteSessionFile('old_done', tmp);
  const expired2 = cleanup.findExpiredSessions({ baseDir: tmp, retentionDays: 7, now: new Date() });
  assert.equal(expired2.length, 0);
});
