const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadTs } = require('./helpers/load-ts.cjs');

test('findExpiredSessions returns only non-running sessions older than TTL', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'octssh-cleanup-'));
  const sessions = await loadTs('state/sessions.ts');
  const cleanup = await loadTs('state/cleanup.ts');
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();
  const makeRecord = (session_id, status, updatedAt) => ({
    session_id, machine: 'm', createdAt: updatedAt, updatedAt, status,
    screenName: `octssh-${session_id}`, remoteDir: `.octssh/runs/${session_id}`,
    stdoutPath: `.octssh/runs/${session_id}/stdout.log`, stderrPath: `.octssh/runs/${session_id}/stderr.log`,
    metaPath: `.octssh/runs/${session_id}/meta.json`,
  });
  sessions.saveSession(makeRecord('old_done', 'done', old), tmp);
  sessions.saveSession(makeRecord('new_done', 'done', now), tmp);
  sessions.saveSession(makeRecord('old_running', 'running', old), tmp);

  const expired = cleanup.findExpiredSessions({ baseDir: tmp, retentionDays: 7, now: new Date() });
  assert.deepEqual(expired.map((record) => record.session_id), ['old_done']);
  cleanup.deleteSessionFile('old_done', tmp);
  assert.equal(cleanup.findExpiredSessions({ baseDir: tmp, retentionDays: 7, now: new Date() }).length, 0);
});
