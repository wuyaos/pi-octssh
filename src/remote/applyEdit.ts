import { Buffer } from "node:buffer";
import {
  DEFAULT_MAX_EDIT_BYTES,
  planEdit,
  type BoundedDiff,
} from "./editPlan.ts";
import {
  decodeFingerprint,
  encodeStrongFingerprint,
  type FingerprintFields,
} from "./fingerprint.ts";

/**
 * 远端文件写入编排。
 *
 * 只依赖 `RemoteFileOps` 这一个小接口，因此六种结果语义与操作顺序都能用
 * 假适配器离线验证；真适配器（sftpFileOps.ts）薄到只剩转发。
 *
 * **TOCTOU 说明（原样保留）**：最后一次核验到 rename 之间存在 TOCTOU 窗口，
 * 本实现**不声称**对外部写者的 CAS。第二次核验只能缩小窗口，不能消除它——
 * 真正的原子比较替换需要服务器端支持（SFTP v3 没有）。因此对并发写者，
 * 这里保证的是「我们不会在明显不匹配时强行覆盖」，不是「绝不会覆盖」。
 */

/** 远端文件属性。这里只描述编排需要的字段，不泄漏 ssh2 类型。 */
export type RemoteAttrs = {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
  /** 由 lstat 得到：符号链接 / 普通文件 / 目录等。 */
  kind: "file" | "directory" | "symlink" | "other";
};

/** inode 与硬链接数：只能来自远端 `stat`，SFTP v3 attrs 没有这两项。 */
export type RemoteInode = { inode: string; nlink: string };

/**
 * 编排依赖的全部远端能力。每个方法都只做一件事，不含判断——
 * 判断全部在 `applyEdit` 里，这样假适配器可以精确注入单点失败。
 */
