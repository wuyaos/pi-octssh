import type { SftpClient } from "../ssh/sftp.ts";
import { sftpReaddir, sftpStat } from "../ssh/sftp.ts";

export type RemoteFileEntry = {
  absPath: string;
  relPath: string;
  isFile: boolean;
  isDir: boolean;
  size: number;
};

function isDir(attrs: any) {
  try {
    return !!attrs?.isDirectory?.();
  } catch {
    return false;
  }
}

function isFile(attrs: any) {
  try {
    return !!attrs?.isFile?.();
  } catch {
    return false;
  }
}

export async function walkRemoteDir(sftp: SftpClient, rootAbs: string): Promise<RemoteFileEntry[]> {
  const rootStat = await sftpStat(sftp, rootAbs);
  if (!rootStat) throw new Error(`Remote path not found: ${rootAbs}`);
  if (!isDir(rootStat)) throw new Error(`Remote path is not a directory: ${rootAbs}`);

  const out: RemoteFileEntry[] = [];

  const walk = async (absDir: string, relDir: string) => {
    const list = await sftpReaddir(sftp, absDir);
    for (const ent of list) {
      const name = ent.filename as string;
      if (!name || name === "." || name === "..") continue;

      const abs = absDir.endsWith("/") ? `${absDir}${name}` : `${absDir}/${name}`;
      const rel = relDir ? `${relDir}/${name}` : name;
      const attrs = ent.attrs;

      if (isDir(attrs)) {
        out.push({ absPath: abs, relPath: rel, isFile: false, isDir: true, size: 0 });
        await walk(abs, rel);
      } else if (isFile(attrs)) {
        out.push({ absPath: abs, relPath: rel, isFile: true, isDir: false, size: attrs.size ?? 0 });
      }
    }
  };

  await walk(rootAbs, "");
  return out;
}
