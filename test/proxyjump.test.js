const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');

test('connectViaProxyJump forwards to target and passes sock to connector', async () => {
  const mod = require('../dist/ssh/proxyJump.js');

  let called = 0;
  const stream = new PassThrough();
  const jumpClient = {
    forwardOut: (srcIP, srcPort, dstIP, dstPort, cb) => {
      called += 1;
      assert.equal(srcIP, '127.0.0.1');
      assert.equal(dstIP, 'target');
      assert.equal(dstPort, 22);
      cb(null, stream);
    }
  };

  const result = await mod.connectViaProxyJump({
    jumpClient,
    targetHost: 'target',
    targetPort: 22,
    connectTarget: async (sock) => {
      assert.equal(sock, stream);
      return { ok: true };
    }
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(called, 1);
});
