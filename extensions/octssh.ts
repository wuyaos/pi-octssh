import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  createOctsshRuntime,
  type Authorization,
  type AuthorizationRequest,
  type OctsshRuntime,
} from "../src/index.ts";
import type { HostKeyConfirm } from "../src/ssh/hostVerifier.ts";
import { projectDisplayPath, projectIdFromCwd } from "../src/security/project.ts";
import { SessionApproval } from "../src/security/sessionApproval.ts";
import { resolveIdentity } from "../src/ssh/machine.ts";
import { displayIdentity } from "../src/security/identity.ts";
import { subcommandScope } from "../src/security/commandShape.ts";
import { addRule, removeRule, listRules } from "../src/security/rules.ts";
import { describeScope, scopeRule, type OperationScope } from "../src/security/authorize.ts";
import { SecretPrompt } from "../src/tui/secretPrompt.ts";
import { formatDuration, renderDetails } from "../src/tui/toolDisplay.ts";
import { selectConfirmation, explainFailure } from "../src/tui/feedback.ts";
import { completeOctsshArguments } from "../src/tui/commandCompletion.ts";
import {
  clearAllCredentials,
  credentialCacheSize,
  type CredentialPrompt,
  type CredentialRequest,
} from "../src/ssh/credentials.ts";
import { listHostKeys, normalizeTrustKey, removeHostKey } from "../src/state/hostTrust.ts";
import { loadConfig, saveConfig } from "../src/state/config.ts";
import type { NotificationPayload } from "../src/tasks/delivery.ts";
import { listSessionIds } from "../src/state/cleanup.ts";
import { getOctsshDir } from "../src/state/paths.ts";
import { loadSession } from "../src/state/sessions.ts";

type ResultKind = "success" | "blocked" | "error";

type OctsshDetails = {
  operation: string;
  kind: ResultKind;
  summary: string;
  data?: unknown;
};

type ToolResult = AgentToolResult<OctsshDetails>;

type ConfirmationResult = {
  kind: "needs_confirmation";
  authorizationRequest: AuthorizationRequest;
};

const sessionApproval = new SessionApproval();
let approvalGeneration = 0;
let runtime: OctsshRuntime | null = null;
let runtimeStartedAt: number | null = null;
let lastRuntimeError: string | null = null;

/**
 * 连接期需要 UI 上下文才能弹主机密钥确认。工厂拿不到，只能在
 * session_start 与工具调用里记录最近一次 ctx。
 */
let activeContext: ExtensionContext | null = null;

/**
 * 首次连接未知主机时的人工确认。
 *
 * 只有 TUI 且有 UI 才提供：RPC 转发不了自定义组件；无 UI 场景返回
 * undefined，让 verifier 走 fail-closed 分支。
 */
const hostKeyConfirm = (): HostKeyConfirm | undefined => {
  const ctx = activeContext;
  if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return undefined;
  return async ({ identity, host, port, algorithm, fingerprintSha256 }) => {
    const message = [
      `主机: ${identity.alias} → ${host}:${port}`,
      `用户: ${identity.user}`,
      identity.jump
        ? `跳板: ${identity.jump.user}@${identity.jump.host}:${identity.jump.port}`
        : null,
      `密钥类型: ${algorithm}`,
      `指纹: ${fingerprintSha256}`,
      "",
      "请与本机 `ssh-keygen -lf` 的输出逐字符比对后再决定。",
    ]
      .filter((line) => line !== null)
      .join("\n");
    return ctx.ui.confirm("OctSSH 主机密钥指纹确认", message);
  };
};

/**
 * 凭据遮罩输入。
 *
 * `ctx.ui.custom()` 是唯一能自造遮罩组件的地方；RPC 转发不了自定义组件，
 * 无 UI 模式没有终端。所以只有 TUI + hasUI 才注入，其余情况返回 undefined，
 * 让连接层报 AUTH_REQUIRES_UI 而不是静默地拿空密码去试。
 */
const credentialPrompt = (): CredentialPrompt | undefined => {
  const ctx = activeContext;
  if (!ctx || !ctx.hasUI || ctx.mode !== "tui") return undefined;

  return async (request: CredentialRequest) => {
    const kindLabel = request.kind === "password" ? "密码" : "私钥口令";
    const [userAtHost, aliasPart] = request.label.split(" (");
    const title = `OctSSH 需要${kindLabel}`;
    const subtitle = aliasPart
      ? `${userAtHost} · 别名 ${aliasPart.replace(/\)$/, "")}`
      : userAtHost;

    return ctx.ui.custom<string | undefined>(
      (tui, theme, _keybindings, done) => {
        const prompt = new SecretPrompt({
          title,
          subtitle,
          // Theme 的方法需要绑定实例；这里只转出组件用到的那两个。
          theme: { fg: (color, text) => theme.fg(color as any, text), bold: (text) => theme.bold(text) },
          done: (value) => {
            done(value);
            tui.requestRender();
          },
        });
        return prompt;
      },
      { overlay: true },
    );
  };
};

/**
 * 项目身份只从宿主上下文推导。
 *
 * 工具参数里没有、也不会有 projectId：模型能选的只有「哪台主机做什么」。
 */
/**
 * 任务通知：只在会话空闲时开新回合。
 *
 * `ctx.isIdle()` 为上才 `sendMessage({triggerTurn:true})`；忙时返回 busy 交给
 * 队列，绝不打断正在进行的回合。自动唤醒可关闭（config.taskNotify.autoWake），
 * 关闭后仍然记账、仍然进面板，只是不再开新回合。
 */
let notifyContext: ExtensionContext | null = null;
/** `sendMessage` 在 ExtensionAPI 上（ctx 上没有），因此要留一个 pi 引用。 */
let notifyApi: ExtensionAPI | null = null;
let notifyConfig: { autoWake: boolean; sweepIntervalSeconds: number } = {
  autoWake: true,
  sweepIntervalSeconds: 120,
};

function refreshNotifyConfig() {
  try {
    const cfg = loadConfig(getOctsshDir());
    notifyConfig = {
      autoWake: cfg.taskNotify.autoWake,
      sweepIntervalSeconds: cfg.taskNotify.sweepIntervalSeconds,
    };
  } catch {
    // 配置读不出来时保持上一次的取值，不要因此关掉通知。
  }
}

