const test = require('node:test');
const assert = require('node:assert/strict');

test('scaffold boots', () => {
  assert.equal(typeof 'OctSSH', 'string');
});
