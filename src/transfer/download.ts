import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { withSftp, sftpFastGet, sftpStat } from "../ssh/sftp.ts";
import { mapLimit } from "../util/concurrency.ts";
import { resolveRemotePath } from "./remotePath.ts";
import { walkRemoteDir } from "./remoteWalk.ts";

function ensureLocalDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
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
      const target = fs.existsSync(localAbs) && fs.statSync(localAbs).isDirectory()
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

    // For directories, localPath is treated as destination directory.
    ensureLocalDir(localAbs);
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

export async function performDownload(client: Client, plan: DownloadPlan, signal?: AbortSignal) {
  return withSftp(client, async (sftp) => {
    for (const d of plan.dirs) {
      signal?.throwIfAborted();
      ensureLocalDir(d);
    }

    await mapLimit(plan.files, 4, async (f) => {
      signal?.throwIfAborted();
      await sftpFastGet(sftp, f.remote, f.local);
    });
    return { files: plan.files.length, bytes: plan.totalBytes };
  });
}
