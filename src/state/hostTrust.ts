import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.ts";
import { getOctsshDir } from "./paths.ts";

/**
 * 主机密钥信任表（插件自有，跨项目共享）。
 *
 * 与别名解耦：记录绑定 host + port + 服务器主机公钥指纹。别名重指向后
 * 指纹对不上，连接被阻止而不是静默信任。
 */

const TRUST_FILE_VERSION = 1;

export const hostTrustEntrySchema = z
  .object({
    // host:port —— 唯一记录键。
    key: z.string().min(1),
    alias: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    algorithm: z.string().min(1),
    fingerprintSha256: z.string().min(1),
    addedAt: z.string().min(1),
    source: z.literal("user-confirmed"),
  })
  .strict();

export type HostTrustEntry = z.infer<typeof hostTrustEntrySchema>;

const hostTrustFileSchema = z
  .object({
    version: z.literal(TRUST_FILE_VERSION),
    hosts: z.array(hostTrustEntrySchema),
  })
  .strict();

export type HostTrustFile = z.infer<typeof hostTrustFileSchema>;

/**
 * 信任文件不可解析时抛出：调用方必须视为「无法判断」并阻止连接，
 * 不能当作「没有任何记录」去弹确认，也不能静默重写成空表。
 */
export class TrustStoreUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TrustStoreUnreadableError";
  }
}

export function getHostTrustPath(baseDir?: string) {
  return path.join(baseDir ?? getOctsshDir(), "known-hosts.json");
}

export function hostTrustKey(host: string, port: number) {
  return `${host}:${port}`;
}

/**
 * 从 ssh2 `hostVerifier(key)` 拿到的原始公钥 blob 计算展示用指纹。
 *
 * blob 是 RFC 4253 公钥格式：首个 SSH string 是算法名，整体 sha256 后
 * base64（去 padding），与 `ssh-keygen -lf` 的输出逐字符一致。
 */
export function computeHostKeyFingerprint(rawKey: Buffer): { algorithm: string; fingerprintSha256: string } {
  if (rawKey.length < 4) throw new Error("host key blob is too short");
  const algorithmLength = rawKey.readUInt32BE(0);
  const algorithmEnd = 4 + algorithmLength;
  if (algorithmLength === 0 || algorithmEnd > rawKey.length) {
    throw new Error("host key blob is missing its algorithm name");
  }
  const algorithm = rawKey.toString("utf8", 4, algorithmEnd);
  const digest = crypto.createHash("sha256").update(rawKey).digest("base64").replace(/=+$/, "");
  return { algorithm, fingerprintSha256: `SHA256:${digest}` };
}

export function loadHostTrust(baseDir?: string): HostTrustFile {
  const filePath = getHostTrustPath(baseDir);
  let json: unknown;
  try {
    json = readJsonIfExistsSync<unknown>(filePath);
  } catch (error) {
    // 文件存在但不是合法 JSON：与「没有记录」必须区分开。
    const message = error instanceof Error ? error.message : String(error);
    throw new TrustStoreUnreadableError(`Host trust store is corrupt: ${filePath} (${message})`, { cause: error });
  }
  if (json === null) return { version: TRUST_FILE_VERSION, hosts: [] };

  const parsed = hostTrustFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new TrustStoreUnreadableError(
      `Host trust store is not readable: ${filePath} (${parsed.error.issues[0]?.message ?? "invalid format"})`,
    );
  }
  return parsed.data;
}

function saveHostTrust(file: HostTrustFile, baseDir?: string) {
  atomicWriteFileSync(getHostTrustPath(baseDir), JSON.stringify(file, null, 2) + "\n");
}

export type HostTrustCheck =
  | { status: "trusted"; entry: HostTrustEntry }
  | { status: "unknown" }
  | { status: "mismatch"; entry: HostTrustEntry };

/**
 * 判定顺序：先读表（读不出来就抛 TrustStoreUnreadableError），
 * 有记录比指纹，没记录才算 unknown。
 */
export function checkHostTrust(params: {
  host: string;
  port: number;
  fingerprintSha256: string;
  baseDir?: string;
}): HostTrustCheck {
  const file = loadHostTrust(params.baseDir);
  const key = hostTrustKey(params.host, params.port);
  const entry = file.hosts.find((candidate) => candidate.key === key);
  if (!entry) return { status: "unknown" };
  if (entry.fingerprintSha256 !== params.fingerprintSha256) return { status: "mismatch", entry };
  return { status: "trusted", entry };
}

export function addHostKeyTrust(
  params: {
    host: string;
    port: number;
    alias: string;
    algorithm: string;
    fingerprintSha256: string;
    baseDir?: string;
  },
): HostTrustEntry {
  const file = loadHostTrust(params.baseDir);
  const key = hostTrustKey(params.host, params.port);
  const entry: HostTrustEntry = {
    key,
    alias: params.alias,
    host: params.host,
    port: params.port,
    algorithm: params.algorithm,
    fingerprintSha256: params.fingerprintSha256,
    addedAt: new Date().toISOString(),
    source: "user-confirmed",
  };
  const hosts = [...file.hosts.filter((candidate) => candidate.key !== key), entry];
  saveHostTrust({ version: TRUST_FILE_VERSION, hosts }, params.baseDir);
  return entry;
}

export function listHostKeys(baseDir?: string): HostTrustEntry[] {
  return loadHostTrust(baseDir).hosts;
}

export function removeHostKey(key: string, baseDir?: string): boolean {
  const file = loadHostTrust(baseDir);
  const hosts = file.hosts.filter((candidate) => candidate.key !== key);
  if (hosts.length === file.hosts.length) return false;
  saveHostTrust({ version: TRUST_FILE_VERSION, hosts }, baseDir);
  return true;
}

/** `/octssh trust` 的命令行名：host:port 或仅 host（用默认端口补齐）。 */
export function normalizeTrustKey(raw: string, defaultPort = 22): string {
  const trimmed = raw.trim();
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return hostTrustKey(trimmed, defaultPort);
  const portText = trimmed.slice(colon + 1);
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return trimmed;
  return hostTrustKey(trimmed.slice(0, colon), port);
}
