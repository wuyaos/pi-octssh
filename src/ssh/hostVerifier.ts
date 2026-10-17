import {
  addHostKeyTrust,
  checkHostTrust,
  computeHostKeyFingerprint,
  TrustStoreUnreadableError,
} from "../state/hostTrust.ts";
import type { SshIdentity } from "../security/identity.ts";
import { displayIdentity } from "../security/identity.ts";

/**
 * 主机密钥校验失败原因。调用方据此给出准确错误，而不是 ssh2 的原文
 * （握手阶段 ssh2 只会报 "Host denied (verification failed)"）。
 */
export type HostVerificationFailure =
  | "HOST_KEY_MISMATCH"
  | "HOST_KEY_REJECTED"
  | "NO_UI"
  | "TRUST_STORE_UNREADABLE";

export class HostKeyVerificationError extends Error {
  readonly reason: HostVerificationFailure;

  constructor(reason: HostVerificationFailure, message: string) {
    super(message);
    this.name = "HostKeyVerificationError";
    this.reason = reason;
  }
}

/**
 * 首次见到主机密钥时的人工确认。仅由扩展层在 `ctx.hasUI && ctx.mode === "tui"`
 * 时提供；headless / 非交互场景不传。
 */
export type HostKeyConfirm = (request: {
  identity: SshIdentity;
  host: string;
  port: number;
  algorithm: string;
  fingerprintSha256: string;
}) => Promise<boolean>;

export type HostVerifierOptions = {
  identity: SshIdentity;
  baseDir?: string;
  confirm?: HostKeyConfirm;
  /** 每次握手结果回调，用于把失败原因传给连接层。 */
  onResult?: (result: { ok: boolean; reason?: HostVerificationFailure }) => void;
};

/**
 * ssh2 形态的校验器。形状仍是普通函数（ssh2 只认函数），额外带一个
 * `lastFailure()` 让连接层在握手失败后拿到准确原因——每个连接各自一份，
 * 不用模块级全局变量，避免并发连接互相覆盖。
 */
export type Ssh2HostVerifier = ((key: Buffer, verify: (permitted: boolean) => void) => void) & {
  lastFailure(): HostKeyVerificationError | undefined;
};

/**
 * 按 ssh2 的 `hostVerifier(key, verify)` 形态构造校验器。
 *
 * 不设 `hostHash`：需要原始公钥字节自己算 `SHA256:base64` 并解析算法名，
 * 否则无法与 `ssh-keygen -lf` 的结果对齐。返回 `undefined`（即不返回）
 * 即表示异步判定，稍后调用 `verify`。
 */
export function createHostVerifier(options: HostVerifierOptions): Ssh2HostVerifier {
  const { identity, confirm, onResult, baseDir } = options;
  let failure: HostVerificationFailure | undefined;
  let failureMessage: string | undefined;

  const fail = (reason: HostVerificationFailure, message: string, verify: (permitted: boolean) => void) => {
    failure = reason;
    failureMessage = message;
    onResult?.({ ok: false, reason });
    verify(false);
  };

  const verifier: Ssh2HostVerifier = (key, verify) => {
    const fingerprint = computeHostKeyFingerprint(Buffer.from(key));
    const host = identity.host;
    const port = identity.port;

    let check;
    try {
      check = checkHostTrust({ host, port, fingerprintSha256: fingerprint.fingerprintSha256, baseDir });
    } catch (error) {
      if (error instanceof TrustStoreUnreadableError) {
        fail("TRUST_STORE_UNREADABLE", error.message, verify);
        return;
      }
      throw error;
    }

    if (check.status === "trusted") {
      onResult?.({ ok: true });
      verify(true);
      return;
    }

    if (check.status === "mismatch") {
      // 密钥变化一律阻止，不提供「仍然继续」。
      fail(
        "HOST_KEY_MISMATCH",
        `Host key mismatch for ${host}:${port}. Recorded ${check.entry.algorithm} ${check.entry.fingerprintSha256}, presented ${fingerprint.algorithm} ${fingerprint.fingerprintSha256}.`,
        verify,
      );
      return;
    }

    // unknown
    if (!confirm) {
      fail(
        "NO_UI",
        `Host ${host}:${port} is not trusted and no confirmation UI is available. Presented ${fingerprint.algorithm} ${fingerprint.fingerprintSha256}.`,
        verify,
      );
      return;
    }

    void (async () => {
      let accepted = false;
      try {
        accepted = await confirm({
          identity,
          host,
          port,
          algorithm: fingerprint.algorithm,
          fingerprintSha256: fingerprint.fingerprintSha256,
        });
      } catch {
        accepted = false;
      }

      if (!accepted) {
        fail(
          "HOST_KEY_REJECTED",
          `Host key for ${displayIdentity(identity)} was rejected by the user.`,
          verify,
        );
        return;
      }

      try {
        // 先落盘再放行：否则下一步操作发生在未记录的信任之上。
        addHostKeyTrust({
          host,
          port,
          alias: identity.alias,
          algorithm: fingerprint.algorithm,
          fingerprintSha256: fingerprint.fingerprintSha256,
          baseDir,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        fail("TRUST_STORE_UNREADABLE", `Failed to record host key trust: ${message}`, verify);
        return;
      }

      onResult?.({ ok: true });
      verify(true);
    })();
  };

  verifier.lastFailure = () =>
    failure ? new HostKeyVerificationError(failure, failureMessage ?? failure) : undefined;
  return verifier;
}

