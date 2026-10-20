import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Client } from "ssh2";
import { scopeSftp } from "./sftpScope.ts";

export type SftpClient = any;

export function getSftp(client: Client, signal?: AbortSignal, timeoutMs = 15_000): Promise<SftpClient> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    let settled = false;
    const closeLate = (sftp: SftpClient) => {
      sftp.on?.("error", () => {});
      try { sftp.end?.(); } catch { /* 已关闭 */ }
      try { sftp.destroy?.(); } catch { /* 已关闭 */ }
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      client.removeListener?.("close", onClose);
      client.removeListener?.("error", fail);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onAbort = () => fail(signal?.reason ?? new Error("SFTP 已取消"));
    const onClose = () => fail(new Error("SSH 连接中断"));
    const timer = setTimeout(() => {
      const error = new Error("SFTP 通道打开超时");
      error.name = "TimeoutError";
      fail(error);
    }, timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    client.on?.("close", onClose);
    client.on?.("error", fail);
    try {
      client.sftp((err: any, sftp: any) => {
        if (settled) { if (sftp) closeLate(sftp); return; }
        if (err) { fail(err); return; }
        settled = true;
        cleanup();
        resolve(scopeSftp(sftp, signal));
      });
    } catch (error) { fail(error as Error); }
  });
}

export async function withSftp<T>(client: Client, fn: (sftp: SftpClient) => Promise<T>, signal?: AbortSignal) {
  const sftp = await getSftp(client, signal);
  try {
    return await fn(sftp);
  } finally {
    try {
      // ssh2 SFTP channel supports end().
      sftp.end?.();
    } catch {
      // ignore
    }
  }
}

function isSftpNotFound(error: any): boolean {
  // ssh2 exposes SFTP status codes via `code`; SSH_FX_NO_SUCH_FILE is 2.
  return error?.code === 2 || error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function isSftpAlreadyExists(error: any): boolean {
  // Servers commonly return SSH_FX_FAILURE (4) for mkdir of an existing path,
  // so prove existence with stat instead of swallowing every failure.
  return error?.code === 11 || error?.code === "EEXIST";
}

export async function sftpStat(sftp: SftpClient, p: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err: any, stats: any) => {
      if (!err) return resolve(stats);
      if (isSftpNotFound(err)) return resolve(null);
      reject(err);
    });
  });
}

export async function sftpMkdir(sftp: SftpClient, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, async (err: any) => {
      if (!err) return resolve();
      if (!isSftpAlreadyExists(err)) {
        // Some servers use SSH_FX_FAILURE for an existing directory. Verify
        // that narrow exception; permission/network failures remain visible.
        try {
          const stat = await sftpStat(sftp, p);
          if (stat?.isDirectory?.()) return resolve();
        } catch (statError) {
          return reject(statError);
        }
        return reject(err);
      }
      try {
        const stat = await sftpStat(sftp, p);
        if (stat?.isDirectory?.()) return resolve();
      } catch (statError) {
        return reject(statError);
      }
      reject(err);
    });
  });
}

export async function sftpMkdirp(sftp: SftpClient, p: string): Promise<void> {
  // Normalize to POSIX for remote.
  const parts = p.split("/").filter(Boolean);
  let cur = p.startsWith("/") ? "/" : "";
  for (const part of parts) {
    cur = cur === "/" ? `/${part}` : `${cur}/${part}`;
    await sftpMkdir(sftp, cur);
  }
}

export async function sftpReaddir(sftp: SftpClient, p: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (err: any, list: any[]) => {
      if (err) return reject(err);
      resolve(list ?? []);
    });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error("SFTP transfer aborted");
    error.name = "AbortError";
    throw error;
  }
}

/**
 * Stream one upload so AbortSignal can destroy the in-flight streams. ssh2's
 * fastPut/fastGet cannot be cancelled once started, which left a supposedly
 * cancelled async transfer running in the background.
 */
export async function sftpPut(sftp: SftpClient, localPath: string, remotePath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const source = fs.createReadStream(localPath);
  const destination = sftp.createWriteStream(remotePath);
  try {
    await pipeline(source, destination, { signal });
  } finally {
    source.destroy();
    destination.destroy?.();
  }
}

/**
 * Stream a download into a sibling temporary file and rename it only after the
 * full transfer succeeds. An abort/error therefore never exposes a truncated
 * destination file as a successful download.
 */
