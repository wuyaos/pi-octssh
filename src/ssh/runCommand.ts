import type { Client } from "ssh2";

export type ExecOptions = {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  pty?: boolean;
  signal?: AbortSignal;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: { stdout: boolean; stderr: boolean };
};

function abortError() {
  const error = new Error("Operation aborted");
  error.name = "AbortError";
  return error;
}

export async function runCommand(
  client: Client,
  command: string,
  options: ExecOptions = {}
): Promise<ExecResult> {
  const maxStdoutBytes = options.maxStdoutBytes ?? 64 * 1024;
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  if (options.signal?.aborted) throw abortError();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stream: any;
    const finishReject = (error: Error) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = () => {
      try { stream?.close?.(); } catch { /* ignore */ }
      try { stream?.end?.(); } catch { /* ignore */ }
      finishReject(abortError());
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const handler = (err: any, channel: any) => {
      if (err) return finishReject(err);
      if (settled) {
        try { channel.close?.(); } catch { /* ignore */ }
        return;
      }
      stream = channel;
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let stdoutTrunc = false;
      let stderrTrunc = false;

      channel.on("data", (chunk: Buffer) => {
        if (stdoutTrunc) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) { stdoutTrunc = true; return; }
        stdoutChunks.push(chunk);
      });
      channel.stderr.on("data", (chunk: Buffer) => {
        if (stderrTrunc) return;
        stderrBytes += chunk.length;
        if (stderrBytes > maxStderrBytes) { stderrTrunc = true; return; }
        stderrChunks.push(chunk);
      });
      channel.on("error", (error: Error) => finishReject(error));
      channel.on("close", (code: number, signal: string) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", onAbort);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          exitCode: Number.isFinite(code) ? code : null,
          signal: signal ?? null,
          truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
        });
      });
    };

    if (options.pty) client.exec(command, { pty: true } as any, handler);
    else client.exec(command, handler);
  });
}
