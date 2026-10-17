import { assertWritableFingerprint } from "./fingerprint.ts";

/**
 * 远端文本编辑的纯规划阶段。
 *
 * 这里只做「能不能改 + 改成什么字节」，不做 IO。所有拒绝都必须是显式的：
 * 猜位置或猜编码会让一次 edit 静默改坏别的行。
 */

/** 默认上限 2 MiB：再大的文件不适合整文件读-改-写往返。 */
export const DEFAULT_MAX_EDIT_BYTES = 2 * 1024 * 1024;

/** diff 行数与字节上限，避免把整份 1 万行文件回灌进模型上下文。 */
export const DEFAULT_MAX_DIFF_LINES = 60;
export const DEFAULT_MAX_DIFF_BYTES = 8 * 1024;

export type EditRejection =
  | { reason: "too_large"; size: number; limit: number }
  | { reason: "binary"; at: number }
  | { reason: "invalid_utf8"; at: number }
  | { reason: "empty_old_text" }
  | { reason: "no_match" }
  | { reason: "ambiguous_match"; count: number }
  | { reason: "version_mismatch"; expected: string; actual: string }
  | { reason: "weak_version"; version: string };

export type BoundedDiff = {
  lines: string[];
  truncated: boolean;
  /** 实际完整 diff 的行数（即使被截断）。 */
  totalLines: number;
};

export type EditPlan =
  | { ok: false; error: EditRejection }
  | {
      ok: true;
      bytes: Buffer;
      /** 在正文（BOM 之后）坐标系里的首次/末次影响偏移。 */
      firstChangedByte: number;
      lastChangedByteExclusive: number;
      bom: boolean;
      diff: BoundedDiff;
    };

export type PlanEditInput = {
  bytes: Buffer;
  /** 由 fingerprint.ts 产生的不透明 token；弱 token 会被拒绝。 */
  expectedVersion: string;
  /** 调用方已确认过的「当前版本」token。 */
  currentVersion: string;
  oldText: string;
  newText: string;
  maxBytes?: number;
};

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function hasBom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

/**
 * 严格 UTF-8 校验并给出首个非法字节偏移。
 *
 * TextDecoder 只知道「错了」，不给位置；逐字节二分尝试在 2 MiB 文件上是
 * O(n²)。这里直接按 UTF-8 的合法序列结构线性扫描一遍。
 */
function firstInvalidUtf8Offset(bytes: Buffer): number {
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
      return i;
    }

    if (i + continuation > bytes.length - 1) return i;
    for (let k = 1; k <= continuation; k += 1) {
      const next = bytes[i + k];
      if (next === undefined || (next & 0xc0) !== 0x80) return i;
      codePoint = (codePoint << 6) | (next & 0x3f);
    }
    if (codePoint < min) return i;
    if (codePoint > 0x10ffff) return i;
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) return i;

    i += continuation + 1;
  }
  return -1;
}

/** 严格 UTF-8 解码；非法序列返回首个出错位置而不是替换字符。 */
function decodeStrict(bytes: Buffer): { ok: true; text: string } | { ok: false; at: number } {
  const invalidAt = firstInvalidUtf8Offset(bytes);
  if (invalidAt !== -1) return { ok: false, at: invalidAt };
  return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
}

function findNul(bytes: Buffer): number {
  const index = bytes.indexOf(0);
  return index;
}

/**
 * 有界 diff：从影响区间向前后各取若干行，加上首末两侧的标记行。
 * 不做真正的 LCS——这里需要的只是「让人看懂改了什么」，
 * 而完整 diff 在 1 万行文件上会直接撑爆上下文。
 */
