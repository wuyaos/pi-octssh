/**
 * OctSSH 工具结果的显示渲染。
 *
 * 与扩展入口分开的原因：这里全是纯字符串处理（不碰 TUI 类型），
 * 可以在没有真实终端的情况下用探针验证——显示错了比逻辑错了更难发现。
 *
 * `theme` 只用到 `fg(color, text)`，因此这里不依赖 pi-tui 的具体类型。
 */
export type DisplayTheme = { fg: (color: string, text: string) => string };

/** 折叠时最多显示几行正文；展开时放宽，但仍不无限刷屏。 */
export const DISPLAY_LINES_COLLAPSED = 14;
export const DISPLAY_LINES_EXPANDED = 300;

export function clipLines(text: string, max: number): { lines: string[]; omitted: number } {
  const all = text.replace(/\r\n/g, "\n").split("\n");
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  if (all.length <= max) return { lines: all, omitted: 0 };
  return { lines: all.slice(0, max), omitted: all.length - max };
}

/** 秒数转成人看的形式：90s → 1m30s，3700s → 1h1m。 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function detailText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * 按操作类型渲染结果正文：exec/read 给正文，edit 给 diff。
 * 折叠态只给少量正文，展开态（Ctrl+O）才放宽——既避免一次命令刷满屏幕，
 * 也让「改了什么」在展开前就能看出来。
 */
export function renderDetails(operation: string | undefined, data: unknown, theme: DisplayTheme, expanded: boolean): string[] {
  const out: string[] = [];
  const max = expanded ? DISPLAY_LINES_EXPANDED : DISPLAY_LINES_COLLAPSED;
  const record = typeof data === "object" && data !== null ? (data as Record<string, any>) : undefined;
  if (!record) return out;

  if (operation === "exec" || operation === "exec-async") {
    if (record.session_id) {
      const pid = record.cmdPid ? ` · pid ${String(record.cmdPid)}` : "";
      out.push(theme.fg("muted", `任务 ${String(record.session_id)} · 后端 ${String(record.backend ?? "screen")}${pid}`));
      return out;
    }
    const stdout = clipLines(String(record.stdout ?? ""), max);
    for (const line of stdout.lines) out.push(line);
    if (stdout.omitted > 0) out.push(theme.fg("dim", `… 省略 ${stdout.omitted} 行（Ctrl+O 展开）`));
    if (record.stderr) {
      const stderr = clipLines(String(record.stderr), expanded ? 80 : 6);
      out.push(theme.fg("warning", "stderr:"));
      for (const line of stderr.lines) out.push(theme.fg("warning", line));
      if (stderr.omitted > 0) out.push(theme.fg("dim", `… 省略 ${stderr.omitted} 行 stderr`));
    }
    if (typeof record.exitCode === "number" && record.exitCode !== 0) out.push(theme.fg("error", `退出码 ${record.exitCode}`));
    for (const warning of Array.isArray(record.warnings) ? record.warnings : []) out.push(theme.fg("warning", `⚠ ${String(warning)}`));
    if (record.sudoHint) out.push(theme.fg("warning", `⚠ ${String(record.sudoHint)}`));
    return out;
  }

  if (operation === "read") {
    const text = clipLines(String(record.text ?? ""), max);
    for (const line of text.lines) out.push(line);
    if (text.omitted > 0) {
      out.push(theme.fg("dim", `… 省略 ${text.omitted} 行（共 ${String(record.totalLines)} 行；用 offset/limit 翻页）`));
    }
    return out;
  }

  if (operation === "edit") {
    const diff = record.diff;
    if (diff && Array.isArray(diff.lines)) {
      for (const line of diff.lines) {
        const text = String(line);
        const color = text.startsWith("+") ? "success" : text.startsWith("-") ? "error" : "dim";
        out.push(theme.fg(color, text));
      }
      if (diff.truncated) out.push(theme.fg("dim", `… diff 已截断（共 ${String(diff.totalLines)} 行）`));
    }
    if (record.detail) out.push(theme.fg("muted", String(record.detail)));
    if (record.remoteNotChecked) out.push(theme.fg("warning", "⚠ 未连接远端核对"));
    return out;
  }

  if (operation === "upload" || operation === "download" || operation === "upload-async" || operation === "download-async") {
    const bytes = record.bytes ?? record.bytesWritten ?? record.transferredBytes;
    if (typeof bytes === "number") out.push(theme.fg("muted", `${bytes} 字节`));
    if (record.session_id) out.push(theme.fg("muted", `任务 ${String(record.session_id)}`));
    for (const warning of Array.isArray(record.warnings) ? record.warnings : []) out.push(theme.fg("warning", `⚠ ${String(warning)}`));
    return out;
  }

  if (operation?.startsWith("session-")) {
    if (record.status) {
      const exit = record.exitCode != null ? ` · 退出码 ${String(record.exitCode)}` : "";
      out.push(theme.fg("muted", `状态 ${String(record.status)}${exit}`));
    }
    const tails = record.tails;
    if (tails && (tails.stdout || tails.stderr)) {
      const stdout = clipLines(String(tails.stdout ?? ""), max);
      for (const line of stdout.lines) out.push(line);
      if (stdout.omitted > 0) out.push(theme.fg("dim", `… 省略 ${stdout.omitted} 行`));
      if (tails.stderr) {
        const stderr = clipLines(String(tails.stderr), expanded ? 60 : 6);
        out.push(theme.fg("warning", "stderr:"));
        for (const line of stderr.lines) out.push(theme.fg("warning", line));
      }
    }
    if (record.matches) {
      for (const line of clipLines(String(record.matches.stdout ?? ""), max).lines) out.push(line);
    }
    if (typeof record.bytes === "number") out.push(theme.fg("muted", `写入 ${record.bytes} 字节`));
    return out;
  }

  if (expanded) out.push(theme.fg("toolOutput", detailText(record)));
  return out;
}
