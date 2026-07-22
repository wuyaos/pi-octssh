import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { withSftp, sftpFastPut, sftpMkdirp, sftpStat } from "../ssh/sftp.ts";
import { mapLimit } from "../util/concurrency.ts";
import { resolveRemotePath } from "./remotePath.ts";
import { walkLocal } from "./localWalk.ts";

export type UploadPlan = {
  isDir: boolean;
  files: { local: string; remote: string; size: number }[];
  dirs: string[];
  totalBytes: number;
};

function isRemoteDir(stat: any) {
  try {
    return !!stat?.isDirectory?.();
  } catch {
    return false;
  }
}

export async function planUpload(client: Client, localPath: string, remotePath: string, signal?: AbortSignal): Promise<UploadPlan> {
  signal?.throwIfAborted();
  const st = fs.statSync(localPath);
  const remoteBase = await resolveRemotePath(client, remotePath);
  signal?.throwIfAborted();

  if (st.isFile()) {
    const remoteIsDirHint = remotePath.trim().endsWith("/");
    const remoteTarget = remoteIsDirHint
      ? `${remoteBase.replace(/\/$/, "")}/${path.basename(localPath)}`
      : remoteBase;

    return {
      isDir: false,
      dirs: [path.posix.dirname(remoteTarget)],
      files: [{ local: localPath, remote: remoteTarget, size: st.size }],
      totalBytes: st.size,
    };
  }

  if (!st.isDirectory()) {
    throw new Error(`Unsupported local path type: ${localPath}`);
  }

  const entries = walkLocal(localPath);
  const files = entries
    .filter((e) => e.isFile)
    .map((e) => ({
      local: e.absPath,
      remote: `${remoteBase.replace(/\/$/, "")}/${e.relPath}`.replace(/\/+/g, "/"),
      size: e.size,
    }));
  const dirs = Array.from(
    new Set(
      entries
        .filter((e) => e.isDir)
        .map((e) => `${remoteBase.replace(/\/$/, "")}/${e.relPath}`.replace(/\/+/g, "/"))
        .concat([remoteBase.replace(/\/$/, "")])
    )
  ).sort((a, b) => a.localeCompare(b));

  const totalBytes = files.reduce((acc, f) => acc + (f.size ?? 0), 0);
  return { isDir: true, files, dirs, totalBytes };
}

export async function findUploadConflicts(client: Client, plan: UploadPlan, signal?: AbortSignal) {
  return withSftp(client, async (sftp) => {
    const conflicts = await mapLimit(plan.files, 16, async (f) => {
      signal?.throwIfAborted();
      const stat = await sftpStat(sftp, f.remote);
      if (!stat) return null;
      // Any existing entry is a conflict, including directories.
      return f.remote;
    });
    return conflicts.filter(Boolean) as string[];
  });
}

export async function performUpload(client: Client, plan: UploadPlan, signal?: AbortSignal) {
  return withSftp(client, async (sftp) => {
    for (const d of plan.dirs) {
      signal?.throwIfAborted();
      await sftpMkdirp(sftp, d);
    }

    await mapLimit(plan.files, 4, async (f) => {
      signal?.throwIfAborted();
      await sftpFastPut(sftp, f.local, f.remote);
    });

    return { files: plan.files.length, bytes: plan.totalBytes };
  });
}
