import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.js";
import { getOctsshDir } from "./paths.js";

const remoteScreenSessionSchema = z
  .object({
    session_id: z.string().min(1),
    machine: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    status: z.enum(["running", "done", "failed", "cancelled"]),

    // Remote `screen` session name (e.g. octssh-<id>)
    screenName: z.string().min(1),

    // Prefer storing both PIDs when known.
    screenPid: z.number().int().positive().optional(),
    cmdPid: z.number().int().positive().optional(),

    // Remote paths under ~/.octssh/runs/<session_id>/
    remoteDir: z.string().min(1),
    stdoutPath: z.string().min(1),
    stderrPath: z.string().min(1),
    metaPath: z.string().min(1),

    stdinPath: z.string().min(1).optional(),
    stdinLogPath: z.string().min(1).optional(),

    exitCode: z.number().int().optional()
  })
  .strict();

const transferSessionSchema = z
  .object({
    kind: z.literal("transfer"),
    session_id: z.string().min(1),
    machine: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    status: z.enum(["running", "done", "failed", "cancelled"]),

    direction: z.enum(["upload", "download"]),
    localPath: z.string().min(1),
    remotePath: z.string().min(1),

    bytesTotal: z.number().int().nonnegative().optional(),
    bytesDone: z.number().int().nonnegative().optional(),

    // Local log file for get-result(lines).
    localLogPath: z.string().min(1).optional(),
    error: z.string().optional()
  })
  .strict();

const localProcessSessionSchema = z
  .object({
    kind: z.literal("local"),
    session_id: z.string().min(1),
    machine: z.string().min(1),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
    status: z.enum(["running", "done", "failed", "cancelled"]),

    // Local background execution PID (best-effort).
    cmdPid: z.number().int().positive().optional(),

    // Local paths under <OCTSSH_HOME>/runs/<session_id>/
    runDir: z.string().min(1),
    stdoutPath: z.string().min(1),
    stderrPath: z.string().min(1),
    metaPath: z.string().min(1),

    stdinPath: z.string().min(1).optional(),
    stdinLogPath: z.string().min(1).optional(),

    exitCode: z.number().int().optional(),
  })
  .strict();

export const sessionRecordSchema = z.union([
  remoteScreenSessionSchema,
  transferSessionSchema,
  localProcessSessionSchema,
]);

export type SessionRecord = z.infer<typeof sessionRecordSchema>;

export function getSessionsDir(baseDir?: string) {
  const root = baseDir ?? getOctsshDir();
  return path.join(root, "sessions");
}

export function getSessionPath(sessionId: string, baseDir?: string) {
  return path.join(getSessionsDir(baseDir), `${sessionId}.json`);
}

export function loadSession(sessionId: string, baseDir?: string): SessionRecord | null {
  const p = getSessionPath(sessionId, baseDir);
  const json = readJsonIfExistsSync<unknown>(p);
  if (!json) return null;
  return sessionRecordSchema.parse(json);
}

export function saveSession(record: SessionRecord, baseDir?: string) {
  const normalized = sessionRecordSchema.parse(record);
  const p = getSessionPath(normalized.session_id, baseDir);
  atomicWriteFileSync(p, JSON.stringify(normalized, null, 2) + "\n");
}