export type RemoteFileOps = {
  /** 不跟随符号链接。返回 null 表示不存在。 */
  lstat(path: string): Promise<RemoteAttrs | null>;
  /** 取 inode/nlink；模板不可用时返回 null（编排据此判 unsupported）。 */
  stat(path: string): Promise<RemoteInode | null>;
  /** 按字节读取整个文件。 */
  readFile(path: string): Promise<Buffer>;
  /** 在同目录以 `wx` 独占创建临时文件，返回可用的临时路径。 */
  createTempFile(dir: string): Promise<string>;
  writeFile(path: string, bytes: Buffer): Promise<void>;
  removeFile(path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  setTimes(path: string, atime: number, mtime: number): Promise<void>;
  /** 原子替换；服务器不支持时抛 code === "POSIX_RENAME_UNSUPPORTED"。 */
  posixRename(from: string, to: string): Promise<void>;
};

export type ApplyEditResult =
  | {
      kind: "success";
      path: string;
      bytesWritten: number;
      diff: BoundedDiff;
      newVersion: string;
    }
  | {
      kind: "no_change";
      path: string;
      reason: "identical_text";
      /**
       * 恒为 true：`oldText === newText` 在建立连接、读取文件之前就返回了。
       * 字段显式存在，避免上层把 no_change 读成「刚核对过远端内容」。
       */
      remoteNotChecked: true;
      diff?: BoundedDiff;
    }
  | { kind: "conflict"; path: string; detail: string }
  | { kind: "unsupported"; path: string; reason: UnsupportedReason }
  | { kind: "not_written"; path: string; detail: string; tempRemoved: boolean }
  | {
      kind: "outcome_unknown";
      path: string;
      detail: string;
      /**
       * 是否**确实**删掉了临时文件。这里只会是 false 或「尝试过但删不到」：
       * rename 若已生效，临时文件本就不存在，删不到属正常，不能当作清理成功。
       */
      tempRemoved: false;
    }
  | { kind: "blocked"; path: string; detail: string }
  | { kind: "dry_run"; path: string; bytes: number; diff: BoundedDiff };

export type UnsupportedReason =
  | "not_found"
  | "not_a_regular_file"
  | "symlink"
  | "hard_linked"
  | "stat_template_unavailable"
  | "posix_rename_unsupported"
  | "chown_not_restorable";

export type ApplyEditInput = {
  fileOps: RemoteFileOps;
  path: string;
  /** 调用方持有的版本 token；弱 token 会被 planEdit 拒绝。 */
  expectedVersion: string;
  oldText: string;
  newText: string;
  dryRun?: boolean;
  maxBytes?: number;
};

function dirOf(remotePath: string): string {
  const index = remotePath.lastIndexOf("/");
  if (index <= 0) return "/";
  return remotePath.slice(0, index);
}

function sameFields(a: FingerprintFields, b: FingerprintFields): boolean {
  return (
    a.mode === b.mode &&
    a.uid === b.uid &&
    a.gid === b.gid &&
    a.size === b.size &&
    a.mtime === b.mtime &&
    a.inode === b.inode &&
    a.nlink === b.nlink
  );
}

/**
 * 取当前文件的强指纹。任一前置条件不满足都返回 unsupported：
 * 这些情况下一旦写入就可能改错对象（硬链接会连带改到别处，
 * 符号链接会写到目标之外），所以必须在建临时文件之前就停。
 */
async function readStrongFingerprint(
  fileOps: RemoteFileOps,
  path: string,
): Promise<
  | { ok: true; token: string; attrs: RemoteAttrs; inode: string; nlink: string }
  | { ok: false; reason: UnsupportedReason }
> {
  const attrs = await fileOps.lstat(path);
  // 路径不存在与「存在但不是普通文件」必须分开：前者用户多半是路径写错，
  // 后者是我们拒绝编辑（目录、设备等）。归成一类会让人无从下手。
  if (!attrs) return { ok: false, reason: "not_found" };
  if (attrs.kind === "symlink") return { ok: false, reason: "symlink" };
  if (attrs.kind !== "file") return { ok: false, reason: "not_a_regular_file" };

  const inode = await fileOps.stat(path);
  if (!inode) return { ok: false, reason: "stat_template_unavailable" };
  // nlink > 1：同一 inode 被多处引用，rename 只换了这一处路径，
  // 其他链接仍指向旧内容——用户看到的「改了」与实际情况不一致。
  if (Number(inode.nlink) > 1) return { ok: false, reason: "hard_linked" };

  return {
    ok: true,
    attrs,
    inode: inode.inode,
    nlink: inode.nlink,
    token: encodeStrongFingerprint({
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid,
      size: attrs.size,
      mtime: attrs.mtime,
      inode: inode.inode,
      nlink: inode.nlink,
    }),
  };
}

export async function applyEdit(input: ApplyEditInput): Promise<ApplyEditResult> {
  const { fileOps, path } = input;

  // 短路修复：内容相同就不该产生任何远端副作用（不建临时文件、不 rename、
  // 不报出虚假变动）。放在最前面，连指纹查询都省掉。
  if (input.oldText === input.newText) {
    return { kind: "no_change", path, reason: "identical_text", remoteNotChecked: true };
  }

  // 1) 取指纹
  const before = await readStrongFingerprint(fileOps, path);
  if (!before.ok) return { kind: "unsupported", path, reason: before.reason };

  // 2) 读
  const original = await fileOps.readFile(path);
  const currentToken = encodeStrongFingerprint({
    mode: before.attrs.mode,
    uid: before.attrs.uid,
    gid: before.attrs.gid,
    size: original.length,
    mtime: before.attrs.mtime,
    inode: before.inode,
    nlink: before.nlink,
  });

  // 3) 规划（版本不符会在这里被拒）
  const plan = planEdit({
    bytes: original,
    expectedVersion: input.expectedVersion,
    currentVersion: currentToken,
    oldText: input.oldText,
    newText: input.newText,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_EDIT_BYTES,
  });
  if (!plan.ok) {
    if (plan.error.reason === "version_mismatch") {
      return { kind: "conflict", path, detail: "version token did not match the current file" };
    }
    if (plan.error.reason === "weak_version") {
      return { kind: "unsupported", path, reason: "stat_template_unavailable" };
    }
    return { kind: "blocked", path, detail: describeRejection(plan.error) };
  }

  if (input.dryRun) {
    return { kind: "dry_run", path, bytes: plan.bytes.length, diff: plan.diff };
  }

  // 4) 建临时文件（同目录，保证 rename 不跨设备）
  const dir = dirOf(path);
  const tempPath = await fileOps.createTempFile(dir);

  /**
   * rename 一旦成功，目标文件就已经被替换了。
   *
   * 此后任何失败都**不能**说成「未写入」——那会让用户以为文件没变，
   * 而实际上新内容已经落盘。所有 post-rename 失败一律归 `outcome_unknown`。
   */
  let renamed = false;

  try {
    // 5) 写
    await fileOps.writeFile(tempPath, plan.bytes);

    // 6) 恢复属性。先 chown 再 chmod：chown 可能清掉 setuid/setgid 位，
    //    顺序反过来会让最终 mode 与期望不一致。
    try {
      await fileOps.chown(tempPath, before.attrs.uid, before.attrs.gid);
    } catch (error) {
      // 不能恢复属主就不能交付：新文件会是我们的 uid，语义上不等价。
      await safeRemove(fileOps, tempPath);
      return { kind: "unsupported", path, reason: "chown_not_restorable" };
    }
    await fileOps.chmod(tempPath, before.attrs.mode);
    // mtime 必须推进（用当前时间），否则调用方拿到的 token 会和原文件相同，
    // 下一次 edit 就会误判「没人改过」。
    const now = Math.floor(Date.now() / 1000);
    await fileOps.setTimes(tempPath, now, now);

    // 7) 再次核验目标指纹：缩小（不能消除）TOCTOU 窗口。
    const recheck = await readStrongFingerprint(fileOps, path);
    if (!recheck.ok) {
      await safeRemove(fileOps, tempPath);
      return { kind: "unsupported", path, reason: recheck.reason };
    }
    const beforeFields = decodeFingerprint(before.token)?.fields;
    const recheckFields = decodeFingerprint(recheck.token)?.fields;
    if (!beforeFields || !recheckFields || !sameFields(beforeFields, recheckFields)) {
      await safeRemove(fileOps, tempPath);
      return { kind: "conflict", path, detail: "file changed between read and rename" };
    }

    // 8) 原子替换。这一步之后临时文件已不是我们的了：
    //    即便抛错也不去删（可能已经 rename 成功），因此归类 outcome_unknown。
    try {
      await fileOps.posixRename(tempPath, path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === "POSIX_RENAME_UNSUPPORTED") {
        await safeRemove(fileOps, tempPath);
        return { kind: "unsupported", path, reason: "posix_rename_unsupported" };
      }
      // rename 调用本身失败或结果未知（断连）：不盲重试。
      // 尽力清一次临时文件；删不到不代表失败（可能 rename 已生效）。
      await bestEffortRemove(fileOps, tempPath);
      return {
        kind: "outcome_unknown",
        path,
        detail: String((error as Error)?.message ?? error),
        tempRemoved: false,
      };
    }

    // 到这里目标文件已被替换：后续失败都属于「结果未知」而不是「未写入」。
    renamed = true;

    // 9) 回读核验：确认落盘内容与我们写入的完全一致。
    const written = await fileOps.readFile(path);
    if (!written.equals(plan.bytes)) {
      // 已替换但内容不符：可能是并发写者，也可能是服务器改写了字节。
      // 无论哪种，我们都不能声称成功，也不能声称「没写」。
      return {
        kind: "outcome_unknown",
        path,
        detail: "renamed, but read-back bytes differ from the bytes we wrote",
        tempRemoved: false,
      };
    }

    const after = await readStrongFingerprint(fileOps, path);
    return {
      kind: "success",
      path,
      bytesWritten: plan.bytes.length,
      diff: plan.diff,
      newVersion: after.ok ? after.token : currentToken,
    };
  } catch (error) {
    const detail = String((error as Error)?.message ?? error);
    if (renamed) {
      // 目标已被替换：不能说「未写入」，也不留下可能已无意义的临时文件清理承诺。
      await bestEffortRemove(fileOps, tempPath);
      return {
        kind: "outcome_unknown",
        path,
        detail: `renamed, then post-write verification failed: ${detail}`,
        tempRemoved: false,
      };
    }
    // 改名之前的失败：目标文件未被改动，清理临时文件即可。
    const removed = await safeRemove(fileOps, tempPath);
    return { kind: "not_written", path, detail, tempRemoved: removed };
  }
}

/**
 * rename 结果未知时**尽力**清理临时文件。
 *
 * 绝不影响返回值：若 rename 其实已成功，临时文件已不存在，删不到是正常情况；
 * 若删不掉（连接断了/权限），也只是残骸，不该把结果升级成另一种语义。
 * 返回 false 一律表示「没能确认删掉」，不表示「删掉了」。
 */
async function bestEffortRemove(fileOps: RemoteFileOps, tempPath: string): Promise<void> {
  try {
    await fileOps.removeFile(tempPath);
  } catch {
    // 结果未知场景下，清不掉是预期内的一种结局。
  }
}

async function safeRemove(fileOps: RemoteFileOps, tempPath: string): Promise<boolean> {
  try {
    await fileOps.removeFile(tempPath);
    return true;
  } catch {
    return false;
  }
}

function describeRejection(error: { reason: string }): string {
  switch (error.reason) {
    case "too_large":
      return "file exceeds the edit size limit";
    case "binary":
      return "file contains NUL bytes; refusing to treat it as text";
    case "invalid_utf8":
      return "file is not valid UTF-8";
    case "empty_old_text":
      return "oldText must not be empty";
    case "no_match":
      return "oldText does not occur in the file";
    case "ambiguous_match":
      return "oldText occurs more than once; refusing to guess which occurrence to replace";
    default:
      return `edit rejected: ${error.reason}`;
  }
}
