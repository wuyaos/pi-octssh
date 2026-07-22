import fs from "node:fs";
import path from "node:path";
import { loadSession } from "./sessions.ts";

export function listSessionIds(baseDir: string) {
  const dir = path.join(baseDir, "sessions");
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -".json".length));
  } catch (err: any) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

export function findExpiredSessions(params: {
  baseDir: string;
  retentionDays: number;
  now?: Date;
}) {
  const now = params.now ?? new Date();
  const cutoff = now.getTime() - params.retentionDays * 24 * 60 * 60 * 1000;

  const expired = [];
  for (const id of listSessionIds(params.baseDir)) {
    const rec = loadSession(id, params.baseDir);
    if (!rec) continue;
    if (rec.status === "running") continue;
    const t = Date.parse(rec.updatedAt || rec.createdAt);
    if (!Number.isFinite(t)) continue;
    if (t < cutoff) expired.push(rec);
  }
  return expired;
}

export function deleteSessionFile(sessionId: string, baseDir: string) {
  const p = path.join(baseDir, "sessions", `${sessionId}.json`);
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // best-effort
  }
}
