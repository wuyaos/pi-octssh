import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "../state/fs.ts";
import { getOctsshDir } from "../state/paths.ts";
import { withLock } from "../util/lockfile.ts";
import type { SshIdentity } from "./identity.ts";

/**
 * 项目级持久规则。
 *
 * 文件按 projectId 隔离，规则本身绑定真实端点（alias/host/port/user/跳板），
 * 因此 `ssh_config` 把别名重指向别处后，旧规则不会静默命中。
 */

/** 受管操作。取自现有真实入口，不含尚未实现的名字。 */
export const MANAGED_OPERATIONS = [
  "hosts",
  "machine-info",
  "exec",
  "exec-async",
  "upload",
  "upload-async",
  "download",
  "download-async",
  "session-get",
  "session-grep",
  "session-write-stdin",
  "session-cancel",
  "read",
  "edit",
] as const;

export type ManagedOperation = (typeof MANAGED_OPERATIONS)[number];

const RULES_FILE_VERSION = 1;

const identitySchema = z
  .object({
    alias: z.string().min(1),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    user: z.string().min(1),
    jump: z
      .object({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        user: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict();

export const ruleSchema = z
  .object({
    id: z.string().min(1),
    effect: z.enum(["allow", "deny", "ask"]),
    operation: z.enum(MANAGED_OPERATIONS),
    identity: identitySchema,
    /** 远端路径；不给 subtree 时按精确文件匹配。 */
    path: z
      .object({
        value: z.string().min(1),
        subtree: z.boolean(),
      })
      .strict()
      .optional(),
    /** 命令规则：按原始完整字符串匹配，授权不做前缀展开。 */
    command: z
      .object({
        value: z.string().min(1),
        match: z.enum(["exact", "subcommand"]).optional(),
        cwd: z.string().min(1).optional(),
        sudo: z.boolean().optional(),
      })
      .strict()
      .optional(),
    createdAt: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

export type ProjectRule = z.infer<typeof ruleSchema>;

const projectRulesFileSchema = z
  .object({
    version: z.literal(RULES_FILE_VERSION),
    projectId: z.string().min(1),
    rules: z.array(ruleSchema),
  })
  .strict();

export type ProjectRulesFile = z.infer<typeof projectRulesFileSchema>;

/**
 * 规则文件存在但不可解析。
 *
 * 调用方必须按拒绝处理：静默当成「没有规则」会让此前写入的 deny 全部失效，
 * 那是最危险的一种降级。
 */
export class RulesUnreadableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "RulesUnreadableError";
  }
}

export function getProjectRulesDir(baseDir?: string) {
  return path.join(baseDir ?? getOctsshDir(), "policy", "projects");
}

export function getProjectRulesPath(projectId: string, baseDir?: string) {
  return path.join(getProjectRulesDir(baseDir), `${projectId.replace(/[^a-zA-Z0-9._-]/g, "_")}.json`);
}

function getProjectRulesLockPath(projectId: string, baseDir?: string) {
  return `${getProjectRulesPath(projectId, baseDir)}.lock`;
}

export function loadProjectRules(projectId: string, baseDir?: string): ProjectRulesFile {
  const filePath = getProjectRulesPath(projectId, baseDir);

  let json: unknown;
  try {
    json = readJsonIfExistsSync<unknown>(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RulesUnreadableError(`Project rules are corrupt: ${filePath} (${message})`, { cause: error });
  }
  if (json === null) return { version: RULES_FILE_VERSION, projectId, rules: [] };

  const parsed = projectRulesFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new RulesUnreadableError(
      `Project rules are not readable: ${filePath} (${parsed.error.issues[0]?.message ?? "invalid format"})`,
    );
  }
  return parsed.data;
}

export function listRules(projectId: string, baseDir?: string): ProjectRule[] {
  return loadProjectRules(projectId, baseDir).rules;
}

/** 读-改-写整体持锁，避免两个 Pi 实例互相覆盖刚写入的 deny。 */
function mutateRules(
  projectId: string,
  baseDir: string | undefined,
  mutate: (rules: ProjectRule[]) => ProjectRule[],
): ProjectRule[] {
  return withLock(getProjectRulesLockPath(projectId, baseDir), () => {
    const current = loadProjectRules(projectId, baseDir);
    const rules = mutate(current.rules);
    const next: ProjectRulesFile = { version: RULES_FILE_VERSION, projectId, rules };
    atomicWriteFileSync(getProjectRulesPath(projectId, baseDir), JSON.stringify(next, null, 2) + "\n");
    return rules;
  });
}

export function saveProjectRules(projectId: string, rules: ProjectRule[], baseDir?: string): ProjectRule[] {
  const parsed = rules.map((rule) => ruleSchema.parse(rule));
  return mutateRules(projectId, baseDir, () => parsed);
}

export type NewRule = Omit<ProjectRule, "id" | "createdAt"> & { id?: string; createdAt?: string };

export function addRule(projectId: string, rule: NewRule, baseDir?: string): ProjectRule {
  const entry: ProjectRule = ruleSchema.parse({
    ...rule,
    id: rule.id ?? `rule-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: rule.createdAt ?? new Date().toISOString(),
  });
  mutateRules(projectId, baseDir, (rules) => [
    ...rules.filter((candidate) => candidate.id !== entry.id),
    entry,
  ]);
  return entry;
}

export function removeRule(projectId: string, ruleId: string, baseDir?: string): boolean {
  let removed = false;
  mutateRules(projectId, baseDir, (rules) => {
    const next = rules.filter((candidate) => candidate.id !== ruleId);
    removed = next.length !== rules.length;
    return next;
  });
  return removed;
}

/** 便捷构造：把 SshIdentity 收窄成规则里的身份字段（保留跳板）。 */
export function identityForRule(identity: SshIdentity) {
  return identitySchema.parse({
    alias: identity.alias,
    host: identity.host,
    port: identity.port,
    user: identity.user,
    ...(identity.jump ? { jump: identity.jump } : {}),
  });
}
