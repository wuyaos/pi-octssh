import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import { connectViaProxyJump } from "./proxyJump.ts";

export type SshClientParams = {
  host?: string;
  port?: number;
  username: string;
  sock?: Duplex;
  privateKey?: string;
  agent?: string;
  readyTimeoutMs?: number;
  signal?: AbortSignal;
};

export type ConnectedSsh = { client: Client; end: () => void };

function abortError() {
  const error = new Error("SSH connection aborted");
  error.name = "AbortError";
  return error;
}
function expandHome(p: string) {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}
export function loadFirstPrivateKey(identityFiles: string[]) {
  for (const p of identityFiles) {
    const abs = expandHome(p);
    if (fs.existsSync(abs)) return fs.readFileSync(abs, "utf8");
  }
  return undefined;
}

export function connectSsh2(params: SshClientParams): Promise<Client> {
  if (params.signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    // Permanent error sink. ssh2 emits trailing "Connection lost before
    // handshake" (fatal, level 'protocol') during teardown when the socket
    // connected but no SSH banner was received, and may emit other protocol /
    // keepalive errors on pooled connections. An emitted 'error' with no
    // listener becomes an uncaughtException and crashes the host process, so
    // a listener must remain attached for the client's whole lifetime.
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      client.removeAllListeners("ready");
      params.signal?.removeEventListener("abort", onAbort);
      try { client.end(); } catch { /* ignore */ }
      reject(error);
    };
    const onAbort = () => onError(abortError());
    params.signal?.addEventListener("abort", onAbort, { once: true });
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      client.removeAllListeners("ready");
      params.signal?.removeEventListener("abort", onAbort);
      // Swap the connect-phase handler for a permanent sink so late errors on
      // a pooled connection never escape as uncaughtExceptions.
      client.removeListener("error", onError);
      client.on("error", () => { /* connection-level error; handled per-op */ });
      resolve(client);
    });
    client.on("error", onError);

    const connectOptions: any = {
      host: params.host ?? "127.0.0.1",
      port: params.port ?? 22,
      username: params.username,
      readyTimeout: params.readyTimeoutMs ?? 20_000,
    };
    if (params.sock) connectOptions.sock = params.sock;
    if (params.privateKey) connectOptions.privateKey = params.privateKey;
    if (params.agent) connectOptions.agent = params.agent;
    client.connect(connectOptions);
  });
}

export async function connectDirect(params: Omit<SshClientParams, "sock">): Promise<ConnectedSsh> {
  const client = await connectSsh2(params);
  return { client, end: () => client.end() };
}

export async function connectWithProxyJump(params: {
  jump: Omit<SshClientParams, "sock"> & { host: string; port?: number };
  target: Omit<SshClientParams, "sock"> & { host: string; port?: number };
  signal?: AbortSignal;
}) {
  const signal = params.signal ?? params.target.signal ?? params.jump.signal;
  const jumpClient = await connectSsh2({ ...params.jump, signal });
  try {
    const targetClient = await connectViaProxyJump({
      jumpClient,
      targetHost: params.target.host,
      targetPort: params.target.port ?? 22,
      connectTarget: (sock) => connectSsh2({ ...params.target, sock, signal }),
    });
    return {
      client: targetClient,
      end: () => { targetClient.end(); jumpClient.end(); },
    } satisfies ConnectedSsh;
  } catch (err) {
    jumpClient.end();
    throw err;
  }
}
