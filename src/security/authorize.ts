import type { SshIdentity } from "./identity.ts";
import type { CommandGuardResult } from "./policy.ts";
import type { ManagedOperation, NewRule, ProjectRule } from "./rules.ts";
import type { OperationRequest } from "./evaluate.ts";

/**
 * 受管操作 ↔ 规则之间的映射。
 *
 * 两个方向都要精确：
 * - 请求方向（`*Request`）：把本次操作描述成裁决输入。
 * - 持久化方向（`*Rule`）：把本次操作描述成一条可以回放的规则。
 *
 * 刻意不重抄内建清单：`guardExecCommand` 的结果由调用方传入，这里只做
 * 「block → deny」的映射，避免两处策略漂移。
 */

/** 一次操作的可持久化范围；同时用于确认弹窗展示。 */
export type OperationScope = {
  operation: ManagedOperation;
  identity: SshIdentity;
  path?: { value: string; subtree: boolean };
  command?: { value: string; match?: "exact" | "subcommand"; cwd?: string; sudo?: boolean };
};

export function execRequest(params: {
  operation: Extract<ManagedOperation, "exec" | "exec-async">;
  identity: SshIdentity;
  command: string;
  cwd?: string;
  sudo?: boolean;
  guard?: CommandGuardResult;
}): OperationRequest {
  return {
    operation: params.operation,
    identity: params.identity,
    command: { value: params.command, cwd: params.cwd, sudo: params.sudo ?? false },
    builtinBlock: builtinBlockFromGuard(params.guard),
  };
}

/**
 * 命令规则的持久化形态：原始完整字符串 + 远端 cwd + sudo 条件。
 *
 * 不接受前缀——`git status` 的 allow 规则不能覆盖 `git status; rm -rf /`。
 */
export function execRule(
  scope: OperationScope,
  effect: ProjectRule["effect"],
  note?: string,
): NewRule {
  if (!scope.command) throw new Error("exec rule requires a command scope");
  return {
    effect,
    operation: scope.operation,
    identity: identityFields(scope.identity),
    command: {
      value: scope.command.value,
      ...(scope.command.match ? { match: scope.command.match } : {}),
      ...(scope.command.cwd !== undefined ? { cwd: scope.command.cwd } : {}),
      sudo: scope.command.sudo ?? false,
    },
    ...(note ? { note } : {}),
  };
}

export function fileRequest(params: {
  operation: Extract<
    ManagedOperation,
    "read" | "edit" | "upload" | "upload-async" | "download" | "download-async"
  >;
  identity: SshIdentity;
  remotePath: string;
}): OperationRequest {
  return {
    operation: params.operation,
    identity: params.identity,
    path: params.remotePath,
  };
}

/**
 * 文件规则的持久化形态：默认精确文件，目录子树必须显式指定。
 *
 * 默认值不能是子树——一次「允许这次上传」被记成目录级 allow，
 * 等于把那一整个目录永久开放。
 */
export function fileRule(
  scope: OperationScope,
  effect: ProjectRule["effect"],
  note?: string,
): NewRule {
  if (!scope.path) throw new Error("file rule requires a path scope");
  return {
    effect,
    operation: scope.operation,
    identity: identityFields(scope.identity),
    path: { value: scope.path.value, subtree: scope.path.subtree },
    ...(note ? { note } : {}),
  };
}

export function scopeRule(scope: OperationScope, effect: ProjectRule["effect"], note?: string): NewRule {
  if (scope.command) return execRule(scope, effect, note);
  if (scope.path) return fileRule(scope, effect, note);
  // 纯身份 + 操作：整台机器上的此类操作。
  return {
    effect,
    operation: scope.operation,
    identity: identityFields(scope.identity),
    ...(note ? { note } : {}),
  };
}

/** `guardExecCommand` 的 block → 内建硬禁止；needs_confirmation / allow 不构成硬禁止。 */
export function builtinBlockFromGuard(guard: CommandGuardResult | undefined): OperationRequest["builtinBlock"] {
  if (!guard || guard.action !== "block") return undefined;
  return { reason: guard.reason, message: guard.message };
}

/** 确认弹窗展示用：完整命令全文（不截断）、路径、身份与跳板。 */
export function describeScope(scope: OperationScope): string[] {
  const lines: string[] = [];
  const id = scope.identity;
  lines.push(`操作: ${scope.operation}`);
  lines.push(`主机: ${id.alias} → ${id.user}@${id.host}:${id.port}`);
  if (id.jump) lines.push(`跳板: ${id.jump.user}@${id.jump.host}:${id.jump.port}`);
  if (scope.command) {
    lines.push(`远端 cwd: ${scope.command.cwd ?? "(默认)"}`);
    lines.push(`sudo: ${scope.command.sudo ? "是" : "否"}`);
    lines.push(`命令全文:`);
    lines.push(scope.command.value);
  }
  if (scope.path) {
    lines.push(`路径: ${scope.path.value}${scope.path.subtree ? "（目录子树）" : "（精确文件）"}`);
  }
  return lines;
}

function identityFields(identity: SshIdentity) {
  return {
    alias: identity.alias,
    host: identity.host,
    port: identity.port,
    user: identity.user,
    ...(identity.jump ? { jump: identity.jump } : {}),
  };
}
