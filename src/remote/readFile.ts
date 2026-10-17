import type { RemoteFileOps, UnsupportedReason } from "./applyEdit.ts";
import { encodeStrongFingerprint, encodeWeakFingerprint } from "./fingerprint.ts";

/**
 * 远端文本读取。
 *
 * 与 `applyEdit` 同一套依赖注入：只依赖 `RemoteFileOps` 加上一个注入的
 * `statProbe`，因此行窗口、token 保证等级、各种拒绝分支都能离线验满。
 *
 * 两条硬性语义：
 * 1. `offset`/`limit` **只影响返回内容**，版本 token 永远覆盖整个文件——
 *    否则「只看了两行」会被误当成「整份文件没变」。
 * 2. 拿不到 inode/nlink 时返回弱 token（`v1w`）并附警告，而不是报错：
 *    读永远是安全的，只是不能用于 edit。
 */

export const DEFAULT_MAX_READ_BYTES = 2 * 1024 * 1024;

/** 探测哪套 `stat` 模板可用；`null` 表示都不可用。 */
export type StatProbe = (path: string) => Promise<{ inode: string; nlink: string } | null>;

export type ReadRemoteFileInput = {
  fileOps: Pick<RemoteFileOps, "lstat" | "readFile">;
  statProbe: StatProbe;
  path: string;
  /** 起始行，1 基。默认 1。 */
  offset?: number;
  /** 显示行数；0 表示只返回 token 与元信息，不返回正文内容。默认全部。 */
  limit?: number;
  maxBytes?: number;
};

export type ReadRejection = UnsupportedReason | "too_large" | "invalid_utf8" | "binary";

export type ReadRemoteFileResult =
  | {
      kind: "content";
      path: string;
      version: string;
      /** strong = v1i（含 inode/nlink），可用于 edit；weak = v1w，不能用于 edit。 */
      strength: "strong" | "weak";
      warnings: string[];
      text: string;
      totalLines: number;
      /** 实际展示的首行/末行；没有任何行被展示时为 null（不是 0，也不是 totalLines）。 */
      shownFrom: number | null;
      shownTo: number | null;
      truncated: boolean;
      bom: boolean;
      size: number;
    }
  | { kind: "rejected"; path: string; reason: ReadRejection; detail?: string };

function hasBom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * 严格 UTF-8 校验。与 editPlan 里同构（那里给偏移，这里只需要判定），
 * 保持两处行为一致：非法字节一律拒绝，绝不返回替换字符。
 */
function isValidUtf8(bytes: Buffer): boolean {
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    if (byte < 0x80) {
      i += 1;
      continue;
    }
    let continuation: number;
    let min: number;
    let codePoint: number;
    if ((byte & 0xe0) === 0xc0) {
      continuation = 1;
      min = 0x80;
      codePoint = byte & 0x1f;
    } else if ((byte & 0xf0) === 0xe0) {
      continuation = 2;
      min = 0x800;
      codePoint = byte & 0x0f;
    } else if ((byte & 0xf8) === 0xf0) {
      continuation = 3;
      min = 0x10000;
      codePoint = byte & 0x07;
    } else {
      return false;
    }
    if (i + continuation > bytes.length - 1) return false;
    for (let k = 1; k <= continuation; k += 1) {
      const next = bytes[i + k];
      if ((next & 0xc0) !== 0x80) return false;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min || codePoint > 0x10ffff) return false;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return false;
    i += continuation + 1;
  }
  return true;
}

export async function readRemoteFile(input: ReadRemoteFileInput): Promise<ReadRemoteFileResult> {
  const { fileOps, statProbe, path } = input;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_READ_BYTES;

  const attrs = await fileOps.lstat(path);
  if (!attrs) return { kind: "rejected", path, reason: "not_a_regular_file", detail: "file not found" };
  if (attrs.kind === "symlink") return { kind: "rejected", path, reason: "symlink" };
  if (attrs.kind !== "file") return { kind: "rejected", path, reason: "not_a_regular_file" };

  if (attrs.size > maxBytes) {
    return { kind: "rejected", path, reason: "too_large", detail: `${attrs.size} > ${maxBytes}` };
  }

  const bytes = await fileOps.readFile(path);
  if (bytes.length > maxBytes) {
    // 文件在 lstat 之后变大了：以实际读到的字节为准，不做截断读取
    // （截断的 token 会与整份文件不符）。
    return { kind: "rejected", path, reason: "too_large", detail: `${bytes.length} > ${maxBytes}` };
  }

  const nulAt = bytes.indexOf(0);
  if (nulAt !== -1) return { kind: "rejected", path, reason: "binary", detail: `NUL at byte ${nulAt}` };

  const bom = hasBom(bytes);
  const body = bom ? bytes.subarray(3) : bytes;
  if (!isValidUtf8(body)) return { kind: "rejected", path, reason: "invalid_utf8" };

  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);

  const warnings: string[] = [];
  const stat = await statProbe(path);
  let version: string;
  let strength: "strong" | "weak";
  if (stat) {
    strength = "strong";
    version = encodeStrongFingerprint({
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid,
      size: bytes.length,
      mtime: attrs.mtime,
      inode: stat.inode,
      nlink: stat.nlink,
    });
  } else {
    strength = "weak";
    version = encodeWeakFingerprint({
      mode: attrs.mode,
      uid: attrs.uid,
      gid: attrs.gid,
      size: bytes.length,
      mtime: attrs.mtime,
    });
    warnings.push(
      "The host does not support a usable `stat` template, so this version token only covers " +
        "SFTP attributes (mode/uid/gid/size/mtime) without inode or link count. " +
        "It cannot be used for edit: re-read the file before editing.",
    );
  }

  // 行窗口只裁剪返回内容；token 已在上面按整份文件算好。
  const lines = text.split("\n");
  // 末尾换行会产生一个空元素，把它算作行尾而不是多一行。
  const trailingNewline = lines.length > 0 && lines[lines.length - 1] === "";
  const totalLines = trailingNewline ? lines.length - 1 : lines.length;

  const offset = Math.max(1, input.offset ?? 1);
  const limit = input.limit === undefined ? undefined : Math.max(0, input.limit);

  let shownFrom: number | null = null;
  let shownTo: number | null = null;
  let shownText = "";
  let truncated = false;

  if (limit === 0) {
    // 明确表示「一行都没给」：0/0 会被读成「第 0 行」，null 才不会误读。
    shownFrom = null;
    shownTo = null;
    truncated = totalLines > 0;
    warnings.push(
      `No lines were returned because limit=0 (the file has ${totalLines} lines). The version token still covers the whole file.`,
    );
  } else if (offset > totalLines) {
    // offset 超尾：token 仍是整份文件的，但必须说清「什么都没展示」。
    shownFrom = null;
    shownTo = null;
    truncated = false;
    warnings.push(
      `offset=${offset} is past the end of the file (${totalLines} lines); no lines were returned. The version token still covers the whole file.`,
    );
  } else {
    const start = offset - 1;
    const endExclusive = limit === undefined ? totalLines : Math.min(totalLines, start + limit);
    shownFrom = offset;
    shownTo = endExclusive;
    shownText = lines.slice(start, endExclusive).join("\n");
    if (endExclusive > start) shownText += "\n";
    truncated = endExclusive < totalLines;
  }

  return {
    kind: "content",
    path,
    version,
    strength,
    warnings,
    text: shownText,
    totalLines,
    shownFrom,
    shownTo,
    truncated,
    bom,
    size: bytes.length,
  };
}
