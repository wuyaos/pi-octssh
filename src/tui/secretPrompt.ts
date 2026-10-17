import {
  CURSOR_MARKER,
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

  handleInput(data: string): void {
    if (this.finished) return;

    if (data === "\r" || data === "\n") {
      this.finish(this.value);
      return;
    }

    if (data === "\u001b") {
      this.finish(undefined);
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
