import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import {
  posixRename,
  sftpChmod,
  sftpChown,
  setTimes,
  sftpLstat,
  sftpWriteExclusive,
  type SftpClient,
} from "../ssh/sftp.ts";
import type { RemoteAttrs, RemoteFileOps, RemoteInode } from "./applyEdit.ts";

/**
 * `RemoteFileOps` 的 SFTP 实现：只做转发，不含任何判断。
 *
 * 所有决定（要不要写、nlink 是否 >1、失败归到哪一类）都在 applyEdit 里，
 * 这样适配器薄到只需真机确认「会不会抛错」这一件事。
 */

/** 一次编辑会话的 SFTP + stat 能力。`readStat` 由调用方接上 runCommand。 */
export type SftpFileOpsDeps = {
  sftp: SftpClient;
  /** 执行 `stat` 取 inode/nlink；模板不可用时返回 null。 */
  readStat: (path: string) => Promise<RemoteInode | null>;
  /** 按字节读取（实现方负责分块与上限）。 */
  read: (path: string) => Promise<Buffer>;
  /**
   * 临时文件后缀：带随机 UUID，同目录内不可能可预测地撞车。
   * 前缀用 `.` 开头，避免被用户的 glob（如 `*.conf`）扫到。
   */
  tempPrefix?: string;
};

function kindOf(attrs: any): RemoteAttrs["kind"] {
  // ssh2 的 SFTP attrs：isDirectory() / isSymbolicLink() / isFile()。
  if (typeof attrs.isSymbolicLink === "function" && attrs.isSymbolicLink()) return "symlink";
  if (typeof attrs.isDirectory === "function" && attrs.isDirectory()) return "directory";
  if (typeof attrs.isFile === "function" && attrs.isFile()) return "file";
  return "other";
}

export function createSftpFileOps(deps: SftpFileOpsDeps): RemoteFileOps {
  const { sftp, readStat, read } = deps;
  const tempPrefix = deps.tempPrefix ?? ".octssh-edit-";

  return {
    async lstat(path) {
      const attrs = await sftpLstat(sftp, path);
      if (!attrs) return null;
      return {
        mode: attrs.mode,
        uid: attrs.uid,
        gid: attrs.gid,
        size: attrs.size,
        atime: attrs.atime,
        mtime: attrs.mtime,
        kind: kindOf(attrs),
      };
    },

    async stat(path) {
      return readStat(path);
    },

    async readFile(path) {
      return read(path);
    },

    async createTempFile(dir) {
      const name = `${tempPrefix}${randomUUID()}.tmp`;
      const tempPath = dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
      // 用 `wx` 语义创建（0 字节），把「路径已被占用」这件事交给服务器裁决。
      await sftpWriteExclusive(sftp, tempPath, Buffer.alloc(0));
      return tempPath;
    },

    async writeFile(path, bytes) {
      // 覆盖写：`wx` 只用于最初那次创建，这里目标是刚建好的临时文件。
      // 不用 createWriteStream：它的 "close" 在错误路径上也可能先触发，
      // 分不清「写完」与「写一半就断了」。
      await new Promise<void>((resolve, reject) => {
        // ssh2 的 open 第二参是 flags 字符串（"w"/"wx"…），不是 { flags } 对象。
        sftp.open(path, "w", (openErr: any, handle: Buffer) => {
          if (openErr) return reject(openErr);
          let offset = 0;
          const writeNext = () => {
            if (offset >= bytes.length) {
              return sftp.close(handle, (closeErr: any) => (closeErr ? reject(closeErr) : resolve()));
            }
            const chunk = bytes.subarray(offset, Math.min(offset + 32 * 1024, bytes.length));
            sftp.write(handle, chunk, 0, chunk.length, offset, (writeErr: any) => {
              if (writeErr) return sftp.close(handle, () => reject(writeErr));
              offset += chunk.length;
              writeNext();
            });
          };
          writeNext();
        });
      });
    },

    async removeFile(path) {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(path, (err: any) => (err ? reject(err) : resolve()));
      });
    },

    async chmod(path, mode) {
      await sftpChmod(sftp, path, mode);
    },

    async chown(path, uid, gid) {
      await sftpChown(sftp, path, uid, gid);
    },

    async setTimes(path, atime, mtime) {
      await setTimes(sftp, path, atime, mtime);
    },

    async posixRename(from, to) {
      await posixRename(sftp, from, to);
    },
  };
}
