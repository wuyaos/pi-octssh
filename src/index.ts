#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createOctsshServer } from "./mcp/server.js";
import { createOctsshLocalServer } from "./mcp/localServer.js";
import { runInitCli } from "./init/initCli.js";
import { loadConfig } from "./state/config.js";
import { getOctsshDir } from "./state/paths.js";
import { runStreamableHttpServer } from "./mcp/httpServe.js";

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "init") {
    await runInitCli();
    return;
  }

  if (args[0] === "serve") {
    const cfg = loadConfig(getOctsshDir());
    const envHost = process.env.OCTSSH_SERVE_HOST;
    const envPort = process.env.OCTSSH_SERVE_PORT;
    const envKey = process.env.OCTSSH_SERVE_KEY;

    const host = envHost?.trim() || cfg.httpServer.host;
    const port = envPort ? Number(envPort) : cfg.httpServer.port;
    const authKey = envKey?.trim() || cfg.httpServer.authKey;

    if (!Number.isFinite(port) || port <= 0) {
      throw new Error(`Invalid OCTSSH_SERVE_PORT: ${String(envPort)}`);
    }

    // `serve` is intended to be installed on the target machine and expose
    // tools that operate on *this* machine (no outbound SSH connections).
    const { url, authKey: effectiveKey, close } = await runStreamableHttpServer({
      createServer: createOctsshLocalServer,
      config: {
        host,
        port,
        authKey,
      },
    });

    process.stdout.write(
      [
        `OctSSH Streamable HTTP MCP server started`,
        `URL: ${url}`,
        `Auth: send header X-OctSSH-Key: ${effectiveKey}`,
        `Tip: set OCTSSH_SERVE_KEY to use a fixed key.`,
        "",
      ].join("\n")
    );

    const shutdown = async () => {
      try {
        await close();
      } catch {
        // ignore
      }
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // Keep process running.
    await new Promise<void>(() => undefined);
  }

  const server = createOctsshServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // MCP hosts typically surface stderr; keep it readable.
  process.stderr.write(`OctSSH failed to start: ${String(err?.stack ?? err)}\n`);
  process.exitCode = 1;
});
