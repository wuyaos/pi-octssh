const test = require('node:test');
const assert = require('node:assert/strict');

const { Client } = require('@modelcontextprotocol/sdk/client');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

test('Streamable HTTP serve requires auth header', async () => {
  const { createOctsshLocalServer } = require('../dist/mcp/localServer.js');
  const { runStreamableHttpServer } = require('../dist/mcp/httpServe.js');
  const started = await runStreamableHttpServer({
    createServer: createOctsshLocalServer,
    config: { host: '127.0.0.1', port: 0, authKey: 'test-key' }
  });

  try {
    // Missing auth should fail.
    {
      const transport = new StreamableHTTPClientTransport(new URL(started.url));
      const client = new Client({ name: 'octssh-http-test', version: '0.0.0' }, { capabilities: {} });
      let threw = false;
      try {
        await client.connect(transport);
      } catch (e) {
        threw = true;
      } finally {
        try { await transport.close(); } catch {}
      }
      assert.equal(threw, true);
    }

    // Correct auth header should succeed.
    {
      const transport = new StreamableHTTPClientTransport(new URL(started.url), {
        requestInit: {
          headers: {
            'x-octssh-key': 'test-key'
          }
        }
      });
      const client = new Client({ name: 'octssh-http-test', version: '0.0.0' }, { capabilities: {} });

      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(Array.isArray(tools.tools));
      assert.ok(tools.tools.find((t) => t.name === 'list'));

      // Local HTTP serve mode should not expose SSH-based transfer tools.
      assert.equal(!!tools.tools.find((t) => t.name === 'upload'), false);
      assert.equal(!!tools.tools.find((t) => t.name === 'download'), false);

      // Local serve mode executes on the server machine.
      const execRes = await client.callTool({
        name: 'exec',
        arguments: { command: 'echo hello-octssh' }
      });
      const parsed =
        execRes.structuredContent ||
        (execRes.content && execRes.content[0] && execRes.content[0].type === 'text'
          ? JSON.parse(execRes.content[0].text)
          : null);
      assert.ok(parsed);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.tool, 'exec');
      assert.ok(String(parsed.data.stdout).includes('hello-octssh'));

      await transport.close();
    }
  } finally {
    await started.close();
  }
});

test('Streamable HTTP serve supports multiple sessions', async () => {
  const { createOctsshLocalServer } = require('../dist/mcp/localServer.js');
  const { runStreamableHttpServer } = require('../dist/mcp/httpServe.js');

  const started = await runStreamableHttpServer({
    createServer: createOctsshLocalServer,
    config: { host: '127.0.0.1', port: 0, authKey: 'test-key' }
  });

  async function connectAndClose() {
    const transport = new StreamableHTTPClientTransport(new URL(started.url), {
      requestInit: {
        headers: {
          'x-octssh-key': 'test-key'
        }
      }
    });
    const client = new Client({ name: 'octssh-http-test', version: '0.0.0' }, { capabilities: {} });
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      assert.ok(Array.isArray(tools.tools));
      assert.ok(tools.tools.find((t) => t.name === 'list'));
    } finally {
      try { await transport.close(); } catch {}
    }
  }

  try {
    await connectAndClose();
    await connectAndClose();
  } finally {
    await started.close();
  }
});

test('Streamable HTTP serve supports write-stdin for async sessions', async () => {
  const { createOctsshLocalServer } = require('../dist/mcp/localServer.js');
  const { runStreamableHttpServer } = require('../dist/mcp/httpServe.js');

  const started = await runStreamableHttpServer({
    createServer: createOctsshLocalServer,
    config: { host: '127.0.0.1', port: 0, authKey: 'test-key' }
  });

  const transport = new StreamableHTTPClientTransport(new URL(started.url), {
    requestInit: {
      headers: {
        'x-octssh-key': 'test-key'
      }
    }
  });
  const client = new Client({ name: 'octssh-http-test', version: '0.0.0' }, { capabilities: {} });

  const parse = (res) =>
    res.structuredContent ||
    (res.content && res.content[0] && res.content[0].type === 'text'
      ? JSON.parse(res.content[0].text)
      : null);

  try {
    await client.connect(transport);

    const execAsyncRes = await client.callTool({
      name: 'exec-async',
      arguments: {
        command: 'read -r line; echo got:$line; sleep 0.05'
      }
    });
    const execAsyncParsed = parse(execAsyncRes);
    assert.ok(execAsyncParsed);
    assert.equal(execAsyncParsed.ok, true);
    assert.equal(execAsyncParsed.tool, 'exec-async');
    assert.ok(execAsyncParsed.data);
    assert.ok(execAsyncParsed.data.session_id);

    const sid = execAsyncParsed.data.session_id;
    const writeRes = await client.callTool({
      name: 'write-stdin',
      arguments: { session_id: sid, data: 'hello-stdin', append_newline: true }
    });
    const writeParsed = parse(writeRes);
    assert.ok(writeParsed);
    assert.equal(writeParsed.ok, true);
    assert.equal(writeParsed.tool, 'write-stdin');

    let last = null;
    for (let i = 0; i < 30; i++) {
      const r = await client.callTool({
        name: 'get-result',
        arguments: { session_id: sid, lines: 50 }
      });
      last = parse(r);
      if (last && last.ok && last.data && last.data.status !== 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    assert.ok(last);
    assert.equal(last.ok, true);
    assert.ok(last.data);
    assert.ok(last.data.tails);
    assert.ok(String(last.data.tails.stdout).includes('got:hello-stdin'));
  } finally {
    try { await transport.close(); } catch {}
    await started.close();
  }
});
