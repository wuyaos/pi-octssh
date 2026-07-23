const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

test('wrapSh and wrapSudoSh single-quote escaping', async () => {
  const { wrapSh, wrapSudoSh } = await loadTs('ssh/shell.ts');
  const command = "echo 'hi'";
  const sh = wrapSh(command);
  const sudo = wrapSudoSh(command);
  assert.ok(sh.startsWith('sh -lc '));
  assert.ok(sudo.startsWith('sudo -n -- sh -lc '));
  assert.ok(sh.includes("'\\''"));
});

test('isSudoPasswordError detects common messages', async () => {
  const { isSudoPasswordError } = await loadTs('ssh/shell.ts');
  assert.equal(isSudoPasswordError('sudo: a password is required'), true);
  assert.equal(isSudoPasswordError('something else'), false);
});