function notifyPayloadText(payload: NotificationPayload): string {
  const parts = [`OctSSH 任务 ${payload.taskId} ${payload.state}`, `主机 ${payload.machine}`];
  if (payload.exitCode !== undefined) parts.push(`退出码 ${payload.exitCode}`);
  if (payload.durationMs !== undefined) parts.push(`耗时 ${Math.round(payload.durationMs / 1000)}s`);
  return parts.join(" · ");
}

function wireNotifyHooks(rt: OctsshRuntime) {
  rt.setNotifyHooks({
    channel: () => {
      const ctx = notifyContext;
      if (!ctx) return "no_session";
      // 自动唤醒关闭时视为「没有可用通道」：事件继续排队，不丢弃。
      if (!notifyConfig.autoWake) return "no_session";
      if (ctx.mode !== "tui" && !ctx.hasUI) return "no_session";
      return ctx.isIdle() ? "ready" : "busy";
    },
    sink: (payload) => {
      const ctx = notifyContext;
      const api = notifyApi;
      if (!ctx || !api) return;
      // 二次确认：通道契约要求只在空闲时开新回合。
      if (!notifyConfig.autoWake || !ctx.isIdle()) return;
      api.sendMessage(
        {
          customType: "octssh-task",
          content: notifyPayloadText(payload),
          display: true,
          details: payload,
        },
        { triggerTurn: true },
      );
    },
  });
}

let sweepTimer: NodeJS.Timeout | null = null;

function stopSweepTimer() {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}

function startSweepTimer() {
  stopSweepTimer();
  const intervalMs = Math.max(30, notifyConfig.sweepIntervalSeconds) * 1000;
  sweepTimer = setInterval(() => {
    void runSweepOnce();
  }, intervalMs);
  // 定时器不应阻止进程退出。
  sweepTimer.unref?.();
}

const sweepingRuntimes = new WeakSet<OctsshRuntime>();
async function runSweepOnce(): Promise<void> {
  const rt = runtime;
  const ctx = notifyContext;
  if (!rt || !ctx || sweepingRuntimes.has(rt)) return;
  sweepingRuntimes.add(rt);
  try {
    const pid = projectId(ctx);
    const summary = await rt.sweepTasks({
      projectId: pid,
      hasSessionForProject: (want) => want === pid,
    });
    if (runtime !== rt || notifyContext !== ctx) return;
    if (summary.storeCorruptReported) {
      // 只提示一次：反复扫描不应该反复打扰。
      ctx.ui.notify(
        "OctSSH: 任务记录文件损坏，已改名保留并从空白继续；本次可能缺少历史通知记录。",
        "warning",
      );
    }
    if (summary.eventsProduced > 0 || summary.queued.length > 0) {
      await rt.flushTaskNotifications();
    }
  } catch {
    // 扫描失败留给下一轮；不向上抛，避免打断用户。
  } finally {
    sweepingRuntimes.delete(rt);
  }
}

const projectIdCache = new Map<string, string | undefined>();

function projectId(ctx: ExtensionContext): string | undefined {
  const cwd = (ctx as { cwd?: string }).cwd;
  if (!cwd) return undefined;
  // 每个 cwd 只在首次求值时跑一次 git rev-parse；之后工作树根不会变。
  if (projectIdCache.has(cwd)) return projectIdCache.get(cwd);
  let value: string | undefined;
  try {
    value = projectIdFromCwd(cwd);
  } catch {
    value = undefined;
  }
  projectIdCache.set(cwd, value);
  return value;
}

