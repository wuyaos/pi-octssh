import { spawn } from "node:child_process";

import { selectLocalShell, spawnShell } from "./shell.js";

export type ExecOptions = {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
};

export type ExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  truncated: {
    stdout: boolean;
    stderr: boolean;
  };
};

// Local equivalent of ssh/runCommand.ts. We keep the same truncation behavior:
// once the cap is exceeded, we stop buffering further output.
export async function runLocalCommand(params: {
  command: string;
  sudo?: boolean;
  // Extra argv passed to the shell command after `-lc <command>`.
  // This is useful for scripts that want to read "$@" without needing
  // additional escaping.
  shellArgs?: string[];
  options?: ExecOptions;
}): Promise<ExecResult> {
  const maxStdoutBytes = params.options?.maxStdoutBytes ?? 64 * 1024;
  const maxStderrBytes = params.options?.maxStderrBytes ?? 64 * 1024;

  const extra = params.shellArgs ?? [];

  const shell = selectLocalShell();
  if (params.sudo && shell.kind !== "sh") {
    return {
      stdout: "",
      stderr: "sudo is not supported for this local shell. On Windows, run OctSSH as Administrator or use exec without sudo.",
      exitCode: 126,
      signal: null,
      truncated: { stdout: false, stderr: false },
    };
  }

  const child = (() => {
    if (params.sudo) {
      return spawn("sudo", ["-n", "--", "sh", "-lc", params.command, ...extra], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    }

    return spawnShell({
      shell,
      command: params.command,
      shellArgs: extra,
      options: {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    });
  })();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let stdoutTrunc = false;
  let stderrTrunc = false;

  child.stdout?.on("data", (chunk: Buffer) => {
    if (stdoutTrunc) return;
    stdoutBytes += chunk.length;
    if (stdoutBytes > maxStdoutBytes) {
      stdoutTrunc = true;
      return;
    }
    stdoutChunks.push(chunk);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    if (stderrTrunc) return;
    stderrBytes += chunk.length;
    if (stderrBytes > maxStderrBytes) {
      stderrTrunc = true;
      return;
    }
    stderrChunks.push(chunk);
  });

  return await new Promise<ExecResult>((resolve) => {
    child.on("error", (err: any) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: String(err?.message ?? err),
        exitCode: 127,
        signal: null,
        truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
      });
    });
    child.on("close", (code, signal) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        exitCode: Number.isFinite(code) ? code : null,
        signal: signal ?? null,
        truncated: { stdout: stdoutTrunc, stderr: stderrTrunc },
      });
    });
  });
}
