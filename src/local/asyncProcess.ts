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

type WrapperParams = {
  sessionId: string;
  command: string;
  sudo: boolean;
  runDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  pidPath: string;
  stdinPath: string;
};

function nowIso() {
  return new Date().toISOString();
}

export async function startLocalAsync(params: StartLocalAsyncParams): Promise<StartedLocalAsync> {
  const sessionId = crypto.randomUUID();
  const baseDir = getOctsshDir();
  const runDir = path.join(baseDir, "runs", sessionId);
  const stdoutPath = path.join(runDir, "stdout.log");
  const stderrPath = path.join(runDir, "stderr.log");
  const metaPath = path.join(runDir, "meta.json");
  const stdinPath = path.join(runDir, "stdin.in");
  const stdinLogPath = path.join(runDir, "stdin.log");
  const pidPath = path.join(runDir, "cmd.pid");
  const wrapperParamsPath = path.join(runDir, "wrapper.params.json");

  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(stdoutPath, "");
  fs.writeFileSync(stderrPath, "");
  fs.writeFileSync(stdinPath, "");
  fs.writeFileSync(stdinLogPath, "");
  fs.writeFileSync(metaPath, "");

  const wrapperMain = path.join(__dirname, "asyncWrapper.js");
  const wrapperParams: WrapperParams = {
    sessionId,
    command: params.command,
    sudo: params.sudo,
    runDir,
    stdoutPath,
    stderrPath,
    metaPath,
    pidPath,
    stdinPath,
  };
  fs.writeFileSync(wrapperParamsPath, JSON.stringify(wrapperParams, null, 2) + "\n");

  const child = spawn(process.execPath, [wrapperMain, wrapperParamsPath], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();

  let cmdPid: number | undefined;
  for (let i = 0; i < 30; i++) {
    try {
      const txt = fs.readFileSync(pidPath, "utf8").trim();
      const n = Number(txt);
      if (Number.isFinite(n) && n > 0) {
        cmdPid = n;
        break;
      }
    } catch {
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