function getRuntime(): OctsshRuntime {
  if (!runtime) throw new Error("OctSSH runtime 尚未启动。请执行 /reload 或重启 Pi 会话。");
  return runtime;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function isConfirmation(value: unknown): value is ConfirmationResult {
  const record = asRecord(value);
  return record?.kind === "needs_confirmation" && typeof record.authorizationRequest === "object";
}

function failureMessage(value: unknown): string {
  const record = asRecord(value);
  if (!record) return stringify(value);
  const message = record.message ?? record.error ?? record.reason;
  return typeof message === "string" ? message : stringify(value);
}

function makeResult(
  operation: string,
  data: unknown,
  summary: string,
  kind: ResultKind = "success",
): ToolResult {
  return {
    content: [{ type: "text", text: `${summary}\n${stringify(data)}` }],
    details: { operation, kind, summary, data },
    ...(kind === "success" ? {} : { isError: true }),
  };
}

/**
 * read 的结果里 warnings 必须让模型看见：弱 token 会让 edit 被拒，
 * 提前说清楚比让模型撞一次失败更省时间。
 */
function finishRead(operation: string, result: unknown, summary: string): ToolResult {
  const record = asRecord(result);
  const warnings = Array.isArray(record?.warnings) ? (record.warnings as string[]) : [];
  const text = [summary, ...warnings.map((w) => `⚠ ${w}`), stringify(result)].join("\n");
  return {
    content: [{ type: "text", text }],
    details: { operation, kind: "success", summary, data: result },
  };
}

/**
 * edit 的结果原样传递，按 kind 映射到 blocked / success / error。
 * `outcome_unknown` 既不是成功也不是失败：必须让模型重新读取核对，
 * 所以归到 error 且明确禁止重试。
 */
function finishEdit(operation: string, result: unknown): ToolResult {
  const record = asRecord(result);
  const kind = String(record?.kind ?? "");

  switch (kind) {
    case "success":
      return makeResult(operation, result, `已写入 ${String(record?.bytesWritten)} 字节：${String(record?.path)}`);
    case "no_change":
      return makeResult(
        operation,
        result,
        "内容未变化（oldText 与 newText 相同），未做任何远端写操作。注意：此结果在建立连接之前就判定了，未连接远端核对文件当前内容。",
      );
    case "dry_run":
      return makeResult(operation, result, "dryRun：仅返回计划，未写入。");
    case "conflict":
      return makeResult(operation, result, `写入被拒：文件已变化（${String(record?.detail)}）。请重新读取后再试。`, "blocked");
    case "unsupported":
      return makeResult(operation, result, `无法安全编辑：${String(record?.reason)}`, "blocked");
    case "not_written":
      return makeResult(operation, result, record?.tempRemoved
        ? "目标未改动，临时文件已清理。"
        : "目标未改动；临时文件可能残留。", "blocked");
    case "blocked":
      return makeResult(operation, result, `已阻止：${String(record?.detail ?? "")}`, "blocked");
    case "outcome_unknown":
      return makeResult(
        operation,
        result,
        "写入结果未知（rename 期间失败，可能已写入也可能没有）。已尝试清理临时文件，但不保证成功。" +
          "不要重试：请先用 octssh_read 重新读取并核对内容。",
        "error",
      );
    default:
      return makeResult(operation, result, `编辑返回未知状态：${kind || "(empty)"}`, "error");
  }
}

function makeError(operation: string, error: unknown, kind: "blocked" | "error" = "error"): ToolResult {
  const message = explainFailure(operation, error);
  const reason = error instanceof Error ? error.message : "";
  // 简短诊断标识用于关联取消来源；自由文本可能含命令或凭据，不回传。
  const diagnostic = /^[a-z][a-z0-9_-]{0,63}-(?:cancelled|aborted)$/.test(reason) ? reason : undefined;
  return makeResult(operation, { kind, message, diagnostic }, message, kind);
}

function confirmationMessage(request: AuthorizationRequest): string {
  const { preview } = request;
  const lines = [
    request.message,
    "",
    `操作类型: ${request.operation}`,
    `影响数量: ${preview.total}${preview.truncated ? "（预览已截断）" : ""}`,
  ];
  if (preview.sample.length > 0) {
    lines.push("", "预览:", ...preview.sample.slice(0, 10).map((item) => `• ${item}`));
  }
  lines.push("", "永久规则仅用于当前项目与此主机。");
  return lines.join("\n");
}

const CONFIRM_CHOICES = {
  once: "允许一次",
  always: "永久允许",
  never: "永久禁止",
  reject: "拒绝",
} as const;

/**
 * 四选项确认。
 *
 * 「始终」类选择必须先落盘再继续：否则一旦后续执行失败，用户以为已经记住的
 * 决定不会生效，下次仍会被问——或者更糟，用户以为已被禁止的操作仍然能跑。
 */
async function withConfirmation(
  operation: string,
  ctx: ExtensionContext,
  projectId: string | undefined,
  run: (authorization?: Authorization) => Promise<unknown>,
  signal?: AbortSignal,
): Promise<ToolResult | unknown> {
  signal?.throwIfAborted();
  let result = await run();

  // 上传冲突可能在用户确认期间发生变化；若 Core 重新要求确认，展示新预览。
  for (let attempt = 0; isConfirmation(result) && attempt < 3; attempt += 1) {
    const request = result.authorizationRequest;
    if (request.scope && sessionApproval.allows(projectId, request.scope.identity)) {
      signal?.throwIfAborted();
      result = await run(getRuntime().authorize(request));
      continue;
    }
    if (!ctx.hasUI || ctx.mode !== "tui") {
      return makeResult(
        operation,
        { kind: "blocked", reason: "confirmation_ui_unavailable" },
        "该操作需要人工确认，但当前运行模式没有可用的确认界面，已拒绝执行。",
        "blocked",
      );
    }

    const scope = request.scope;
    const canPersist = !!projectId && !!scope && request.allowPermanent !== false;
    const options = [
      CONFIRM_CHOICES.once,
      ...(canPersist ? [CONFIRM_CHOICES.always, CONFIRM_CHOICES.never] : []),
      CONFIRM_CHOICES.reject,
    ];

    const body = [confirmationMessage(request)];
    if (scope) {
      body.push("", "匹配范围:", ...describeScope(scope));
    } else {
      body.push("", "匹配范围: 本次请求（无法持久化为规则）");
    }
    if (!canPersist && projectId) {
      body.push("", "本次涉及范围过大或不完整，不提供「始终」选项。");
    }
    // 命令规则的精确匹配语义必须提前说清：用户常以为「始终允许 rm -rf /data」
    // 会挡住这一类删除命令，实际只认这一行原文。
    if (scope?.command) {
      body.push(
        "",
        "默认只记住完整命令；选择永久允许后，可为支持的命令改选子命令范围。",
      );
    }

    const preview = request.preview;
    const shortBody = [`影响：${preview.total}${preview.truncated ? "（预览截断）" : ""}`, scope?.command?.value ?? preview.sample[0] ?? request.message].join("\n");
    const choice = await selectConfirmation(ctx, `确认 ${operation} · ${scope?.identity.alias ?? "远端"}`, shortBody, options, signal, body.join("\n"));
    signal?.throwIfAborted();

    if (choice === CONFIRM_CHOICES.never) {
      if (projectId && scope) {
        try {
          addRule(projectId, scopeRule(scope, "deny", `denied at ${new Date().toISOString()}`));
        } catch (error) {
          return makeError(operation, error, "blocked");
        }
      }
      return makeResult(
        operation,
        { kind: "blocked", reason: "project_deny_saved" },
        "已为本项目写入禁止规则，本次未执行。",
        "blocked",
      );
    }

    if (choice !== CONFIRM_CHOICES.once && choice !== CONFIRM_CHOICES.always) {
      return makeResult(
        operation,
        { kind: "blocked", reason: "user_rejected" },
        "用户拒绝了危险操作，未执行任何更改。",
        "blocked",
      );
    }

    if (choice === CONFIRM_CHOICES.always) {
      if (!projectId || !scope) {
        return makeResult(
          operation,
          { kind: "blocked", reason: "rule_scope_unavailable" },
          "缺少项目身份或规则范围，无法写入永久规则；已中止。",
          "blocked",
        );
      }
      try {
        let savedScope = scope;
        const subcommand = scope.command && subcommandScope(scope.command.value);
        if (subcommand && scope.command) {
          const exact = "仅此完整命令";
          const family = `${subcommand} *（参数可变）`;
          const selected = await ctx.ui.select("永久允许 · 当前项目\n子命令授权包含该动作的所有参数；不包含组合 shell。", [exact, family, "取消"], { signal });
          signal?.throwIfAborted();
          if (selected !== exact && selected !== family) return makeError(operation, "已取消授权。", "blocked");
          if (selected === family) savedScope = { ...scope, command: { ...scope.command, value: subcommand, match: "subcommand" } };
        }
        addRule(projectId, scopeRule(savedScope, "allow", `allowed at ${new Date().toISOString()}`));
      } catch (error) {
        return makeError(operation, error, "blocked");
      }
    }

    let authorization: Authorization;
    try {
      authorization = getRuntime().authorize(request);
    } catch (error) {
      return makeError(operation, error, "blocked");
    }
    signal?.throwIfAborted();
    result = await run(authorization);
  }

  if (isConfirmation(result)) {
    return makeResult(
      operation,
      { kind: "blocked", reason: "confirmation_changed_repeatedly" },
      "操作预览连续变化，已停止执行。请检查远端状态后重试。",
      "blocked",
    );
  }
  return result;
}

function finish(operation: string, value: unknown, successSummary: string): ToolResult {
  const record = asRecord(value);
  const kind = record?.kind;
  if (kind === "blocked") return makeResult(operation, value, failureMessage(value), "blocked");
  if (kind === "error") return makeError(operation, record?.message ?? record?.error ?? record?.reason);
  if (operation === "exec" && typeof record?.exitCode === "number" && record.exitCode !== 0) {
    return makeResult(operation, value, `命令退出码 ${record.exitCode}。请检查输出；前序步骤可能已执行，勿盲目重试。`, "error");
  }
  return makeResult(operation, value, successSummary);
}

/* 结果正文的按类型渲染在 src/tui/toolDisplay.ts（纯字符串、可离线验证）。 */

function renderResult(result: ToolResult, expanded: boolean, theme: any) {
  const details = result.details as { operation?: string; kind: string; summary: string; data?: unknown } | undefined;
  if (!details) {
    const content = result.content[0];
    return new Text(content?.type === "text" ? content.text : "", 0, 0);
  }
  const hasStderr = details.operation === "exec" && !!asRecord(details.data)?.stderr;
  const color = details.kind === "success" ? (hasStderr ? "warning" : "success") : details.kind === "blocked" ? "warning" : "error";
  const prefix = details.kind === "success" ? (hasStderr ? "⚠ " : "✓ ") : details.kind === "blocked" ? "⚠ " : "✗ ";
  const head = theme.fg(color, prefix) + theme.fg("muted", details.summary);
  const body = renderDetails(details.operation, details.data, theme, expanded);
  return new Text(body.length > 0 ? `${head}\n${body.join("\n")}` : head, 0, 0);
}

function countRunningSessions(): number {
  try {
    return listSessionIds(getOctsshDir()).reduce((count, id) => {
      const session = loadSession(id, getOctsshDir());
      return count + (session?.status === "running" ? 1 : 0);
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * `/octssh trust` — 列出信任记录，或用 `forget <host:port>` 移除一条。
 *
 * forget 是密钥合法轮换后的唯一出路：verify 侧对 mismatch 一律阻止，
 * 不提供「仍然继续」。
 */
async function handleTrustCommand(argv: string[], ctx: ExtensionContext) {
  let entries;
  try {
    entries = listHostKeys();
  } catch (error) {
    ctx.ui.notify(`OctSSH: 信任表不可读，已阻止使用 — ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  if (argv[0] === "forget") {
    const raw = argv[1];
    if (!raw) {
      ctx.ui.notify("用法: /octssh trust forget <host:port>", "warning");
      return;
    }
    const key = normalizeTrustKey(raw, 22);
    if (!removeHostKey(key)) {
      ctx.ui.notify(`OctSSH: 信任表里没有 ${key}`, "warning");
      return;
    }
    ctx.ui.notify(`OctSSH: 已移除 ${key} 的主机密钥信任；下次连接会重新确认指纹。`, "info");
    return;
  }

  if (entries.length === 0) {
    ctx.ui.notify("OctSSH: 暂无主机密钥信任记录。", "info");
    return;
  }

  const lines = entries.map((entry) =>
    `${entry.key}  ${entry.algorithm}  ${entry.fingerprintSha256}  (${entry.alias}, ${entry.addedAt})`,
  );
  ctx.ui.notify(`OctSSH 主机密钥信任 (${entries.length}):\n${lines.join("\n")}`, "info");
}

/**
 * `/octssh tasks` — 任务面板。
 *
 * 按需打开，不做常驻刷新；取消动作一律回到 runtime（走既有裁决），
 * 不在面板里直接杀远端进程。
 */
async function handleTasksCommand(argv: string[], ctx: ExtensionContext) {
  if (argv[0] === "wake") {
    const want = argv[1];
    const cfg = loadConfig(getOctsshDir());
    if (want !== "on" && want !== "off") {
      ctx.ui.notify(
        `OctSSH: 自动唤醒当前为 ${cfg.taskNotify.autoWake ? "开启" : "关闭"}。用法: /octssh tasks wake on|off`,
        "info",
      );
      return;
    }
    saveConfig({ ...cfg, taskNotify: { ...cfg.taskNotify, autoWake: want === "on" } }, getOctsshDir());
    refreshNotifyConfig();
    ctx.ui.notify(
      want === "on"
        ? "OctSSH: 已开启自动唤醒（仅在会话空闲时开新回合）。"
        : "OctSSH: 已关闭自动唤醒；任务完成仍会记录并可在面板查看，但不会自动开启新回合。",
      "info",
    );
    return;
  }

  const rt = getRuntime();
  const pid = projectId(ctx);
  let scope: "project" | "all" = "project";

  for (;;) {
    const listing = rt.listTasks({ projectId: pid, includeAllProjects: scope === "all" });
    const status = rt.taskStoreStatus();

    if (status.storeCorrupt) {
      ctx.ui.notify(
        `OctSSH: 任务记录损坏，已保留原文件（${status.corruptFiles.map((f) => f.renamedTo).join(", ")}）。`,
        "warning",
      );
    }

    if (listing.tasks.length === 0) {
      ctx.ui.notify(
        scope === "project"
          ? "OctSSH: 当前项目暂无任务记录。"
          : "OctSSH: 暂无任务记录（所有项目）。",
        "info",
      );
      return;
    }

    const options = [
      scope === "project" ? "显示全部项目" : "只看当前项目",
      ...listing.tasks.map((task) => {
        const delivered = task.emittedEventId ? "已通知" : "未通知";
        return `${task.state.padEnd(12)} ${task.taskId} · ${task.machine} · ${delivered}`;
      }),
      "关闭",
    ];

    const picked = await ctx.ui.select(
      [
        `OctSSH 任务（${scope === "project" ? "当前项目" : "全部项目"}，${listing.tasks.length} 条）`,
        "",
        ...(listing.notAwakened.length
          ? ["未唤醒:", ...listing.notAwakened.map((item) => `  ${item.taskId}: ${item.reason}`), ""]
          : []),
      ].join("\n"),
      options,
    );
    if (picked === undefined || picked === "关闭") return;
    if (picked === "显示全部项目") {
      scope = "all";
      continue;
    }
    if (picked === "只看当前项目") {
      scope = "project";
      continue;
    }

    const index = options.indexOf(picked) - 1;
    const task = listing.tasks[index];
    if (!task) continue;

    const action = await ctx.ui.select(
      [
        `任务 ${task.taskId}`,
        `状态: ${task.state}`,
        `主机: ${task.machine}`,
        `项目: ${task.projectId ?? "(未知)"}`,
        `退出码: ${task.exitCode ?? "(无)"}`,
        `通知: ${task.emittedEventId ? "已投递" : "未投递"}`,
      ].join("\n"),
      ["查看日志", ...(task.state === "running" || task.state === "cancelling" ? ["取消任务"] : []), "返回"],
    );
    if (action === undefined || action === "返回") continue;

    if (action === "查看日志") {
      const info = (await rt.getSession(task.taskId, 60, pid)) as Record<string, unknown>;
      const text = [String(info?.stdout_tail ?? info?.error ?? info?.reason ?? JSON.stringify(info))].join("\n");
      const shown = text.length > 8000 ? `${text.slice(0, 8000)}\n… 已截断` : text;
      ctx.ui.notify(`OctSSH 日志 ${task.taskId}\n${shown}`, "info");
      continue;
    }

    if (action === "取消任务") {
      // 取消走 runtime（内部经项目规则裁决），不在这里直接操作远端进程。
      const result = (await withConfirmation("session-cancel", ctx, pid, (authorization?: Authorization) =>
        rt.cancelSession(task.taskId, undefined, pid, authorization),
      )) as Record<string, unknown>;
      if (result?.kind === "blocked") {
        ctx.ui.notify(`OctSSH: 取消被阻止 — ${String(result.message ?? result.reason ?? "")}`, "warning");
      } else {
        ctx.ui.notify(`OctSSH: 已请求取消 ${task.taskId}。`, "info");
      }
    }
  }
}

/**
 * `/octssh permissions` — 查看/移除当前项目规则。
 *
 * 这是唯一能改规则的入口，且只能由人触发：模型既看不到它，也无法构造
 * 规则写入调用（`addRule` 只在用户选择「始终」时由本文件调用）。
 */
async function handlePermissionsCommand(argv: string[], ctx: ExtensionContext) {
  const pid = projectId(ctx);
  if (!pid) {
    ctx.ui.notify("OctSSH: 无法确定当前项目身份（缺少工作目录），项目规则不可用。", "warning");
    return;
  }

  if (argv[0] === "remove") {
    const id = argv[1];
    if (!id) {
      ctx.ui.notify("用法: /octssh permissions remove <rule-id>", "warning");
      return;
    }
    let removed = false;
    try {
      removed = removeRule(pid, id);
    } catch (error) {
      ctx.ui.notify(`OctSSH: 规则文件不可读，未做修改 — ${error instanceof Error ? error.message : String(error)}`, "error");
      return;
    }
    ctx.ui.notify(removed ? `OctSSH: 已移除规则 ${id}。` : `OctSSH: 没有这条规则 (${id})。`, removed ? "info" : "warning");
    return;
  }

  let rules;
  try {
    rules = listRules(pid);
  } catch (error) {
    ctx.ui.notify(`OctSSH: 规则文件不可读，已按拒绝处理 — ${error instanceof Error ? error.message : String(error)}`, "error");
    return;
  }

  const where = projectDisplayPath((ctx as { cwd?: string }).cwd ?? ".");
  if (rules.length === 0) {
    ctx.ui.notify(`OctSSH: ${where} 暂无项目规则。`, "info");
    return;
  }

  const lines = rules.map((rule) => {
    const scopeParts = [
      rule.identity.alias + " → " + `${rule.identity.user}@${rule.identity.host}:${rule.identity.port}`,
      rule.identity.jump ? `via ${rule.identity.jump.user}@${rule.identity.jump.host}:${rule.identity.jump.port}` : null,
      rule.path ? `${rule.path.value}${rule.path.subtree ? "（子树）" : ""}` : null,
      rule.command ? `$ ${rule.command.value}${rule.command.match === "subcommand" ? " *" : ""}` : null,
      rule.command?.cwd ? `cwd=${rule.command.cwd}` : null,
      rule.command?.sudo ? "sudo" : null,
    ].filter(Boolean);
    return `[${rule.id}] ${rule.effect} ${rule.operation} · ${scopeParts.join(" · ")}`;
  });
  ctx.ui.notify(`OctSSH 项目规则 (${rules.length}) — ${where}\n${lines.join("\n")}`, "info");
}

export default function octsshExtension(pi: ExtensionAPI) {
  notifyApi = pi;
  const hostsSchema = Type.Object({
    machine: Type.Optional(Type.String({ description: "ssh_config 中的主机名；省略时列出全部主机" })),
    refresh: Type.Optional(Type.Boolean({ description: "是否连接主机刷新扩展信息" })),
    target: Type.Optional(Type.Array(Type.String(), { description: "列主机时需要返回的缓存字段" })),
  });

  pi.registerTool({
    name: "octssh_hosts",
    label: "OctSSH Hosts",
    description: "列出本地 ssh_config 中配置的主机，或读取/刷新指定主机的系统信息。",
    promptSnippet: "列出 SSH 主机或查询远端主机信息",
    parameters: hostsSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      try {
        const rt = getRuntime();
        const result = params.machine
          ? await rt.machineInfo(params.machine, params.refresh ?? false, signal)
          : await rt.listHosts(params.target);
        return finish("hosts", result, params.machine ? `已读取 ${params.machine} 的主机信息` : "已列出 SSH 主机");
      } catch (error) {
        return makeError("hosts", error);
      }
    },
    renderCall(args, theme) {
      const target = args.machine ? ` ${theme.fg("accent", args.machine)}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("octssh hosts"))}${target}`, 0, 0);
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  const execSchema = Type.Object({
    machine: Type.String({ description: "ssh_config 中的主机名" }),
    command: Type.String({ description: "要在远端执行的 shell 命令" }),
    mode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async")], { description: "同步等待，或在远端后台异步运行（有 screen 用 screen，否则用 nohup）；默认 sync" })),
    sudo: Type.Optional(Type.Boolean({ description: "是否通过 passwordless sudo 执行" })),
    timeoutSeconds: Type.Optional(Type.Integer({ minimum: 1, maximum: 3600, description: "同步命令等待秒数，默认 60；长任务用 async" })),
  });

  pi.registerTool({
    name: "octssh_exec",
    label: "OctSSH Exec",
    description: "在指定 SSH 主机执行命令。支持同步执行、远端后台异步任务（有 screen 用 screen，否则自动用 nohup）与 passwordless sudo；危险命令由用户在 Pi 界面人工确认。",
    promptSnippet: "在远端 SSH 主机执行命令",
    parameters: execSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      try {
        const rt = getRuntime();
        const isAsync = params.mode === "async";
        const operation = isAsync ? "exec-async" : "exec";
        const result = await withConfirmation(operation, ctx, projectId(ctx), (authorization: Authorization | undefined) =>
          isAsync
            ? rt.execAsync({ machine: params.machine, command: params.command, sudo: params.sudo, projectId: projectId(ctx), signal, authorization })
            : rt.exec({ machine: params.machine, command: params.command, sudo: params.sudo, projectId: projectId(ctx), signal, authorization, timeoutSeconds: params.timeoutSeconds }),
          signal,
        );
        if (asRecord(result)?.details) return result as ToolResult;
        const record = asRecord(result);
        const sessionId = record?.session_id ?? record?.sessionId;
        const summary = isAsync
          ? `已在 ${params.machine} 启动远端任务${sessionId ? `（${String(sessionId)}）` : ""}`
          : `${params.machine} 命令返回 · 退出码 ${String(record?.exitCode ?? "未知")}${record?.stderr ? " · 含 stderr，请检查" : ""}`;
        return finish(operation, result, summary);
      } catch (error) {
        return makeError(params.mode === "async" ? "exec-async" : "exec", error);
      }
    },
    renderCall(args, theme) {
      const command = args.command.length > 100 ? `${args.command.slice(0, 97)}...` : args.command;
      const mode = args.mode === "async" ? " async" : "";
      const sudo = args.sudo ? " sudo" : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("octssh exec"))} ${theme.fg("accent", args.machine)}${theme.fg("muted", `${mode}${sudo}`)}\n${theme.fg("dim", command)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  const transferSchema = Type.Object({
    machine: Type.String({ description: "ssh_config 中的主机名" }),
    direction: Type.Union([Type.Literal("upload"), Type.Literal("download")], { description: "上传到远端或下载到本地" }),
    localPath: Type.String({ description: "本地文件或目录路径" }),
    remotePath: Type.String({ description: "远端文件或目录路径" }),
    async: Type.Optional(Type.Boolean({ description: "是否在 Pi 进程内异步传输；默认 false" })),
  });

  pi.registerTool({
    name: "octssh_transfer",
    label: "OctSSH Transfer",
    description: "通过 SFTP 上传或下载文件/目录。上传覆盖由用户在 Pi 界面人工确认；下载不会覆盖本地文件。",
    promptSnippet: "在本地与 SSH 主机之间传输文件",
    parameters: transferSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      const operation = `${params.direction}${params.async ? "-async" : ""}`;
      try {
        const rt = getRuntime();
        const pid = projectId(ctx);
        const run = (authorization?: Authorization) => {
          if (params.direction === "upload") {
            return params.async
              ? rt.uploadAsync({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, projectId: pid, signal, authorization })
              : rt.upload({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, projectId: pid, signal, authorization });
          }
          return params.async
            ? rt.downloadAsync({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, projectId: pid, signal, authorization })
            : rt.download({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, projectId: pid, signal, authorization });
        };
        // 上传与下载都可能在远端/本地产生副作用，统一走确认流程：
        // 命中项目 ask 时同样会被问一次（runtime 内部返回 needs_confirmation）。
        const result = await withConfirmation(operation, ctx, pid, run, signal);
        if (asRecord(result)?.details) return result as ToolResult;
        const record = asRecord(result);
        const sessionId = record?.session_id ?? record?.sessionId;
        const summary = params.async
          ? `已启动 ${params.direction} 任务${sessionId ? `（${String(sessionId)}）` : ""}`
          : `${params.direction === "upload" ? "上传" : "下载"}完成`;
        return finish(operation, result, summary);
      } catch (error) {
        return makeError(operation, error);
      }
    },
    renderCall(args, theme) {
      const arrow = args.direction === "upload" ? "→" : "←";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("octssh transfer"))} ${theme.fg("accent", args.machine)} ${theme.fg("muted", `${args.direction}${args.async ? " async" : ""}`)}\n${theme.fg("dim", `${args.localPath} ${arrow} ${args.remotePath}`)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  const sessionSchema = Type.Object({
    action: Type.Union([Type.Literal("get"), Type.Literal("grep"), Type.Literal("write-stdin"), Type.Literal("cancel")]),
    sessionId: Type.String({ description: "远端异步任务或异步传输的 session id" }),
    lines: Type.Optional(Type.Number({ description: "get 时返回的日志尾部行数" })),
    pattern: Type.Optional(Type.String({ description: "grep 时使用的扩展正则" })),
    maxMatches: Type.Optional(Type.Number({ description: "grep 最大匹配数" })),
    contextLines: Type.Optional(Type.Number({ description: "grep 匹配上下文行数" })),
    data: Type.Optional(Type.String({ description: "write-stdin 写入的数据" })),
    appendNewline: Type.Optional(Type.Boolean({ description: "write-stdin 是否追加换行；默认 true" })),
    signal: Type.Optional(Type.String({ description: "cancel 使用的信号；默认 TERM" })),
  });

  // 远端文本读写。schema 里没有 projectId：项目身份只由宿主从 ctx.cwd 推导。
  const readSchema = Type.Object({
    machine: Type.String({ description: "ssh_config 中的主机名" }),
    path: Type.String({ description: "远端文件的绝对路径" }),
    offset: Type.Optional(Type.Number({ description: "起始行（1 基），只影响返回内容" })),
    limit: Type.Optional(Type.Number({ description: "显示行数，只影响返回内容；版本 token 始终覆盖整个文件" })),
  });

  pi.registerTool({
    name: "octssh_read",
    label: "OctSSH Read",
    description:
      "读取远端文本文件。返回整份文件的版本 token（可用于 octssh_edit）、总行数与行窗口；符号链接、非普通文件、非 UTF-8、超过 2 MiB 一律拒绝。",
    promptSnippet: "读取远端文本文件",
    parameters: readSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      try {
        const rt = getRuntime();
        const pid = projectId(ctx);
        // 命中项目 ask 时 readFile 会返回 needs_confirmation，因此同样要走确认流程。
        const result = await withConfirmation("read", ctx, pid, (authorization?: Authorization) =>
          rt.readFile({
            machine: params.machine,
            path: params.path,
            offset: params.offset,
            limit: params.limit,
            projectId: pid,
            authorization,
            signal,
          }),
          signal,
        );
        if (asRecord(result)?.details) return result as ToolResult;
        const record = asRecord(result);
        if (record?.kind === "blocked") {
          return makeResult("read", result, `已阻止：${String(record.message ?? record.reason ?? "")}`, "blocked");
        }
        if (record?.kind === "rejected") {
          return makeResult("read", result, `读取被拒绝：${String(record.reason)}`, "blocked");
        }
        const warnings = Array.isArray(record?.warnings) ? (record.warnings as string[]) : [];
        const window = record?.shownFrom == null || record?.shownTo == null
          ? `未返回正文 / 共 ${String(record?.totalLines)} 行`
          : `${String(record.shownFrom)}-${String(record.shownTo)} / ${String(record?.totalLines)} 行`;
        const summary = `已读取 ${params.path}（${window}）` +
          (warnings.length ? "（弱版本 token，不能用于 edit）" : "");
        return finishRead("read", result, summary);
      } catch (error) {
        return makeError("read", error);
      }
    },
    renderCall(args, theme) {
      const window = args.offset || args.limit ? theme.fg("muted", ` ${args.offset ?? 1}${args.limit ? `+${args.limit}` : "+"}`) : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("octssh read"))} ${theme.fg("accent", args.machine)}${window}\n${theme.fg("dim", args.path)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  const editSchema = Type.Object({
    machine: Type.String({ description: "ssh_config 中的主机名" }),
    path: Type.String({ description: "远端文件的绝对路径" }),
    expectedVersion: Type.String({ description: "octssh_read 返回的版本 token；强 token（v1i）才能编辑" }),
    oldText: Type.String({ description: "要被替换的原文，必须在文件中恰好出现一次" }),
    newText: Type.String({ description: "替换后的文本" }),
    dryRun: Type.Optional(Type.Boolean({ description: "只返回计划与 diff，不写入" })),
  });

  pi.registerTool({
    name: "octssh_edit",
    label: "OctSSH Edit",
    description:
      "对远端文本文件做逐字节精确替换。必须带 octssh_read 返回的强版本 token；文件已变化则拒绝（conflict）。不提供前缀/正则匹配，同一原文出现多次时拒绝。",
    promptSnippet: "精确编辑远端文本文件",
    parameters: editSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      const pid = projectId(ctx);
      try {
        const rt = getRuntime();
        const result = await withConfirmation("edit", ctx, pid, (authorization: Authorization | undefined) =>
          rt.editFile({
            machine: params.machine,
            path: params.path,
            expectedVersion: params.expectedVersion,
            oldText: params.oldText,
            newText: params.newText,
            dryRun: params.dryRun,
            projectId: pid,
            signal,
            authorization,
          }),
          signal,
        );
        if (asRecord(result)?.details) return result as ToolResult;
        return finishEdit("edit", result);
      } catch (error) {
        return makeError("edit", error);
      }
    },
    renderCall(args, theme) {
      const oldText = typeof args.oldText === "string" ? (args.oldText.length > 60 ? `${args.oldText.slice(0, 57)}...` : args.oldText) : "";
      const dryRun = args.dryRun ? theme.fg("muted", " dryRun") : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("octssh edit"))} ${theme.fg("accent", args.machine)}${dryRun}\n${theme.fg("dim", args.path)}${oldText ? `\n${theme.fg("dim", `- ${oldText}`)}` : ""}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  pi.registerTool({
    name: "octssh_session",
    label: "OctSSH Session",
    description: "管理 OctSSH 异步任务：查询状态与日志、搜索日志、写入 stdin、取消任务。",
    promptSnippet: "查询或管理 OctSSH 远端异步任务",
    parameters: sessionSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      activeContext = ctx;
      try {
        const rt = getRuntime();
        let result: unknown;
        switch (params.action) {
          case "get":
            result = await rt.getSession(params.sessionId, params.lines, projectId(ctx), signal);
            break;
          case "grep":
            if (!params.pattern) return makeError("session-grep", "grep 操作必须提供 pattern");
            result = await rt.grepSession(params.sessionId, params.pattern, {
              maxMatches: params.maxMatches,
              contextLines: params.contextLines,
            }, projectId(ctx), signal);
            break;
          case "write-stdin":
            if (params.data === undefined) return makeError("session-write-stdin", "write-stdin 操作必须提供 data");
            // 有副作用：命中项目 ask 时要弹确认，因此走 withConfirmation。
            result = await withConfirmation("session-write-stdin", ctx, projectId(ctx), (authorization?: Authorization) =>
              rt.writeStdin(params.sessionId, params.data as string, { appendNewline: params.appendNewline }, projectId(ctx), authorization, signal),
              signal,
            );
            break;
          case "cancel":
            result = await withConfirmation("session-cancel", ctx, projectId(ctx), (authorization?: Authorization) =>
              rt.cancelSession(params.sessionId, params.signal, projectId(ctx), authorization, signal),
              signal,
            );
            break;
        }
        return finish(`session-${params.action}`, result, `session ${params.sessionId}: ${params.action} 完成`);
      } catch (error) {
        return makeError(`session-${params.action}`, error);
      }
    },
    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", theme.bold("octssh session"))} ${theme.fg("muted", args.action)} ${theme.fg("accent", args.sessionId)}`,
        0,
        0,
      );
    },
    renderResult(result, options, theme) {
      return renderResult(result as ToolResult, options.expanded, theme);
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      sessionApproval.clear();
      approvalGeneration++;
      ctx.ui.setStatus("octssh-approval", undefined);
      activeContext = ctx;
      notifyContext = ctx;
      if (runtime) await runtime.shutdown();
      runtime = createOctsshRuntime({ hostKeyConfirm, credentialPrompt });
      refreshNotifyConfig();
      wireNotifyHooks(runtime);
      runtime.start();
      startSweepTimer();
      runtimeStartedAt = Date.now();
      lastRuntimeError = null;
      ctx.ui.setStatus("octssh", ctx.ui.theme.fg("accent", "OctSSH"));
    } catch (error) {
      runtime = null;
      runtimeStartedAt = null;
      lastRuntimeError = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`OctSSH 启动失败: ${lastRuntimeError}`, "error");
    }
  });

  pi.on("session_shutdown", async () => {
    sessionApproval.clear();
    approvalGeneration++;
    activeContext?.ui.setStatus("octssh-approval", undefined);
    activeContext = null;
    notifyContext = null;
    stopSweepTimer();
    const current = runtime;
    runtime = null;
    runtimeStartedAt = null;
    if (current) await current.shutdown();
  });

  pi.registerCommand("octssh", {
    description:
      "查看状态；`/octssh allow-all <主机> [on|off]` 本会话免确认；`/octssh trust [forget <host:port>]` 管理主机密钥信任；`/octssh permissions [remove <id>]` 管理本项目规则；`/octssh tasks [wake on|off]` 查看任务并控制自动唤醒；`/octssh credentials clear` 清除内存中的密码/口令",
    getArgumentCompletions: completeOctsshArguments,
    handler: async (args, ctx) => {
      const argv = (args ?? "").trim().split(/\s+/).filter(Boolean);
      if (argv[0] === "allow-all") {
        const pid = projectId(ctx);
        const machine = argv[1];
        const action = argv[2] ?? "on";
        if (!pid || !machine || !["on", "off"].includes(action)) {
          ctx.ui.notify("用法：/octssh allow-all <主机> [on|off]", "warning");
          return;
        }
        if (action === "off") {
          sessionApproval.disable(pid, machine);
        } else {
          if (!ctx.hasUI || ctx.mode !== "tui") {
            ctx.ui.notify("请在交互界面开启免确认。", "warning");
            return;
          }
          const generation = approvalGeneration;
          try {
            const identity = resolveIdentity(machine);
            const accepted = await ctx.ui.confirm("开启本会话免确认？",
              `${projectDisplayPath(ctx.cwd)}\n${displayIdentity(identity)}\n包含删除、覆盖、sudo 等操作。仍保留 deny、硬禁止、主机密钥和版本校验。\n会话结束或重载后失效。`);
            if (!accepted || generation !== approvalGeneration) return;
            sessionApproval.enable(pid, identity);
          } catch (error) {
            ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
            return;
          }
        }
        const aliases = sessionApproval.aliases(pid);
        ctx.ui.setStatus("octssh-approval", aliases.length ? `⚠ 本会话免确认：${aliases.join(", ")}` : undefined);
        ctx.ui.notify(`${machine}：${action === "off" ? "已关闭免确认" : "本项目、本会话免确认已开启"}`, "info");
        return;
      }
      if (argv[0] === "trust") {
        await handleTrustCommand(argv.slice(1), ctx);
        return;
      }
      if (argv[0] === "permissions") {
        await handlePermissionsCommand(argv.slice(1), ctx);
        return;
      }
      if (argv[0] === "tasks") {
        await handleTasksCommand(argv.slice(1), ctx);
        return;
      }
      if (argv[0] === "credentials" && argv[1] === "clear") {
        // 「清除凭据」在用户眼里等于「退出登录」，但已认证的连接还在池里
        // （空闲最多 idleTtlSeconds 才断），因此默认连连接一起断。
        // 有进程内传输在跑时先确认：那会被打断，而远端 screen/nohup 任务不受影响。
        const transfers = runtime ? runtime.activeTransfers() : [];
        let dropConnections = true;

        if (transfers.length > 0) {
          const list = transfers
            .map((t) => `${t.direction === "upload" ? "上传" : "下载"} ${t.localPath} → ${t.machine}:${t.remotePath}`)
            .join("\n");
          const choice = await ctx.ui.select(
            [
              `OctSSH: 当前有 ${transfers.length} 个传输任务在跑：`,
              list,
              "",
              "清除凭据并断开连接会让这些传输**失败**；远端 screen/nohup 后台任务不受影响。要怎么做？",
            ].join("\n"),
            ["清除凭据并断开连接（传输会失败）", "只清除凭据，保留已连接的会话", "取消"],
          );
          if (choice === undefined || choice === "取消") return;
          dropConnections = choice === "清除凭据并断开连接（传输会失败）";
        }

        const cleared = clearAllCredentials();
        const closed = runtime && dropConnections ? await runtime.dropConnections() : 0;
        const tail = runtime
          ? dropConnections
            ? `已断开 ${closed} 条连接；下次执行命令会重新认证。`
            : "已连接会话保留（仍可免密执行，空闲超时后自动断开）。"
          : "运行时未启动，无连接可断。";
        ctx.ui.notify(`OctSSH: 已清除 ${cleared} 条进程内凭据缓存（剩 ${credentialCacheSize()} 条）；${tail}`, "info");
        return;
      }
      if (!runtime) {
        ctx.ui.notify(`OctSSH: 未运行${lastRuntimeError ? `；${lastRuntimeError}` : ""}`, "error");
        return;
      }
      const uptimeSeconds = runtimeStartedAt ? Math.floor((Date.now() - runtimeStartedAt) / 1000) : 0;
      const runningSessions = countRunningSessions();
      const pool = runtime.poolStats();
      const credentials = credentialCacheSize();
      ctx.ui.notify(
        [
          `OctSSH: 运行中 · ${formatDuration(uptimeSeconds)}`,
          `活跃 session ${runningSessions}`,
          `连接池 ${pool.connections}/${pool.maxConnections}`,
          `凭据缓存 ${credentials}`,
          `自动唤醒 ${loadConfig(getOctsshDir()).taskNotify.autoWake ? "开" : "关"}`,
        ].join(" · "),
        "info",
      );
    },
  });
}
