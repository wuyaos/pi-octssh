import crypto from "node:crypto";
import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import type { Client } from "ssh2";

export type SftpClient = any;

export function getSftp(client: Client): Promise<SftpClient> {
  return new Promise((resolve, reject) => {
    client.sftp((err: any, sftp: any) => {
      if (err) reject(err);
      else resolve(sftp);
    });
  });
}

export async function withSftp<T>(client: Client, fn: (sftp: SftpClient) => Promise<T>) {
  const sftp = await getSftp(client);
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
