const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

test('parseProxyJump parses user@host:port and takes first hop', async () => {
  const { parseProxyJump } = await loadTs('ssh/machine.ts');
  assert.deepEqual(parseProxyJump('user@jump:2222'), { host: 'jump', user: 'user', port: 2222 });
  assert.deepEqual(parseProxyJump('jump,other'), { host: 'jump', user: undefined, port: undefined });
});
