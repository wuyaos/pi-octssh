const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, getEventListeners } = require('node:events');
const { loadTs } = require('./helpers/load-ts.cjs');

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  ended = false;
  closed = false;
  destroyed = false;
  end() { this.ended = true; }
  close() { this.closed = true; this.emit('close', 0); }
  destroy() { this.destroyed = true; }
}
function clientWith(exec) {
  const client = new EventEmitter();
  client.exec = exec;
  client.end = () => assert.fail('must not close shared connection');
  return client;
}

test('runCommand sends EOF and preserves bounded output and exit status', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const channel = new Channel();
  const client = clientWith((_command, callback) => callback(null, channel));
  const running = runCommand(client, 'cat', { maxStdoutBytes: 3 });
  assert.equal(channel.ended, true);
  channel.emit('data', Buffer.from('abcdef'));
  channel.stderr.emit('data', Buffer.from('warning'));
  channel.emit('close', 7, null);
  const result = await running;
  assert.equal(result.stdout, 'abc');
  assert.equal(result.stderr, 'warning');
  assert.equal(result.exitCode, 7);
  assert.equal(result.truncated.stdout, true);
  assert.equal(client.listenerCount('error'), 0);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(channel.listenerCount('data'), 0);
  channel.emit('error', new Error('late close error'));
});

test('abort beats synchronous channel close and only closes its own channel', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const channels = [new Channel(), new Channel()];
  let next = 0;
  const client = clientWith((_command, callback) => callback(null, channels[next++]));
  const controller = new AbortController();
  const a = runCommand(client, 'slow', { signal: controller.signal });
  const b = runCommand(client, 'other');
  channels[0].emit('data', Buffer.from('partial'));
  controller.abort();
  await assert.rejects(a, (error) => {
    assert.equal(error.name, 'AbortError');
    assert.equal(error.outcome, 'unknown');
    assert.equal(error.partial.stdout, 'partial');
    return true;
  });
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assert.equal(channels[0].closed, true);
  assert.equal(channels[0].destroyed, true);
  assert.equal(channels[1].closed, false);
  channels[1].emit('close', 0);
  assert.equal((await b).exitCode, 0);
});

test('timeout covers channel opening and closes a late channel', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  let open;
  const client = clientWith((_command, callback) => { open = callback; });
  await assert.rejects(runCommand(client, 'never opens', { timeoutMs: 20 }), { name: 'TimeoutError' });
  assert.equal(client.listenerCount('close'), 0);
  const late = new Channel();
  open(null, late);
  assert.equal(late.closed, true);
  assert.equal(late.destroyed, true);
  late.emit('error', new Error('late'));
});

test('running channel times out without waiting for a close acknowledgement', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const channel = new Channel();
  channel.close = () => { channel.closed = true; };
  const client = clientWith((_command, callback) => callback(null, channel));
  await assert.rejects(runCommand(client, 'sleep', { timeoutMs: 20 }), { name: 'TimeoutError' });
  assert.equal(channel.closed, true);
  assert.equal(channel.destroyed, true);
});

test('abort before dispatch never sends exec; synchronous exec failure removes listeners', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const controller = new AbortController();
  controller.abort();
  const client = clientWith(() => assert.fail('exec after abort'));
  await assert.rejects(runCommand(client, 'unused', { signal: controller.signal }), { name: 'AbortError' });
  client.exec = () => { throw new Error('channel limit'); };
  await assert.rejects(runCommand(client, 'unused'), /channel limit/);
  assert.equal(client.listenerCount('close'), 0);
  assert.equal(client.listenerCount('error'), 0);
});

test('connection loss settles a pending channel-open operation', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const client = clientWith(() => {});
  const running = runCommand(client, 'pending');
  client.emit('close');
  await assert.rejects(running, { name: 'ConnectionError', outcome: 'unknown' });
});

test('rejects disabled or overflowing execution deadlines', async () => {
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const client = clientWith(() => assert.fail('invalid deadline'));
  for (const timeoutMs of [0, -1, Infinity, NaN, 2147483648]) {
    await assert.rejects(runCommand(client, 'unused', { timeoutMs }), RangeError);
  }
});

// 真实 ssh2 channel 路径；仅绑定回环随机端口，不执行本机 shell、不连接真实主机。
test('ssh2 loopback: EOF completes command and timeout keeps shared transport usable', { timeout: 10_000 }, async (t) => {
  const { generateKeyPairSync } = require('node:crypto');
  const { Server, Client } = require('ssh2');
  const { runCommand } = await loadTs('ssh/runCommand.ts');
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const peers = new Set();
  const server = new Server({ hostKeys: [key] }, (peer) => {
    peers.add(peer);
    peer.on('error', () => {});
    peer.on('close', () => peers.delete(peer));
    peer.on('authentication', (ctx) => ctx.accept());
    peer.on('ready', () => peer.on('session', (accept) => {
      const session = accept();
      session.on('exec', (acceptExec, _reject, info) => {
        const channel = acceptExec();
        channel.on('error', () => {});
        if (info.command === 'hang') return;
        channel.on('end', () => {
          channel.write('EOF received');
          channel.exit(0);
          channel.end();
        });
        channel.resume();
      });
    }));
  });
  const client = new Client();
  client.on('error', () => {});
  t.after(async () => {
    client.destroy();
    for (const peer of peers) peer.end();
    await new Promise((resolve) => server.close(resolve));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  await new Promise((resolve, reject) => {
    client.once('ready', resolve);
    client.once('error', reject);
    client.connect({ host: '127.0.0.1', port: server.address().port, username: 'test', readyTimeout: 2000 });
  });
  const first = await runCommand(client, 'eof', { timeoutMs: 2000 });
  assert.equal(first.stdout, 'EOF received');
  assert.equal(first.exitCode, 0);
  await assert.rejects(runCommand(client, 'hang', { timeoutMs: 50 }), { name: 'TimeoutError' });
  const second = await runCommand(client, 'eof', { timeoutMs: 2000 });
  assert.equal(second.exitCode, 0);
  assert.equal(second.stdout, 'EOF received');
});
