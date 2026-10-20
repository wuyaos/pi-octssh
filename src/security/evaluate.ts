import { matchesSubcommand } from "./commandShape.ts";
import type { SshIdentity } from "./identity.ts";
import {
  MANAGED_OPERATIONS,
  ruleSchema,
  RulesUnreadableError,
  loadProjectRules,
  type ManagedOperation,
  type ProjectRule,
} from "./rules.ts";

/**
 * 操作裁决（纯函数）。
 *
 * 顺序固定：内建硬禁止 → 项目 deny → 项目 ask → 项目 allow → 默认 ask
 * （ask 表示沿用调用方现有的确认流程）。deny 永远优先，因此一个错误的
 * allow 不会覆盖另一条 deny。
 */

export type Decision = "allow" | "deny" | "ask";

export type OperationRequest = {
  operation: ManagedOperation;
  identity: SshIdentity;
  /** 远端路径（read/edit/upload/download 使用）。 */
  path?: string;
  /** exec 使用：原始完整命令串 + 远端 cwd + 是否 sudo。 */
  command?: { value: string; cwd?: string; sudo?: boolean };
  /**
   * 内建硬禁止的判定结果。由调用方用现有的 `buildEffectiveSecurityConfig`
   * / `guardExecCommand` 算出后传入：这里不重复实现那份清单，避免两处漂移。
   */
  builtinBlock?: { reason: string; message: string };
};

export type EvaluationResult = {
  decision: Decision;
  reason: string;
  /** 命中的规则，供 UI 展示「为什么被拦/被放行」。 */
  rule?: ProjectRule;
};

/**
 * 操作等价类。
 *
 * `exec` 与 `exec-async`、`upload` 与 `upload-async`、`download` 与
 * `download-async` 是同一件事的两种执行形态（同步等待 / 后台继续）。
 * 规则匹配必须按族比较——否则一条 `exec` 的 deny 对 `exec-async` 完全不生效，
 * 模型只要换一个工具名就能绕开禁止。
 *
 * deny 与 allow 都必须按族：只对 deny 做族匹配会造出反过来的洞——
 * 用户以为「这个命令已允许」，换用异步形态却又要确认，于是他会选「始终允许」
 * 再写一条重复规则，而真正该阻止的操作仍然只在一种形态下被拦。
 */
export function operationFamily(operation: ManagedOperation): ManagedOperation {
  switch (operation) {
    case "exec-async":
      return "exec";
    case "upload-async":
      return "upload";
    case "download-async":
      return "download";
    default:
      return operation;
  }
}

function normalizeRemotePath(value: string): string {
  const collapsed = value.replace(/\/{2,}/g, "/");
  if (collapsed.length > 1) return collapsed.replace(/\/+$/, "");
  return collapsed;
}

/** 路径段边界匹配：`/app` 不能匹配 `/application`。 */
function pathMatches(rule: ProjectRule, requested: string | undefined): boolean {
  if (!rule.path) return false;
  if (requested === undefined) return false;

  const pattern = normalizeRemotePath(rule.path.value);
  const target = normalizeRemotePath(requested);

  if (!rule.path.subtree) return pattern === target;
  if (pattern === target) return true;
  return target.startsWith(`${pattern}/`);
}

function commandMatches(rule: ProjectRule, requested: OperationRequest["command"]): boolean {
  if (!rule.command) return false;
  if (!requested) return false;
  // 原始完整字符串匹配：不做前缀/通配授权，否则 `git status` 会顺带放行
  // `git status; rm -rf /`。
  if (rule.command.match === "subcommand") {
    if (!matchesSubcommand(rule.command.value, requested.value)) return false;
  } else if (rule.command.value !== requested.value) return false;
  if (rule.command.cwd !== undefined && rule.command.cwd !== requested.cwd) return false;
  if (rule.command.sudo !== undefined && rule.command.sudo !== (requested.sudo ?? false)) return false;
  return true;
}

function jumpMatches(a: SshIdentity["jump"], b: SshIdentity["jump"]): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.host === b.host && a.port === b.port && a.user === b.user;
}

/** 主机身份精确匹配：alias/host/port/user/跳板全部相等才算。 */
function identityMatches(rule: ProjectRule, requested: SshIdentity): boolean {
  return (
    rule.identity.alias === requested.alias &&
    rule.identity.host === requested.host &&
    rule.identity.port === requested.port &&
    rule.identity.user === requested.user &&
    jumpMatches(rule.identity.jump, requested.jump)
  );
}

function ruleApplies(rule: ProjectRule, req: OperationRequest): boolean {
  // 按族比较：族内互通（exec ↔ exec-async 等），跨族仍严格不等。
  if (operationFamily(rule.operation) !== operationFamily(req.operation)) return false;
  if (!identityMatches(rule, req.identity)) return false;

  const hasPath = rule.path !== undefined;
  const hasCommand = rule.command !== undefined;
  if (!hasPath && !hasCommand) {
    // 纯身份 + 操作规则：对整个操作生效。
    return true;
  }
  if (hasPath && !pathMatches(rule, req.path)) return false;
  if (hasCommand && !commandMatches(rule, req.command)) return false;
  return true;
}

const EFFECT_RANK: Record<Decision, number> = { deny: 3, ask: 2, allow: 1 };

export function evaluateOperation(req: OperationRequest, rules: readonly ProjectRule[]): EvaluationResult {
  if (req.builtinBlock) {
    return { decision: "deny", reason: `builtin:${req.builtinBlock.reason}` };
  }

  // 规则本身不合法时一律拒绝：一条坏规则不能变成「没有规则」。
  const valid: ProjectRule[] = [];
  for (const candidate of rules) {
    const parsed = ruleSchema.safeParse(candidate);
    if (!parsed.success) {
      return { decision: "deny", reason: "invalid_rule" };
    }
    valid.push(parsed.data);
  }

  let best: { rule: ProjectRule; decision: Decision } | undefined;
  for (const rule of valid) {
    if (!ruleApplies(rule, req)) continue;
    const decision = rule.effect as Decision;
    if (!best || EFFECT_RANK[decision] > EFFECT_RANK[best.decision]) {
      best = { rule, decision };
    }
  }

  if (best) {
    return {
      decision: best.decision,
      reason: best.decision === "deny" ? "project_deny" : best.decision === "ask" ? "project_ask" : "project_allow",
      rule: best.rule,
    };
  }

  // 无匹配：交给调用方沿用现有确认流程。
  return { decision: "ask", reason: "no_rule" };
}

/**
 * 从存储读取规则并裁决。规则文件不可读时按 deny 处理，
 * 不当作「没有规则」放行。
 */
export function evaluateForProject(
  projectId: string,
  req: OperationRequest,
  baseDir?: string,
): EvaluationResult {
  let rules: ProjectRule[];
  try {
    rules = loadProjectRules(projectId, baseDir).rules;
  } catch (error) {
    if (error instanceof RulesUnreadableError) {
      return { decision: "deny", reason: `rules_unreadable` };
    }
    throw error;
  }
  return evaluateOperation(req, rules);
}

/** 供调用方校验操作名：模型给的字符串必须落在这个集合里。 */
export function isManagedOperation(value: string): value is ManagedOperation {
  return (MANAGED_OPERATIONS as readonly string[]).includes(value);
}
