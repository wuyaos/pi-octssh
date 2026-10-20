import type { Client } from "ssh2";

export type ExecOptions = {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  pty?: boolean;
  signal?: AbortSignal;
  /** 包含 channel 打开时间，不包含调用前的人工确认。 */
  timeoutMs?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: { stdout: boolean; stderr: boolean };
};

export class ExecWaitError extends Error {
  readonly outcome = "unknown";
  readonly partial: ExecResult;

  constructor(name: "AbortError" | "TimeoutError" | "ConnectionError", partial: ExecResult) {
    const reason = name === "AbortError" ? "已停止等待" : name === "TimeoutError" ? "等待超时" : "SSH 连接中断";
    super(`${reason}。远端可能仍在运行，请先核对，勿重复执行。`);
    this.name = name;
    this.partial = partial;
  }
}

// channel 在 close 后仍可能发出 error；不能让它成为宿主的未捕获异常。
const ignoreLateError = () => {};

export async function runCommand(
  client: Client,
  command: string,
  options: ExecOptions = {},
): Promise<ExecResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new RangeError("timeoutMs must be positive and at most 2147483647");
  }
  if (options.signal?.aborted) {
    const error = new Error("已取消，命令未发送。");
    error.name = "AbortError";
    throw error;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: any;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutTrunc = false;
    let stderrTrunc = false;
    const snapshot = (code: number | null = null, signal: string | null = null): ExecResult => ({
      stdout: Buffer.concat(stdoutChunks).toString("utf8"),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
      exitCode: code,
      signal,
      truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
    });
    const onStdout = (chunk: Buffer) => {
      if (stdoutTrunc) return;
      const remaining = Math.max(0, maxStdoutBytes - stdoutBytes);
      stdoutChunks.push(Buffer.from(chunk.subarray(0, remaining)));
      stdoutBytes += Math.min(chunk.length, remaining);
      stdoutTrunc = chunk.length > remaining;
    };
    const onStderr = (chunk: Buffer) => {
      if (stderrTrunc) return;
      const remaining = Math.max(0, maxStderrBytes - stderrBytes);
      stderrChunks.push(Buffer.from(chunk.subarray(0, remaining)));
      stderrBytes += Math.min(chunk.length, remaining);
      stderrTrunc = chunk.length > remaining;
    };
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      client.removeListener("close", onConnectionClose);
      client.removeListener("error", onConnectionError);
      if (stream) {
        stream.on("error", ignoreLateError);
        stream.removeListener("error", finishReject);
        stream.removeListener("close", onClose);
        stream.removeListener("data", onStdout);
        stream.stderr.removeListener("data", onStderr);
      }
    };
    const closeChannel = (channel: any) => {
      // 只关闭本次 channel，不能断开其他调用共用的 SSH 连接。
      try { channel?.close?.(); } catch { /* channel 可能已关闭 */ }
      try { channel?.destroy?.(); } catch { /* channel 可能已关闭 */ }
    };
    const finishReject = (error: Error) => {
      if (settled) return;
      // close() 可能同步触发 close 事件，必须先结算，避免取消被报成成功。
      settled = true;
      cleanup();
      closeChannel(stream);
      reject(error);
    };
    const onAbort = () => finishReject(new ExecWaitError("AbortError", snapshot()));
    const onConnectionClose = () => finishReject(new ExecWaitError("ConnectionError", snapshot()));
    const onConnectionError = () => finishReject(new ExecWaitError("ConnectionError", snapshot()));
    const onClose = (code: number, signal: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(snapshot(Number.isFinite(code) ? code : null, signal ?? null));
    };
    const timer = setTimeout(() => finishReject(new ExecWaitError("TimeoutError", snapshot())), timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    client.on("close", onConnectionClose);
    client.on("error", onConnectionError);

    const handler = (err: any, channel: any) => {
      if (err) return finishReject(err);
      if (settled) {
        channel.on("error", ignoreLateError);
        closeChannel(channel);
        return;
      }
      stream = channel;
      channel.on("data", onStdout);
      channel.stderr.on("data", onStderr);
      channel.on("error", finishReject);
      channel.on("close", onClose);
      // 此 API 不接收 stdin；发送 EOF，让 cat/read 等非交互程序可以结束。
      try { channel.end(); } catch (error) { finishReject(error as Error); }
    };
    try {
      if (options.pty) client.exec(command, { pty: true } as any, handler);
      else client.exec(command, handler);
    } catch (error) {
      finishReject(error as Error);
    }
  });
}