export async function sftpGet(sftp: SftpClient, remotePath: string, localPath: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const partialPath = `${localPath}.octssh-part-${crypto.randomUUID()}`;
  const source = sftp.createReadStream(remotePath);
  const destination = fs.createWriteStream(partialPath, { flags: "wx" });
  try {
    await pipeline(source, destination, { signal });
    throwIfAborted(signal);
    fs.renameSync(partialPath, localPath);
  } finally {
    source.destroy?.();
    destination.destroy();
    fs.rmSync(partialPath, { force: true });
  }
}

/**
 * `lstat`：不跟随符号链接。attr 只有 v3 的 mode/uid/gid/size/atime/mtime，
 * 没有 inode/nlink——那两项只能从远端 `stat` 拿（见 remote/fingerprint.ts）。
 */
export async function sftpLstat(sftp: SftpClient, p: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(p, (err: any, stats: any) => {
      if (!err) return resolve(stats);
      if (isSftpNotFound(err)) return resolve(null);
      reject(err);
    });
  });
}

/**
 * 以 `wx` 独占创建并写入完整字节。目标已存在时抛可识别的 EEXIST 错误，
 * 绝不覆盖——编辑流程靠这一点防止并发覆盖别人的文件。
 */
export async function sftpWriteExclusive(
  sftp: SftpClient,
  remotePath: string,
  bytes: Buffer,
  mode?: number,
): Promise<void> {
  const writeAll = (handle: Buffer) =>
    new Promise<void>((resolve, reject) => {
      let offset = 0;
      const writeNext = () => {
        if (offset >= bytes.length) {
          return sftp.close(handle, (closeErr: any) => (closeErr ? reject(closeErr) : resolve()));
        }
        const chunk = bytes.subarray(offset, Math.min(offset + 32 * 1024, bytes.length));
        sftp.write(handle, chunk, 0, chunk.length, offset, (writeErr: any) => {
          if (writeErr) {
            return sftp.close(handle, () => reject(writeErr));
          }
          offset += chunk.length;
          writeNext();
        });
      };
      writeNext();
    });
  // ssh2 的 open 签名是 (path, flags 字符串, attributes, cb)；mode 走 attributes，
  // 不是 { flags, mode } 对象——那会变成 "Unknown flags string: [object Object]"。
  if (mode !== undefined) {
    return new Promise<void>((resolve, reject) => {
      sftp.open(remotePath, "wx", mode, (err: any, handle: Buffer) => {
        if (err) return reject(err);
        writeAll(handle).then(resolve, reject);
      });
    });
  }
  return new Promise<void>((resolve, reject) => {
    sftp.open(remotePath, "wx", (err: any, handle: Buffer) => {
      if (err) return reject(err);
      writeAll(handle).then(resolve, reject);
    });
  });
}

/** `posix-rename@openssh.com` 扩展：原子替换。服务器不支持时抛 `POSIX_RENAME_UNSUPPORTED`。 */
export async function posixRename(sftp: SftpClient, from: string, to: string): Promise<void> {
  if (typeof sftp.ext_openssh_rename !== "function") {
    const error = new Error("SFTP server does not advertise posix-rename@openssh.com");
    (error as NodeJS.ErrnoException).code = "POSIX_RENAME_UNSUPPORTED";
    throw error;
  }
  await new Promise<void>((resolve, reject) => {
    sftp.ext_openssh_rename(from, to, (err: any) => {
      if (!err) return resolve();
      if (err.code === 8 || /unsupported/i.test(String(err.message ?? ""))) {
        const error = new Error("SFTP server does not support posix-rename@openssh.com");
        (error as NodeJS.ErrnoException).code = "POSIX_RENAME_UNSUPPORTED";
        return reject(error);
      }
      reject(err);
    });
  });
}

/** `setstat` 的 atime/mtime（秒）。保留原有 mode/uid/gid 不变。 */
export async function setTimes(sftp: SftpClient, p: string, atime: number, mtime: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.utimes(p, atime, mtime, (err: any) => (err ? reject(err) : resolve()));
  });
}

export async function sftpChmod(sftp: SftpClient, p: string, mode: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.chmod(p, mode, (err: any) => (err ? reject(err) : resolve()));
  });
}

export async function sftpChown(sftp: SftpClient, p: string, uid: number, gid: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    sftp.chown(p, uid, gid, (err: any) => (err ? reject(err) : resolve()));
  });
}
