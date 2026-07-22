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

export async function sftpStat(sftp: SftpClient, p: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    sftp.stat(p, (err: any, stats: any) => {
      if (err) {
        // ssh2 uses numeric errno codes; treat any error as non-existence for our use.
        resolve(null);
        return;
      }
      resolve(stats);
    });
  });
}

export async function sftpMkdir(sftp: SftpClient, p: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.mkdir(p, (err: any) => {
      if (!err) return resolve();
      // Ignore "exists" errors.
      resolve();
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

export async function sftpFastPut(sftp: SftpClient, localPath: string, remotePath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

export async function sftpFastGet(sftp: SftpClient, remotePath: string, localPath: string) {
  return new Promise<void>((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, (err: any) => {
      if (err) reject(err);
      else resolve();
    });
  });
}
