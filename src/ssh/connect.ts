import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import ssh2 from "ssh2";
import { Client } from "ssh2";
import { connectViaProxyJump } from "./proxyJump.ts";
import type { Ssh2HostVerifier } from "./hostVerifier.ts";

export type SshClientParams = {
  host?: string;
  port?: number;
  username: string;
  sock?: Duplex;
  privateKey?: string;
  /** 加密私钥的口令；未提供时由 auth 回调请求。 */
  passphrase?: string;
  /** 服务器密码；未提供时由 auth 回调请求。 */
  password?: string;
  agent?: string;
  readyTimeoutMs?: number;
  /** OpenSSH ServerAliveInterval, converted to ssh2 milliseconds. */
  keepaliveIntervalMs?: number;
  /** OpenSSH ServerAliveCountMax. */
  keepaliveCountMax?: number;
  /** 主机密钥校验；不传则沿用 ssh2 默认（不校验）。 */
  hostVerifier?: Ssh2HostVerifier;
  /** 凭据交互回调；不传则沿用 ssh2 的默认认证顺序与 connect 配置字段。 */
  auth?: SshAuthOptions;
  signal?: AbortSignal;
};

/**
 * 凭据交互回调。由调用方接上凭据缓存与遮罩输入；connect 层自身不弹窗、
 * 不缓存，只按顺序取用，因此可以离线注入假回调验证顺序与次数。
 */
export type SshAuthOptions = {
  /** 展示给用户的认证对象，例如 user@host:port。 */
  label: string;
  /** 私钥材料摘要，换文件即失效；用于口令缓存键。 */
  keyHash?: string;
  requestPassword?: (label: string) => Promise<string | undefined>;
  requestPassphrase?: (label: string, keyHash?: string) => Promise<string | undefined>;
  /** 认证失败后通知调用方清掉对应的缓存条目。 */
  onAuthFailure?: (kind: "password" | "key-passphrase") => void;
};

export type ConnectedSsh = { client: Client; end: () => void };

/**
 * 连接失败分类。模型只看到这几类与一句可操作说明，不透传 ssh2 原文
 * （原文往往是 "Host denied (verification failed)" 这类无法据以行动的描述）。
 */
export type ConnectFailureKind =
  | "HOST_KEY_MISMATCH"
  | "HOST_KEY_REJECTED"
  | "HOST_KEY_UNTRUSTED"
  | "TRUST_STORE_UNREADABLE"
  | "AUTH_FAILED"
  | "AUTH_UNSUPPORTED"
  | "AUTH_REQUIRES_UI"
  | "NETWORK"
  | "ABORTED";

export class SshConnectError extends Error {
  readonly kind: ConnectFailureKind;

  constructor(kind: ConnectFailureKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SshConnectError";
    this.kind = kind;
  }
}

function classifyConnectError(error: Error, verifier?: Ssh2HostVerifier, attempt?: AuthAttemptState): SshConnectError {
  if (error.name === "AbortError") return new SshConnectError("ABORTED", "SSH connection aborted", { cause: error });

  const hostKey = verifier?.lastFailure();
  if (hostKey) {
    switch (hostKey.reason) {
      case "HOST_KEY_MISMATCH":
        return new SshConnectError("HOST_KEY_MISMATCH", `${hostKey.message} The host key changed, so the connection was blocked. If the server key was rotated on purpose, run /octssh trust forget <host:port> and reconnect.`, { cause: error });
      case "HOST_KEY_REJECTED":
        return new SshConnectError("HOST_KEY_REJECTED", hostKey.message, { cause: error });
      case "NO_UI":
        return new SshConnectError("HOST_KEY_UNTRUSTED", hostKey.message, { cause: error });
      case "TRUST_STORE_UNREADABLE":
        return new SshConnectError("TRUST_STORE_UNREADABLE", hostKey.message, { cause: error });
    }
  }

  if (attempt?.unsupportedKeyboardInteractive) {
    return new SshConnectError(
      "AUTH_UNSUPPORTED",
      "The server only offers keyboard-interactive authentication, which OctSSH does not implement. Use an SSH agent or a key-based login for this host.",
      { cause: error },
    );
  }

  if (attempt?.needsCredentialUi) {
    return new SshConnectError(
      "AUTH_REQUIRES_UI",
      "This host needs a password or private key passphrase, but no interactive UI is available. Run Pi in the interactive TUI to enter it.",
      { cause: error },
    );
  }

  const level = (error as Error & { level?: string }).level;
  if (level === "client-authentication" || /authentication methods failed/i.test(error.message)) {
    return new SshConnectError("AUTH_FAILED", "SSH authentication failed: no configured credential was accepted by the server.", { cause: error });
  }

  return new SshConnectError("NETWORK", `SSH connection failed: ${error.message}`, { cause: error });
}

/**
 * 认证尝试的可见状态。ssh2 在失败时只报一句通用描述，调用方需要这些
 * 标记来区分「只有 keyboard-interactive」「缺 UI」「密码错误」。
 */
type AuthAttemptState = {
  unsupportedKeyboardInteractive: boolean;
  needsCredentialUi: boolean;
};

/** 密码错误次数上限：超过后停止，不再弹窗。 */
const MAX_PASSWORD_ATTEMPTS = 2;

/**
 * 加密私钥的判定依据：用 ssh2 自己的 `utils.parseKey` 在不带口令的情况下
 * 解析一次。未加密的私钥会解析成功；加密的私钥返回 Error，其 message
 * 明确提到 "no passphrase given"。这是 ssh2 内部的判定，比匹配连接错误
 * 更可靠，也能在发起网络连接前就完成。
 */
