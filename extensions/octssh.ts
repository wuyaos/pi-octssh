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

let runtime: OctsshRuntime | null = null;
let runtimeStartedAt: number | null = null;
let lastRuntimeError: string | null = null;

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

function makeError(operation: string, error: unknown, kind: "blocked" | "error" = "error"): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return makeResult(operation, { kind, message }, message, kind);
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
  lines.push("", "仅在确认内容无误时继续。此授权只对本次操作有效。");
  return lines.join("\n");
}

async function withConfirmation(
  operation: string,
  ctx: ExtensionContext,
  run: (authorization?: Authorization) => Promise<unknown>,
): Promise<ToolResult | unknown> {
  let result = await run();

  // 上传冲突可能在用户确认期间发生变化；若 Core 重新要求确认，展示新预览。
  for (let attempt = 0; isConfirmation(result) && attempt < 3; attempt += 1) {
    const request = result.authorizationRequest;
    if (!ctx.hasUI) {
      return makeResult(
        operation,
        { kind: "blocked", reason: "confirmation_ui_unavailable" },
        "该操作需要人工确认，但当前运行模式没有可用的确认界面，已拒绝执行。",
        "blocked",
      );
    }

    const confirmed = await ctx.ui.confirm(
      "OctSSH 安全确认",
      confirmationMessage(request),
    );
    if (!confirmed) {
      return makeResult(
        operation,
        { kind: "blocked", reason: "user_rejected" },
        "用户拒绝了危险操作，未执行任何更改。",
        "blocked",
      );
    }

    let authorization: Authorization;
    try {
      authorization = getRuntime().authorize(request);
    } catch (error) {
      return makeError(operation, error, "blocked");
    }
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
  const kind = asRecord(value)?.kind;
  if (kind === "blocked") return makeResult(operation, value, failureMessage(value), "blocked");
  if (kind === "error") return makeResult(operation, value, failureMessage(value), "error");
  return makeResult(operation, value, successSummary);
}

function renderResult(result: ToolResult, expanded: boolean, theme: any) {
  const details = result.details;
  if (!details) {
    const content = result.content[0];
    return new Text(content?.type === "text" ? content.text : "", 0, 0);
  }
  const color = details.kind === "success" ? "success" : details.kind === "blocked" ? "warning" : "error";
  const prefix = details.kind === "success" ? "✓ " : details.kind === "blocked" ? "⚠ " : "✗ ";
  const firstLine = theme.fg(color, prefix) + theme.fg("muted", details.summary);
  if (!expanded) return new Text(firstLine, 0, 0);
  return new Text(`${firstLine}\n${theme.fg("toolOutput", stringify(details.data))}`, 0, 0);
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

export default function octsshExtension(pi: ExtensionAPI) {
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
    async execute(_id, params, signal) {
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
    mode: Type.Optional(Type.Union([Type.Literal("sync"), Type.Literal("async")], { description: "同步等待或在远端 screen 后台运行；默认 sync" })),
    sudo: Type.Optional(Type.Boolean({ description: "是否通过 passwordless sudo 执行" })),
  });

  pi.registerTool({
    name: "octssh_exec",
    label: "OctSSH Exec",
    description: "在指定 SSH 主机执行命令。支持同步、远端 screen 异步任务和 passwordless sudo；危险命令由用户在 Pi 界面人工确认。",
    promptSnippet: "在远端 SSH 主机执行命令",
    parameters: execSchema,
    async execute(_id, params, signal, _onUpdate, ctx) {
      try {
        const rt = getRuntime();
        const isAsync = params.mode === "async";
        const operation = isAsync ? "exec-async" : "exec";
        const result = await withConfirmation(operation, ctx, (authorization) =>
          isAsync
            ? rt.execAsync({ machine: params.machine, command: params.command, sudo: params.sudo, signal, authorization })
            : rt.exec({ machine: params.machine, command: params.command, sudo: params.sudo, signal, authorization }),
        );
        if (asRecord(result)?.details) return result as ToolResult;
        const record = asRecord(result);
        const sessionId = record?.session_id ?? record?.sessionId;
        const summary = isAsync
          ? `已在 ${params.machine} 启动远端任务${sessionId ? `（${String(sessionId)}）` : ""}`
          : `${params.machine} 命令执行完成，退出码 ${String(record?.exitCode ?? "未知")}`;
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
      const operation = `${params.direction}${params.async ? "-async" : ""}`;
      try {
        const rt = getRuntime();
        const run = (authorization?: Authorization) => {
          if (params.direction === "upload") {
            return params.async
              ? rt.uploadAsync({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, signal, authorization })
              : rt.upload({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, signal, authorization });
          }
          return params.async
            ? rt.downloadAsync({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, signal })
            : rt.download({ machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, signal });
        };
        const result = params.direction === "upload"
          ? await withConfirmation(operation, ctx, run)
          : await run();
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

  pi.registerTool({
    name: "octssh_session",
    label: "OctSSH Session",
    description: "管理 OctSSH 异步任务：查询状态与日志、搜索日志、写入 stdin、取消任务。",
    promptSnippet: "查询或管理 OctSSH 远端异步任务",
    parameters: sessionSchema,
    async execute(_id, params) {
      try {
        const rt = getRuntime();
        let result: unknown;
        switch (params.action) {
          case "get":
            result = await rt.getSession(params.sessionId, params.lines);
            break;
          case "grep":
            if (!params.pattern) return makeError("session-grep", "grep 操作必须提供 pattern");
            result = await rt.grepSession(params.sessionId, params.pattern, {
              maxMatches: params.maxMatches,
              contextLines: params.contextLines,
            });
            break;
          case "write-stdin":
            if (params.data === undefined) return makeError("session-write-stdin", "write-stdin 操作必须提供 data");
            result = await rt.writeStdin(params.sessionId, params.data, { appendNewline: params.appendNewline });
            break;
          case "cancel":
            result = await rt.cancelSession(params.sessionId, params.signal);
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
      if (runtime) await runtime.shutdown();
      runtime = createOctsshRuntime();
      runtime.start();
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
    const current = runtime;
    runtime = null;
    runtimeStartedAt = null;
    if (current) await current.shutdown();
  });

  pi.registerCommand("octssh", {
    description: "查看 OctSSH runtime 与异步任务状态",
    handler: async (_args, ctx) => {
      if (!runtime) {
        ctx.ui.notify(`OctSSH: 未运行${lastRuntimeError ? `；${lastRuntimeError}` : ""}`, "error");
        return;
      }
      const uptimeSeconds = runtimeStartedAt ? Math.floor((Date.now() - runtimeStartedAt) / 1000) : 0;
      const runningSessions = countRunningSessions();
      ctx.ui.notify(
        `OctSSH: 运行中 · ${uptimeSeconds}s · 活跃 session ${runningSessions} · 连接池大小不可用（Core 未公开统计）`,
        "info",
      );
    },
  });
}