function boundedDiff(
  before: string,
  after: string,
  maxLines: number,
  maxBytes: number,
): BoundedDiff {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");

  // 找到首个与末尾不同的行索引。
  let start = 0;
  while (start < beforeLines.length && start < afterLines.length && beforeLines[start] === afterLines[start]) {
    start += 1;
  }
  let beforeEnd = beforeLines.length - 1;
  let afterEnd = afterLines.length - 1;
  while (beforeEnd >= start && afterEnd >= start && beforeLines[beforeEnd] === afterLines[afterEnd]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }

  const context = 3;
  const from = Math.max(0, start - context);
  const raw: string[] = [];
  for (let i = from; i < start; i += 1) raw.push(`  ${beforeLines[i]}`);
  for (let i = start; i <= beforeEnd; i += 1) raw.push(`- ${beforeLines[i]}`);
  for (let i = start; i <= afterEnd; i += 1) raw.push(`+ ${afterLines[i]}`);
  for (let i = beforeEnd + 1; i <= Math.min(beforeLines.length - 1, beforeEnd + context); i += 1) {
    raw.push(`  ${beforeLines[i]}`);
  }

  const totalLines = raw.length;
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  for (const line of raw) {
    const cost = Buffer.byteLength(line, "utf8") + 1;
    if (lines.length >= maxLines || bytes + cost > maxBytes) {
      truncated = true;
      break;
    }
    lines.push(line);
    bytes += cost;
  }
  if (truncated) lines.push(`… diff 已截断（共 ${totalLines} 行）`);

  return { lines, truncated, totalLines };
}

export function planEdit(input: PlanEditInput): EditPlan {
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_EDIT_BYTES;

  if (input.oldText.length === 0) return { ok: false, error: { reason: "empty_old_text" } };

  // 版本先判：拿错 token 时不该先读一遍大文件。
  try {
    assertWritableFingerprint(input.expectedVersion);
  } catch {
    // 弱 token 或无法解析：不允许 edit，因为无法证明文件没被别人改过。
    return { ok: false, error: { reason: "weak_version", version: input.expectedVersion.split("|")[0] ?? "" } };
  }
  if (input.expectedVersion !== input.currentVersion) {
    return {
      ok: false,
      error: { reason: "version_mismatch", expected: input.expectedVersion, actual: input.currentVersion },
    };
  }

  if (input.bytes.length > maxBytes) {
    return { ok: false, error: { reason: "too_large", size: input.bytes.length, limit: maxBytes } };
  }

  const nulAt = findNul(input.bytes);
  if (nulAt !== -1) return { ok: false, error: { reason: "binary", at: nulAt } };

  const bom = hasBom(input.bytes);
  const body = bom ? input.bytes.subarray(3) : input.bytes;

  const decoded = decodeStrict(body);
  if (!decoded.ok) return { ok: false, error: { reason: "invalid_utf8", at: decoded.at } };
  const text = decoded.text;

  // 匹配次数必须恰好 1：0 次说明 token 已过期或 oldText 写错；多次说明无法判断改哪一处。
  let count = 0;
  let firstIndex = -1;
  let index = text.indexOf(input.oldText);
  while (index !== -1) {
    count += 1;
    if (count === 1) firstIndex = index;
    if (count > 1) break;
    index = text.indexOf(input.oldText, index + 1);
  }
  if (count === 0) return { ok: false, error: { reason: "no_match" } };
  if (count > 1) return { ok: false, error: { reason: "ambiguous_match", count } };

  // 逐字节替换：只拼接被替换的那一段，其余字节原样搬运（CRLF/LF 不被规范化）。
  const beforeBytes = Buffer.from(text.slice(0, firstIndex), "utf8");
  const replacedBytes = Buffer.from(input.oldText, "utf8");
  const afterBytes = Buffer.from(text.slice(firstIndex + input.oldText.length), "utf8");
  const newBytes = Buffer.from(input.newText, "utf8");

  const rebuilt = Buffer.concat([beforeBytes, replacedBytes, afterBytes]);
  // 自检：除被替换段以外必须逐字节相同，否则说明解码/编码不是无损往返。
  if (!rebuilt.equals(body)) {
    throw new Error("edit plan violated byte-exactness (non-lossless UTF-8 round trip)");
  }

  const outBody = Buffer.concat([beforeBytes, newBytes, afterBytes]);
  const outBytes = bom ? Buffer.concat([BOM, outBody]) : outBody;

  const firstChangedByte = beforeBytes.length;
  const lastChangedByteExclusive = beforeBytes.length + newBytes.length;

  const diff = boundedDiff(text, outBody.toString("utf8"), DEFAULT_MAX_DIFF_LINES, DEFAULT_MAX_DIFF_BYTES);

  return {
    ok: true,
    bytes: outBytes,
    firstChangedByte,
    lastChangedByteExclusive,
    bom,
    diff,
  };
}
