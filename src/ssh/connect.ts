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
    const cleanup = () => {
      client.removeAllListeners("ready");
      client.removeAllListeners("error");
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      try { client.end(); } catch { /* ignore */ }
      reject(error);
    };
    const onAbort = () => fail(abortError());
    params.signal?.addEventListener("abort", onAbort, { once: true });
    client.on("ready", () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(client);
    });
    client.on("error", fail);

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
