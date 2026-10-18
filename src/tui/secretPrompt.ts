import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
} from "@earendil-works/pi-tui";

/**
 * 遮罩输入组件。
 *
 * `@earendil-works/pi-tui` 的 `Input` 没有 mask 选项，`ctx.ui.input()` 也是明文，
 * 因此密码与私钥口令只能自造组件：明文只留在 `this.value`，渲染一律替换为掩码。
 */

export type SecretPromptTheme = {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
};

export type SecretPromptOptions = {
  /** 第一行标题，必须写明认证对象（user@host:port），不能只写「请输入密码」。 */
  title: string;
  /** 可选第二行，例如跳板路线或目标主机说明。 */
  subtitle?: string;
  theme: SecretPromptTheme;
  done: (value: string | undefined) => void;
  mask?: string;
};

const MASK = "•";

/** bracketed paste 边界序列（终端在粘贴前后各发一个）。 */
const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

function stripPrintable(data: string): string | undefined {
  // 只接受单个可打印字符；控制键由下面的显式分支处理。
  if (data.length === 1) {
    const code = data.charCodeAt(0);
    if (code >= 0x20 && code !== 0x7f) return data;
  }
  return undefined;
}

export class SecretPrompt implements Component, Focusable {
  focused = false;

  private readonly title: string;
  private readonly subtitle?: string;
  private readonly theme: SecretPromptTheme;
  private readonly done: (value: string | undefined) => void;
  private readonly mask: string;
  private value = "";
  private finished = false;

  constructor(options: SecretPromptOptions) {
    this.title = options.title;
    this.subtitle = options.subtitle;
    this.theme = options.theme;
    this.done = options.done;
    this.mask = options.mask ?? MASK;
  }

  /** 处在 bracketed paste 内部（序列可能被拆到多个 chunk）。 */
  private pasting = false;

  /**
   * 处理 bracketed paste。
   *
   * 返回 true 表示这个 chunk 已被粘贴逻辑消费，调用方不要再按键处理。
   * 粘贴内容**一律不走明文回显**：只进 this.value，渲染仍是掩码。
   */
  private consumePaste(data: string): boolean {
    let consumed = false;
    let rest = data;

    if (this.pasting) {
      const end = rest.indexOf(PASTE_END);
      if (end === -1) {
        // 整段仍在粘贴中。
        this.value += rest;
        return true;
      }
      this.value += rest.slice(0, end);
      this.pasting = false;
      rest = rest.slice(end + PASTE_END.length);
      consumed = true;
    }

    for (;;) {
      const start = rest.indexOf(PASTE_START);
      if (start === -1) break;

      const before = rest.slice(0, start);
      if (before) this.value += before;
      const afterStart = rest.slice(start + PASTE_START.length);
      const end = afterStart.indexOf(PASTE_END);
      consumed = true;

      if (end === -1) {
        this.value += afterStart;
        this.pasting = true;
        return true;
      }

      this.value += afterStart.slice(0, end);
      rest = afterStart.slice(end + PASTE_END.length);
    }

    if (consumed) {
      // 粘贴边界之后的残余内容按普通输入处理（多为换行或控制键）。
      if (rest === "\r" || rest === "\n") {
        this.finish(this.value);
        return true;
      }
      if (rest === "\u001b") {
        this.finish(undefined);
        return true;
      }
      if (rest) this.value += rest;
    }
    return consumed;
  }

  /** 全为可打印字符（粘贴内容里可能包含换行，这里允许 \n 一并进值）。 */
  private isAllPrintable(data: string): boolean {
    for (const ch of data) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0x0a || code === 0x0d) continue;
      if (code < 0x20 || code === 0x7f) return false;
    }
    return true;
  }

  handleInput(data: string): void {
    if (this.finished) return;

    // bracketed paste：终端会把整段粘贴内容包在 \x1b[200~ … \x1b[201~ 之间。
    // 中间内容原样收下（仍然只显示掩码），并在跨 chunk 时记住「还在粘贴中」。
    const pasteHandled = this.consumePaste(data);
    if (pasteHandled) return;

    // 先判「必须结束」的键：Escape / Ctrl+C 取消，Enter 提交。
    // 用 pi-tui 的 matchesKey 而不是直接比字节：终端可能把 Escape 送来成
    // CSI-u（`\x1b[27u`）等编码，只认 `\x1b` 会让 Esc 看起来「没反应」。
    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
      this.finish(undefined);
      return;
    }

    if (matchesKey(data, "return")) {
      this.finish(this.value);
      return;
    }

    // 一次来了多个字符（部分终端/输入法会合并）。这里必须切开 CR/LF：
    // 否则「粘贴/连打 + 回车」合成一个 chunk 时，回车会被当成密码的一部分
    // 收进 value —— 用户按了正确的密码，服务端却收到带 \r 的字符串而拒绝。
    if (data.length > 1 && this.isAllPrintable(data)) {
      const breakAt = data.search(/[\r\n]/);
      if (breakAt === -1) {
        this.value += data;
      } else {
        this.value += data.slice(0, breakAt);
        this.finish(this.value);
      }
      return;
    }

    if (data === "\u007f" || data === "\b") {
      this.value = this.value.slice(0, -1);
      return;
    }

    const printable = stripPrintable(data);
    if (printable !== undefined) this.value += printable;
  }
  private finish(value: string | undefined): void {
    if (this.finished) return;
    this.finished = true;
    // 清掉明文，避免组件实例被后续渲染或调试输出带出。
    const result = value;
    this.value = "";
    this.done(result);
  }

  invalidate(): void {
    /* 无缓存，渲染是纯函数式拼接。 */
  }

  render(width: number): string[] {
    const lines: string[] = [];
    lines.push(truncateToWidth(this.theme.bold(this.title), width, ""));

    if (this.subtitle) lines.push(truncateToWidth(this.theme.fg("muted", this.subtitle), width, ""));

    const masked = this.mask.repeat(this.value.length);
    const cursor = this.focused ? CURSOR_MARKER : "";
    const field = `${this.theme.fg("accent", "› ")}${masked}${cursor}`;
    lines.push(truncateToWidth(field, width, ""));

    const hint = this.theme.fg("dim", "Enter 确认 · Esc 取消 · 输入不回显");
    lines.push(truncateToWidth(hint, width, ""));

    // 保证每行不超过可用宽度（宽字符由 truncateToWidth 处理）。
    return lines.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "") : line));
  }
}
