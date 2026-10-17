import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { getSftp, sftpGet, sftpStat, withSftp } from "../ssh/sftp.ts";
import { resolveRemotePath } from "./remotePath.ts";
import { walkRemoteDir } from "./remoteWalk.ts";

function ensureLocalDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function existingPathIsDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isDir(stat: any) {
  try {
    return !!stat?.isDirectory?.();
  } catch {
    return false;
  }
}

function isFile(stat: any) {
  try {
    return !!stat?.isFile?.();
  } catch {
    return false;
  }
}

export type DownloadPlan = {
  isDir: boolean;
  files: { remote: string; local: string; size: number }[];
  dirs: string[];
  totalBytes: number;
};

export async function planDownload(client: Client, remotePath: string, localPath: string, signal?: AbortSignal): Promise<DownloadPlan> {
  signal?.throwIfAborted();
  return withSftp(client, async (sftp) => {
    const remoteAbs = await resolveRemotePath(client, remotePath);
    signal?.throwIfAborted();
    const stat = await sftpStat(sftp, remoteAbs);
    if (!stat) throw new Error(`Remote path not found: ${remotePath}`);

    const localAbs = path.resolve(localPath);

    if (isFile(stat)) {
      const target = fs.existsSync(localAbs) && existingPathIsDirectory(localAbs)
        ? path.join(localAbs, path.basename(remoteAbs))
        : localAbs;

      return {
        isDir: false,
        dirs: [path.dirname(target)],
        files: [{ remote: remoteAbs, local: target, size: stat.size ?? 0 }],
        totalBytes: stat.size ?? 0,
      };
    }

    if (!isDir(stat)) {
      throw new Error(`Unsupported remote path type: ${remotePath}`);
    }

    // For directories, localPath is treated as destination directory. Planning
    // must not mutate the local filesystem: conflicts/cancellation are decided
    // only after this plan has been returned to the caller.
    if (fs.existsSync(localAbs) && !existingPathIsDirectory(localAbs)) {
      throw new Error(`Local destination is not a directory: ${localPath}`);
    }
    const entries = await walkRemoteDir(sftp, remoteAbs);
    const files = entries
      .filter((e) => e.isFile)
      .map((e) => ({
        remote: e.absPath,
        local: path.join(localAbs, e.relPath.split("/").join(path.sep)),
        size: e.size,
      }));
    const dirs = Array.from(
      new Set(
        entries
          .filter((e) => e.isDir)
          .map((e) => path.join(localAbs, e.relPath.split("/").join(path.sep)))
          .concat([localAbs])
      )
    ).sort();
    const totalBytes = files.reduce((acc, f) => acc + (f.size ?? 0), 0);
    return { isDir: true, files, dirs, totalBytes };
  });
}

export function findDownloadConflicts(plan: DownloadPlan) {
  const conflicts: string[] = [];
  for (const f of plan.files) {
    if (fs.existsSync(f.local)) conflicts.push(f.local);
  }
  return conflicts;
}

export async function performDownload(
  client: Client,
  plan: DownloadPlan,
  signal?: AbortSignal,
  onFileComplete?: (file: DownloadPlan["files"][number]) => void,
) {
  const sftp = await getSftp(client);
  try {
    for (const d of plan.dirs) {
      signal?.throwIfAborted();
      ensureLocalDir(d);
    }
    // Keep a single SFTP channel for the whole operation. sftpGet streams into
    // a temporary sibling and supports aborting the currently active file.
    for (const f of plan.files) {
      signal?.throwIfAborted();
      await sftpGet(sftp, f.remote, f.local, signal);
      onFileComplete?.(f);
    }
    return { files: plan.files.length, bytes: plan.totalBytes };
  } finally {
    try { sftp.end?.(); } catch { /* ignore channel teardown errors */ }
  }
}
