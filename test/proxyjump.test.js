const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { loadTs } = require('./helpers/load-ts.cjs');

test('connectViaProxyJump forwards to target and passes sock to connector', async () => {
  const { connectViaProxyJump } = await loadTs('ssh/proxyJump.ts');
  let called = 0;
  const stream = new PassThrough();
  const jumpClient = {
    forwardOut(srcIP, srcPort, dstIP, dstPort, callback) {
      called += 1;
      assert.equal(srcIP, '127.0.0.1');
      assert.equal(srcPort, 0);
      assert.equal(dstIP, 'target');
      assert.equal(dstPort, 22);
      callback(null, stream);
    },
  };
  const result = await connectViaProxyJump({
    jumpClient,
    targetHost: 'target',
    targetPort: 22,
    connectTarget: async (sock) => {
      assert.equal(sock, stream);
      return { ok: true };
    },
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(called, 1);
});

test('openDirectTcpip adds a forwarding-disabled hint', async () => {
  const { openDirectTcpip } = await loadTs('ssh/proxyJump.ts');
  await assert.rejects(
    () => openDirectTcpip({ forwardOut: async () => { throw new Error('administratively prohibited'); }, dstHost: 'target', dstPort: 22 }),
    /AllowTcpForwarding=no/,
  );
});
