const test = require('node:test');
const assert = require('node:assert/strict');

test('parseProxyJump parses user@host:port and takes first hop', () => {
  const mod = require('../dist/ssh/machine.js');
  assert.deepEqual(mod.parseProxyJump('user@jump:2222'), {
    host: 'jump',
    user: 'user',
    port: 2222
  });

  assert.deepEqual(mod.parseProxyJump('jump,other'), {
    host: 'jump',
    user: undefined,
    port: undefined
  });
});
