import http from "node:http";
import crypto from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

type EventStore = {
  storeEvent: (streamId: string, message: any) => Promise<string>;
  replayEventsAfter: (
    lastEventId: string,
    opts: { send: (eventId: string, message: any) => Promise<void> }
  ) => Promise<string>;
};

// Copy of the SDK example InMemoryEventStore, kept tiny and dependency-free.
class InMemoryEventStore implements EventStore {
  private readonly events = new Map<string, { streamId: string; message: any }>();

  private generateEventId(streamId: string) {
    return `${streamId}_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }

  private getStreamIdFromEventId(eventId: string) {
    const parts = eventId.split("_");
    return parts.length > 0 ? parts[0] : "";
  }

  async storeEvent(streamId: string, message: any) {
    const eventId = this.generateEventId(streamId);
    this.events.set(eventId, { streamId, message });
    return eventId;
  }

  async replayEventsAfter(lastEventId: string, { send }: { send: (eventId: string, message: any) => Promise<void> }) {
    if (!lastEventId || !this.events.has(lastEventId)) return "";

    const streamId = this.getStreamIdFromEventId(lastEventId);
    if (!streamId) return "";

    let found = false;
    const sorted = [...this.events.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    for (const [eventId, { streamId: sid, message }] of sorted) {
      if (sid !== streamId) continue;
      if (eventId === lastEventId) {
        found = true;
        continue;
      }
      if (found) await send(eventId, message);
    }

    return streamId;
  }
}

function readJsonBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      if (!data.trim()) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

function unauthorized(res: http.ServerResponse, message = "Unauthorized") {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

function badRequest(res: http.ServerResponse, message = "Bad Request") {
  res.statusCode = 400;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: message }));
}

function methodNotAllowed(res: http.ServerResponse, message = "Method Not Allowed") {
  res.statusCode = 405;
  res.setHeader("content-type", "text/plain");
  res.end(message);
}

function notFound(res: http.ServerResponse) {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain");
  res.end("Not Found");
}

function getAuthHeader(req: http.IncomingMessage) {
  // Node lowercases header keys.
  const h = req.headers["x-octssh-key"];
  if (typeof h === "string") return h;
  if (Array.isArray(h)) return h[0];
  return undefined;
}

function getBearer(req: http.IncomingMessage) {
  const h = req.headers["authorization"];
  const v = typeof h === "string" ? h : Array.isArray(h) ? h[0] : "";
  const m = /^Bearer\s+(.+)$/i.exec(v);
  return m?.[1];
}

function shouldDebug() {
  const v = process.env.OCTSSH_SERVE_DEBUG ?? process.env.OCTSSH_DEBUG;
  return v === "1" || v === "true";
}

function toSingleHeaderValue(v: string | string[] | undefined) {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[0];
  return undefined;
}

function safeRequestMeta(req: http.IncomingMessage) {
  const sessionId = toSingleHeaderValue(req.headers["mcp-session-id"]);

  return {
    method: (req.method ?? "GET").toUpperCase(),
    url: req.url ?? "",
    host: toSingleHeaderValue(req.headers.host),
    sessionId,
    userAgent: toSingleHeaderValue(req.headers["user-agent"]),
  };
}

function logServeError(message: string, err: unknown, meta: Record<string, unknown>) {
  type ErrorLike = { message?: unknown; stack?: unknown };
  const stack = (() => {
    if (err instanceof Error) return err.stack ?? err.message;
    if (typeof err === "object" && err !== null) {
      const e = err as ErrorLike;
      if (typeof e.stack === "string") return e.stack;
      if (typeof e.message === "string") return e.message;
    }
    return String(err);
  })();
  console.error("[octssh serve]", message);
  console.error("[octssh serve]", JSON.stringify(meta));
  console.error("[octssh serve]", stack);
}

export type ServeConfig = {
  host: string;
  port: number;
  authKey?: string;
};

export async function runStreamableHttpServer(params: {
  config: ServeConfig;
  server?: McpServer;
  createServer?: () => McpServer;
}) {
  if (!params.createServer && !params.server) {
    throw new Error("runStreamableHttpServer: missing server (pass server or createServer)");
  }
  const createServer = params.createServer ?? (() => params.server!);
  const authKey =
    params.config.authKey ?? crypto.randomBytes(24).toString("base64url");

  const sessions: Record<string, { transport: StreamableHTTPServerTransport; server: McpServer }> = {};
  const multiSession = !!params.createServer;
  let singleSessionActive = false;

  const httpServer = http.createServer(async (req, res) => {
    let stage = "start";
    const debug = shouldDebug();
    const meta = safeRequestMeta(req);

    try {
      stage = "parse_url";
      const url = new URL(req.url ?? "/", "http://octssh.local");
      if (url.pathname !== "/mcp") return notFound(res);

      stage = "auth";
      const provided = getAuthHeader(req) ?? getBearer(req);
      if (!provided || provided !== authKey) {
        return unauthorized(res, "Missing or invalid OctSSH auth key");
      }

      stage = "route";
      const method = (req.method ?? "GET").toUpperCase();
      const sidHeader = req.headers["mcp-session-id"];
      const sessionId =
        typeof sidHeader === "string" ? sidHeader : Array.isArray(sidHeader) ? sidHeader[0] : undefined;

      if (method === "POST") {
        stage = "read_body";
        let body: any;
        try {
          body = await readJsonBody(req);
        } catch {
          return badRequest(res, "Invalid JSON body");
        }

        let transport: StreamableHTTPServerTransport | undefined;

        stage = "select_transport";
        if (sessionId && sessions[sessionId]) {
          transport = sessions[sessionId].transport;
        } else if (!sessionId && body && isInitializeRequest(body)) {
          if (!multiSession && singleSessionActive) {
            res.statusCode = 409;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Only one session is supported with a single server instance" }));
            return;
          }

          stage = "init_transport";
          const server = createServer();
          const eventStore = new InMemoryEventStore();
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            eventStore,
            onsessioninitialized: (sid) => {
              sessions[sid] = { transport: transport!, server };
            },
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid && sessions[sid]) delete sessions[sid];
            if (!multiSession) singleSessionActive = false;
          };

          stage = "connect";
          await server.connect(transport);
          if (!multiSession) singleSessionActive = true;

          stage = "handle_post_init";
          await transport.handleRequest(req, res, body);
          return;
        } else {
          return badRequest(res, "Bad Request: missing session ID or not an initialize request");
        }

        stage = "handle_post";
        await transport.handleRequest(req, res, body);
        return;
      }

      if (method === "GET" || method === "DELETE") {
        // The StreamableHTTP client transport may probe GET /mcp before initialization.
        // Per spec this is optional; returning 405 tells clients to proceed without it.
        if (method === "GET" && !sessionId) {
          return methodNotAllowed(res, "SSE stream not available before session initialization");
        }

        if (!sessionId || !sessions[sessionId]) {
          return badRequest(res, "Invalid or missing session ID");
        }

        stage = "handle_get_delete";
        await sessions[sessionId].transport.handleRequest(req, res);
        return;
      }

      return methodNotAllowed(res);
    } catch (err) {
      if (debug) {
        logServeError("request failed", err, { stage, ...meta });
      } else {
        logServeError("request failed", err, { stage, method: meta.method, url: meta.url, sessionId: meta.sessionId });
      }

      // Best-effort error.
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(params.config.port, params.config.host, () => resolve());
    httpServer.on("error", reject);
  });

  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : params.config.port;
  const baseUrl = `http://${params.config.host}:${port}/mcp`;

  return {
    url: baseUrl,
    authKey,
    close: async () => {
      for (const sid of Object.keys(sessions)) {
        try {
          await sessions[sid].transport.close();
        } catch {
          // ignore
        }
        delete sessions[sid];
      }
      singleSessionActive = false;
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
