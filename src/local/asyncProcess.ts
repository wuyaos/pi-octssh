import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

import { saveSession } from "../state/sessions.js";
import { getOctsshDir } from "../state/paths.js";

export type StartLocalAsyncParams = {
  machine: string;
  command: string;
  sudo: boolean;
};

export type StartedLocalAsync = {
  session_id: string;
  cmdPid?: number;
  runDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  stdinPath: string;
  stdinLogPath: string;
};

function nowIso() {
  return new Date().toISOString();
}

function buildWrapperFile(params: { sudo: boolean }) {
  // Wrapper runs independently and writes meta on completion.
  const inner = params.sudo ? 'sudo -n -- sh -lc "$1"' : 'sh -lc "$1"';
  return [
    "#!/bin/sh",
    "set -u",
    'run="$2"',
    'stdout="$run/stdout.log"',
    'stderr="$run/stderr.log"',
    'meta="$run/meta.json"',
    'pidfile="$run/cmd.pid"',
    'stdin="$run/stdin.fifo"',
    'stdinlog="$run/stdin.log"',
    'ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "{\\"status\\":\\"running\\",\\"startedAt\\":\\"%s\\"}\\n" "$ts" > "$meta"',
    'rm -f "$stdin" 2>/dev/null || true',
    'mkfifo "$stdin"',
    ': > "$stdinlog"',
    'exec 3<> "$stdin"',
    `(${inner}) <&3 >"$stdout" 2>"$stderr" & cmdpid=$!`,
    'echo "$cmdpid" > "$pidfile"',
    'wait "$cmdpid"; code=$?',
    'ts2=$(date -u +%Y-%m-%dT%H:%M:%SZ)',
    'printf "{\\"status\\":\\"done\\",\\"exitCode\\":%s,\\"endedAt\\":\\"%s\\"}\\n" "$code" "$ts2" > "$meta"',
  ].join("\n");
}

export async function startLocalAsync(params: StartLocalAsyncParams): Promise<StartedLocalAsync> {
  const sessionId = crypto.randomUUID();
  const baseDir = getOctsshDir();
  const runDir = path.join(baseDir, "runs", sessionId);
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const metaPath = path.join(runDir, "meta.json");
  const stdinPath = path.join(runDir, "stdin.fifo");
  const stdinLogPath = path.join(runDir, "stdin.log");
  const pidPath = path.join(runDir, "cmd.pid");
  const wrapperPath = path.join(runDir, "wrapper.sh");

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(wrapperPath, buildWrapperFile({ sudo: params.sudo }) + "\n", { mode: 0o755 });

  // Run wrapper detached so the async job survives MCP client disconnects.
  const child = spawn("sh", [wrapperPath, params.command, runDir], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  // Best-effort: read cmd.pid shortly after start.
  let cmdPid: number | undefined;
  for (let i = 0; i < 20; i++) {
    try {
      const txt = fs.readFileSync(pidPath, "utf8").trim();
      const n = Number(txt);
      if (Number.isFinite(n) && n > 0) {
        cmdPid = n;
        break;
      }
    } catch {
      // wait
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  const now = nowIso();
  saveSession(
    {
      kind: "local",
      session_id: sessionId,
      machine: params.machine,
      createdAt: now,
      updatedAt: now,
      status: "running",
      cmdPid,
      runDir,
      stdoutPath,
      stderrPath,
      metaPath,
      stdinPath,
      stdinLogPath,
    },
    baseDir
  );

  return { session_id: sessionId, cmdPid, runDir, stdoutPath, stderrPath, metaPath, stdinPath, stdinLogPath };
}
