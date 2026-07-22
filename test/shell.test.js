const test = require('node:test');
const assert = require('node:assert/strict');

test('wrapSh and wrapSudoSh single-quote escaping', () => {
  const mod = require('../dist/ssh/shell.js');

  const cmd = "echo 'hi'";
  const sh = mod.wrapSh(cmd);
  const sudo = mod.wrapSudoSh(cmd);

  assert.ok(sh.startsWith('sh -lc '));
  assert.ok(sudo.startsWith('sudo -n -- sh -lc '));
  // Ensure the inner single quote was escaped.
  assert.ok(sh.includes("'\\''"));
});

test('isSudoPasswordError detects common messages', () => {
  const mod = require('../dist/ssh/shell.js');
  assert.equal(mod.isSudoPasswordError('sudo: a password is required'), true);
  assert.equal(mod.isSudoPasswordError('something else'), false);
});