function privateKeyNeedsPassphrase(privateKey: string): boolean {
  const parsed = ssh2.utils.parseKey(privateKey);
  if (!(parsed instanceof Error)) return false;
  return /passphrase/i.test(parsed.message);
}

/**
 * none → publickey → agent → password 的显式顺序。
 *
 * 每步都可以是异步的（返回 undefined 并稍后调用 `send`），这样口令/密码
 * 弹窗不会阻塞 ssh2 的单线程握手。`authsLeft` 用来识别服务器只接受
 * keyboard-interactive 的情况：那是「不支持」，不是「密码错误」。
 */
function buildAuthHandler(
  params: SshClientParams,
  state: AuthAttemptState,
  privateKey: string | undefined,
): any {
  const auth = params.auth;
  let passwordAttempts = 0;
  let passphraseRequested = false;
  let passwordRequested = false;

  return (authsLeft: string[] | null, _partialSuccess: boolean | null, send: (next: unknown) => void) => {
    const username = params.username;

    // 首次调用时 authsLeft 与 partialSuccess 都是 null：那是「还不知道服务器
    // 要什么」的阶段，先试 none（openssh 通常立刻回公开的可用方法列表）。
    if (authsLeft === null) return send("none");

    const has = (method: string) => authsLeft.includes(method);
    if (authsLeft.length === 0) return send(false);

    if (has("publickey") && privateKey !== undefined) {
      if (params.passphrase !== undefined) {
        return send({ type: "publickey", username, key: privateKey, passphrase: params.passphrase });
      }
      // 先不带口令试一次：未加密的私钥本来就不需要。
      if (!passphraseRequested) {
        passphraseRequested = true;
        return send({ type: "publickey", username, key: privateKey });
      }
      return send("agent");
    }

    if (has("agent") && params.agent) return send("agent");

    if (has("password")) {
      if (params.password !== undefined) {
        return send({ type: "password", username, password: params.password });
      }
      if (!auth?.requestPassword) {
        state.needsCredentialUi = true;
        return send(false);
      }
      if (passwordRequested) {
        // 再次进来说明上一次密码被拒：先清缓存，避免用同一个错误值重试。
        auth.onAuthFailure?.("password");
        if (passwordAttempts >= MAX_PASSWORD_ATTEMPTS) return send(false);
      }
      passwordRequested = true;
      passwordAttempts += 1;
      void auth
        .requestPassword(auth.label)
        .then((value) => {
          if (value === undefined) {
            state.needsCredentialUi = true;
            send(false);
            return;
          }
          send({ type: "password", username, password: value });
        })
        .catch(() => {
          state.needsCredentialUi = true;
          send(false);
        });
      return undefined;
    }

    if (has("keyboard-interactive")) {
      state.unsupportedKeyboardInteractive = true;
      return send(false);
    }

    return send(false);
  };
}

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

export async function connectSsh2(params: SshClientParams): Promise<Client> {
  if (params.signal?.aborted) throw abortError();
  const hostVerifier = params.hostVerifier;

  const state: AuthAttemptState = { unsupportedKeyboardInteractive: false, needsCredentialUi: false };
  const resolved: SshClientParams = { ...params };

  // 加密私钥：连之前就问口令。拿不到口令就完全不发起连接，
  // 避免把「缺交互界面」误报成网络或认证错误。
  if (resolved.privateKey && resolved.passphrase === undefined && privateKeyNeedsPassphrase(resolved.privateKey)) {
    if (!resolved.auth?.requestPassphrase) {
      state.needsCredentialUi = true;
      throw new SshConnectError(
        "AUTH_REQUIRES_UI",
        "The private key is encrypted but no passphrase prompt is available.",
      );
    }
    const passphrase = await resolved.auth.requestPassphrase(resolved.auth.label, resolved.auth.keyHash);
    if (passphrase === undefined) {
      throw new SshConnectError("AUTH_FAILED", "Private key passphrase was not provided.");
    }
    // 口令对不对本地就能判定：解不开就当作口令错误，清缓存并停止，
    // 不要让 ssh2 静默跳过 publickey 再去试别的弱方法。
    const parsed = ssh2.utils.parseKey(resolved.privateKey, passphrase);
    if (parsed instanceof Error) {
      resolved.auth.onAuthFailure?.("key-passphrase");
      throw new SshConnectError("AUTH_FAILED", "The private key passphrase did not unlock the key.");
    }
    resolved.passphrase = passphrase;
  }

  // 凭据 UI 可能晚于连接池取消返回，不能在取消后再建立连接。
  if (params.signal?.aborted) throw abortError();
  const authHandler = resolved.auth ? buildAuthHandler(resolved, state, resolved.privateKey) : undefined;

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
      reject(classifyConnectError(error, hostVerifier, state));
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
    if (params.keepaliveIntervalMs !== undefined) connectOptions.keepaliveInterval = params.keepaliveIntervalMs;
    if (params.keepaliveCountMax !== undefined) connectOptions.keepaliveCountMax = params.keepaliveCountMax;
    if (params.sock) connectOptions.sock = params.sock;
    if (params.privateKey) connectOptions.privateKey = params.privateKey;
    if (params.agent) connectOptions.agent = params.agent;
    if (hostVerifier) connectOptions.hostVerifier = hostVerifier;
    if (authHandler) connectOptions.authHandler = authHandler;
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
      signal,
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
