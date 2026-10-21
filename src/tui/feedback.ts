import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// 外部文本不得通过终端控制序列改变弹窗布局。
function plain(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

export async function selectConfirmation(
  ctx: ExtensionContext, title: string, body: string, choices: string[], signal?: AbortSignal, fullBody = body,
): Promise<string | undefined> {
  const details = "查看详情";
  const source = plain(body);
  while (true) {
    signal?.throwIfAborted();
    const width = Math.max(10, (process.stdout.columns || 80) - 8);
    const lines = source.split("\n").filter(Boolean);
    const preview = lines.slice(0, 2).map((line) => truncateToWidth(line, width, "…"));
    const choice = await ctx.ui.select([truncateToWidth(plain(title), width, "…"), ...preview, "完整范围见「查看详情」"].join("\n"), [...choices, details], { signal });
    signal?.throwIfAborted();
    if (choice !== details) return choice;
    let page = 0;
    while (true) {
      signal?.throwIfAborted();
      const pageWidth = Math.max(10, (process.stdout.columns || 80) - 8);
      const pageSize = Math.max(1, Math.min(6, (process.stdout.rows || 24) - 12));
      const wrapped = wrapTextWithAnsi(plain(fullBody), pageWidth);
      const pages = Math.max(1, Math.ceil(wrapped.length / pageSize));
      page = Math.min(page, pages - 1);
      const nav = ["返回确认", ...(page + 1 < pages ? ["下一页"] : []), ...(page > 0 ? ["上一页"] : [])];
      const selected = await ctx.ui.select([`详情 ${page + 1}/${pages}`, ...wrapped.slice(page * pageSize, (page + 1) * pageSize)].join("\n"), nav, { signal });
      signal?.throwIfAborted();
      if (!selected) return undefined;
      if (selected === "返回确认") break;
      page += selected === "下一页" ? 1 : -1;
    }
  }
}

export function explainFailure(operation: string, error: unknown): string {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : String(record.message ?? record.reason ?? "");
  const code = String(record.code ?? "");
  const text = `${code} ${message}`;
  const transfer = /upload|download/.test(operation);
  const uncertain = transfer ? "可能留下部分文件，请检查目标路径。" : "远端结果未确认，请先核对，勿直接重试。";
  if (/AbortError/i.test(String(record.name)) || /aborted|cancelled|canceled|已取消|中止/i.test(text)) return `已停止等待。${uncertain}`;
  if (/timed? ?out|timeout|ETIMEDOUT|超时/i.test(text)) return `等待超时。${uncertain}`;
  if (/EEXIST/.test(text)) return /mkdir/i.test(text)
    ? "创建目录失败（EEXIST）。请检查路径是否被同名文件占用；若已是目录，可能是目录处理异常。请核对目标，勿覆盖重试。"
    : "目标已存在（EEXIST），未覆盖该目标。请更换路径；批量传输可能已完成部分文件。";
  if (/not a directory|ENOTDIR/i.test(text)) return "目录路径不可用：可能被同名文件占用。请选择其他目录。";
  if (/authentication|All configured authentication methods failed/i.test(text)) return "SSH 认证失败。请检查密钥或密码配置。";
  if (/host key.*(changed|mismatch)|主机密钥.*变化/i.test(text)) return "主机密钥不匹配，连接已阻止。请先核实服务器身份。";
  if (/ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|ENOTFOUND/.test(text)) return "无法连接主机。请检查地址、网络和 SSH 服务。";
  if (/EACCES|EPERM|permission denied/i.test(text)) return `权限不足。请检查目标路径和账号权限。${transfer ? uncertain : ""}`;
  if (/ENOENT|not found/i.test(text)) return "路径或程序不存在。请检查配置和目标路径。";
  if (/lock|状态正在被另一操作使用/i.test(text)) return "状态文件暂不可用。请稍后重试；持续失败时检查状态目录权限。";
  // 原始异常可能嵌入命令、URL、环境变量或文件内容，不把它复制到工具结果。
  return `操作失败，原因未确定。${uncertain}请检查连接与路径配置。`;
}
