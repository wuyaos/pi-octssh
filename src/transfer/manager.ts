import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Client } from "ssh2";
import { getOctsshDir } from "../state/paths.ts";
import { listSessionIds } from "../state/cleanup.ts";
import { loadSession, saveSession, type SessionRecord } from "../state/sessions.ts";
type TransferSession = Extract<SessionRecord, { kind: "transfer" }>;
function isTransferSession(rec: SessionRecord): rec is TransferSession { return "kind" in rec && rec.kind === "transfer"; }
import { performDownload, type DownloadPlan } from "./download.ts";
import { performUpload, type UploadPlan } from "./upload.ts";

type TransferRuntime = { abort: AbortController; done: Promise<void> };
const runtimes = new Map<string, TransferRuntime>();
const nowIso = () => new Date().toISOString();
function getTransferLogsDir(baseDir = getOctsshDir()) { return path.join(baseDir, "transfer-logs"); }
function appendLog(sessionId: string, line: string, baseDir = getOctsshDir()) {
  const dir = getTransferLogsDir(baseDir);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.log`);
  fs.appendFileSync(p, `${nowIso()} ${line}\n`, "utf8");
  return p;
}
function setTransferSession(update: Partial<SessionRecord> & { session_id: string }, baseDir = getOctsshDir()) {
  const prev = loadSession(update.session_id, baseDir);
  if (prev) saveSession({ ...prev, ...update, updatedAt: nowIso() } as SessionRecord, baseDir);
}
export function cancelTransfer(sessionId: string) {
  const rt = runtimes.get(sessionId);
  if (!rt) return false;
  rt.abort.abort();
  return true;
}
export async function shutdownTransfers(reason = "interrupted") {
  const active = [...runtimes.entries()];
  for (const [, rt] of active) rt.abort.abort();
  await Promise.allSettled(active.map(([, rt]) => rt.done));
  for (const id of listSessionIds(getOctsshDir())) {
    const rec = loadSession(id, getOctsshDir());
    if (rec && isTransferSession(rec) && rec.status === "running") {
      saveSession({ ...rec, status: "failed", error: reason, updatedAt: nowIso() }, getOctsshDir());
    }
  }
}

type Common = { client: Client; machine: string; localPath: string; remotePath: string; release: () => void };
export function startUploadAsync(params: Common & { plan: UploadPlan }) {
  return startTransfer("upload", params, async (abort, sessionId, baseDir) => {
    let done = 0;
    for (const file of params.plan.files) appendLog(sessionId, `put ${file.local} -> ${file.remote}`, baseDir);
    await performUpload(params.client, params.plan, abort.signal, (file) => {
      done += file.size ?? 0;
      setTransferSession({ session_id: sessionId, bytesDone: done } as any, baseDir);
    });
    return done;
  }, params.plan.totalBytes);
}
export function startDownloadAsync(params: Common & { plan: DownloadPlan }) {
  return startTransfer("download", params, async (abort, sessionId, baseDir) => {
    let done = 0;
    for (const file of params.plan.files) appendLog(sessionId, `get ${file.remote} -> ${file.local}`, baseDir);
    await performDownload(params.client, params.plan, abort.signal, (file) => {
      done += file.size ?? 0;
      setTransferSession({ session_id: sessionId, bytesDone: done } as any, baseDir);
    });
    return done;
  }, params.plan.totalBytes);
}
function startTransfer(
  direction: "upload" | "download",
  params: Common,
  run: (abort: AbortController, sessionId: string, baseDir: string) => Promise<number>,
  bytesTotal: number
) {
  const baseDir = getOctsshDir();
  const sessionId = crypto.randomUUID();
  const logPath = appendLog(sessionId, `${direction} start: ${params.localPath} <-> ${params.remotePath}`, baseDir);
  saveSession({ kind: "transfer", session_id: sessionId, machine: params.machine, createdAt: nowIso(), updatedAt: nowIso(), status: "running", direction, localPath: params.localPath, remotePath: params.remotePath, bytesTotal, bytesDone: 0, localLogPath: logPath }, baseDir);
  const abort = new AbortController();
  const done = (async () => {
    try {
      const bytesDone = await run(abort, sessionId, baseDir);
      appendLog(sessionId, `${direction} done`, baseDir);
      setTransferSession({ session_id: sessionId, status: "done", bytesDone } as any, baseDir);
    } catch (err: any) {
      const aborted = abort.signal.aborted;
      const message = aborted ? "cancelled" : String(err?.message ?? err);
      appendLog(sessionId, `${direction} failed: ${message}`, baseDir);
      setTransferSession({ session_id: sessionId, status: aborted ? "cancelled" : "failed", error: message } as any, baseDir);
    } finally {
      runtimes.delete(sessionId);
      params.release();
    }
  })();
  runtimes.set(sessionId, { abort, done });
  return { session_id: sessionId };
}
