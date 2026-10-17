import { quoteForSh } from "../ssh/shell.ts";

/**
 * 远端文件的不透明版本 token。
 *
 * 为什么分强弱两级：SFTP v3 的 `lstat` attrs 只有 mode/uid/gid/size/atime/mtime
 * ——**没有 inode、没有 nlink**。仅靠这些字段，两个内容不同但大小相同、时间戳被
 * 同步工具抹平的文件会得到相同 token，编辑就会覆盖别人的改动。真正的强度只能
 * 从远端 `stat` 拿 inode+nlink，因此：
 *
 *   v1i（强）= attrs 字段 + inode + nlink，可用于 edit
 *   v1w（弱）= 仅 attrs 字段，只用于展示/下载增量判断，**edit 必须拒绝**
 *
 * 编码是「版本前缀 + 有序字段」，解码时字段一个都不能少，任一字段改变即不相等。
 */

export type FingerprintStrength = "strong" | "weak";

export type FingerprintFields = {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  mtime: number;
  inode?: string;
  nlink?: string;
};

export type RemoteFingerprint = {
  version: "v1i" | "v1w";
  strength: FingerprintStrength;
  fields: FingerprintFields;
};

/** stat 模板：只有两套，因为模板里只需要 inode 与 nlink。 */
export type StatTemplate = "gnu" | "bsd";

export const STAT_TEMPLATES: Record<StatTemplate, { flag: string; format: string; separator: "|" }> = {
  // GNU coreutils（绝大多数 Linux）。
  gnu: { flag: "-c", format: "%i|%h", separator: "|" },
  // BSD/macOS。
  bsd: { flag: "-f", format: "%i|%l", separator: "|" },
};

export function buildStatCommand(template: StatTemplate, remotePath: string): string {
  const spec = STAT_TEMPLATES[template];
  // 路径只经 quoteForSh，且用 `--` 结束选项，避免以 `-` 开头的文件名被当成参数。
  return `stat ${spec.flag} ${quoteForSh(spec.format)} -- ${quoteForSh(remotePath)}`;
}

export type StatParseResult =
  | { ok: true; inode: string; nlink: string }
  | { ok: false; reason: "template_not_applicable" | "unparsable_field"; detail: string };

/**
 * 解析 stat 输出。
 *
 * 两种失败必须分开：模板不适用（BSD 的 `stat -c` 会报 illegal option）意味着
 * 应该换另一套模板；字段不可解析意味着输出格式和预期不符，换模板也没用。
 */
export function parseStatOutput(template: StatTemplate, stdout: string): StatParseResult {
  // 先看是不是「选项不认」：BSD 的 `stat -c` 会打印两行 usage 后失败，
  // 那种情况必须允许换另一套模板，而不是当成字段解析失败。
  if (/usage:|illegal option|invalid option/i.test(stdout)) {
    return {
      ok: false,
      reason: "template_not_applicable",
      detail: `stat ${template} template is not supported by this host`,
    };
  }

  // GNU `stat -c '%i|%h'` 在部分实现里会额外打印换行；只接受单行。
  const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length !== 1) {
    return { ok: false, reason: "unparsable_field", detail: `expected exactly one line, got ${lines.length}` };
  }
  const parts = lines[0].split(STAT_TEMPLATES[template].separator);
  if (parts.length !== 2) {
    return { ok: false, reason: "unparsable_field", detail: `expected 2 fields, got ${parts.length}` };
  }
  const [inode, nlink] = parts;
  if (!/^\d+$/.test(inode) || !/^\d+$/.test(nlink)) {
    return { ok: false, reason: "unparsable_field", detail: "non-numeric inode/nlink" };
  }
  return { ok: true, inode, nlink };
}

function encodeField(value: string | number): string {
  // `|` 与 `%` 都不出现在这些数值字段里；仍做一次转义以便未来扩展。
  return String(value).replace(/%/g, "%25").replace(/\|/g, "%7C");
}

function decodeField(value: string): string {
  return value.replace(/%7C/g, "|").replace(/%25/g, "%");
}

/** 强 token（含 inode/nlink）。缺任一字段就直接抛错：不能悄悄降级成弱 token。 */
export function encodeStrongFingerprint(fields: FingerprintFields): string {
  if (fields.inode === undefined || fields.nlink === undefined) {
    throw new Error("strong fingerprint requires inode and nlink");
  }
  const parts = [
    "v1i",
    encodeField(fields.mode),
    encodeField(fields.uid),
    encodeField(fields.gid),
    encodeField(fields.size),
    encodeField(fields.mtime),
    encodeField(fields.inode),
    encodeField(fields.nlink),
  ];
  return parts.join("|");
}

/** 弱 token（仅 SFTP attrs）。 */
export function encodeWeakFingerprint(fields: Omit<FingerprintFields, "inode" | "nlink">): string {
  const parts = [
    "v1w",
    encodeField(fields.mode),
    encodeField(fields.uid),
    encodeField(fields.gid),
    encodeField(fields.size),
    encodeField(fields.mtime),
  ];
  return parts.join("|");
}

export function decodeFingerprint(token: string): RemoteFingerprint | null {
  const parts = token.split("|");
  const [version] = parts;

  if (version === "v1i") {
    if (parts.length !== 8) return null;
    const [mode, uid, gid, size, mtime, inode, nlink] = parts.slice(1).map(decodeField);
    const numbers = [mode, uid, gid, size, mtime].map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) return null;
    return {
      version: "v1i",
      strength: "strong",
      fields: {
        mode: numbers[0],
        uid: numbers[1],
        gid: numbers[2],
        size: numbers[3],
        mtime: numbers[4],
        inode,
        nlink,
      },
    };
  }

  if (version === "v1w") {
    if (parts.length !== 6) return null;
    const [mode, uid, gid, size, mtime] = parts.slice(1).map(decodeField);
    const numbers = [mode, uid, gid, size, mtime].map(Number);
    if (!numbers.every((value) => Number.isFinite(value))) return null;
    return {
      version: "v1w",
      strength: "weak",
      fields: { mode: numbers[0], uid: numbers[1], gid: numbers[2], size: numbers[3], mtime: numbers[4] },
    };
  }

  return null;
}

/** edit 前的硬性检查：弱 token 不能证明「没人改过」，一律拒绝。 */
export function assertWritableFingerprint(token: string): RemoteFingerprint {
  const decoded = decodeFingerprint(token);
  if (!decoded) throw new Error("unrecognized version token");
  if (decoded.strength !== "strong") {
    throw new Error("weak fingerprint (attrs only) cannot authorize an edit; inode/nlink are unknown");
  }
  return decoded;
}

/**
 * stat 模板选择结果缓存：同一台主机只探测一次。`undefined` 表示尚未探测，
 * `null` 表示两套都不可用（该主机上 edit 不可用）。
 */
export type StatCapability = { template: StatTemplate | null };

export function nextTemplateToTry(tried: readonly StatTemplate[]): StatTemplate | null {
  for (const candidate of ["gnu", "bsd"] as const) {
    if (!tried.includes(candidate)) return candidate;
  }
  return null;
}
