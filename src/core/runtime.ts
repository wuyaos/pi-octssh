import crypto from "node:crypto";
import fs from "node:fs";
import type { Client } from "ssh2";
import { ConnectionPool, type ConnectionLease } from "../ssh/connectionPool.ts";
import { connectDirect, connectWithProxyJump, type ConnectedSsh } from "../ssh/connect.ts";
import { planMachineConnection } from "../ssh/machine.ts";
import { runCommand, type ExecResult as RawExecResult } from "../ssh/runCommand.ts";
import { wrapSh, wrapSudoSh, isSudoPasswordError, quoteForSh } from "../ssh/shell.ts";
import { discoverHostAliases } from "../ssh/config/hosts.ts";
import { loadConfig, type OctsshConfig } from "../state/config.ts";
import { getOctsshDir } from "../state/paths.ts";
import { startAsyncInScreen } from "../ssh/asyncScreen.ts";
import { loadSession, saveSession, type SessionRecord } from "../state/sessions.ts";
import { findExpiredSessions, deleteSessionFile } from "../state/cleanup.ts";
import { loadInventory, saveInventory } from "../state/inventory.ts";
import { collectExtendedInfo } from "../init/extended.ts";
import { guardExecCommand } from "../security/policy.ts";
import { planUpload, findUploadConflicts, performUpload } from "../transfer/upload.ts";
import { planDownload, findDownloadConflicts, performDownload } from "../transfer/download.ts";
import { startUploadAsync, startDownloadAsync, cancelTransfer, shutdownTransfers } from "../transfer/manager.ts";

export type RemotePlatform = "posix" | "windows" | "unknown";
type MachineConnection = { ssh: ConnectedSsh; warnings: string[]; platform: RemotePlatform };
export type ConfirmationPreview = { type: string; total: number; truncated: boolean; sample: string[] };
export type AuthorizationRequest = { id: string; operation: "exec" | "upload"; message: string; preview: ConfirmationPreview; expiresAt: number };
export type Authorization = { token: string };
export type NeedsConfirmation = { kind: "needs_confirmation"; authorizationRequest: AuthorizationRequest };
export type BlockedResult = { kind: "blocked"; reason: string; message: string };
export type RuntimeError = { kind: "error"; error: string };
export type ExecSuccess = { kind: "success"; machine: string; exitCode: number | null; stdout: string; stderr: string; truncated: RawExecResult["truncated"]; warnings: string[]; sudoHint?: string | null };

type AuthorizationRecord = { digest: string; expiresAt: number; consumed: boolean };
export interface OctsshRuntime {
  start(): void;
  shutdown(): Promise<void>;
  authorize(request: AuthorizationRequest): Authorization;
  listHosts(target?: string[]): Promise<unknown>;
  machineInfo(machine: string, refresh?: boolean, signal?: AbortSignal): Promise<unknown>;
  exec(params: { machine: string; command: string; sudo?: boolean; signal?: AbortSignal; authorization?: Authorization }): Promise<ExecSuccess | NeedsConfirmation | BlockedResult>;
  execAsync(params: { machine: string; command: string; sudo?: boolean; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  upload(params: { machine: string; localPath: string; remotePath: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  download(params: { machine: string; remotePath: string; localPath: string; signal?: AbortSignal }): Promise<unknown>;
  uploadAsync(params: { machine: string; localPath: string; remotePath: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  downloadAsync(params: { machine: string; remotePath: string; localPath: string; signal?: AbortSignal }): Promise<unknown>;
  getSession(sessionId: string, lines?: number): Promise<unknown>;
  grepSession(sessionId: string, pattern: string, options?: { maxMatches?: number; contextLines?: number }): Promise<unknown>;
  writeStdin(sessionId: string, data: string, options?: { appendNewline?: boolean }): Promise<unknown>;
  cancelSession(sessionId: string, signal?: string): Promise<unknown>;
}

const isoNow = () => new Date().toISOString();
type TransferSession = Extract<SessionRecord, { kind: "transfer" }>;
type LocalSession = Extract<SessionRecord, { kind: "local" }>;
function isTransferSession(rec: SessionRecord): rec is TransferSession { return "kind" in rec && rec.kind === "transfer"; }
function isLocalSession(rec: SessionRecord): rec is LocalSession { return "kind" in rec && rec.kind === "local"; }
function tailLocalFile(filePath: string, lines: number) {
  try { return fs.readFileSync(filePath, "utf8").split(/\r?\n/).slice(-lines).filter(Boolean).join("\n"); } catch { return ""; }
}
function toHomeAbs(remotePath: string) {
  const p = remotePath.trim();
  if (p.startsWith("~/")) return `$HOME/${p.slice(2)}`;
  if (p.startsWith(".")) return `$HOME/${p}`;
  return p;
}
function digest(operation: string, payload: unknown) {
  return crypto.createHash("sha256").update(`${operation}\0${JSON.stringify(payload)}`).digest("hex");
}
async function detectRemotePlatform(client: Client, signal?: AbortSignal): Promise<RemotePlatform> {
  try {
    const result = await runCommand(client, "uname -s 2>/dev/null || ver", { maxStdoutBytes: 1024, maxStderrBytes: 1024, signal });
    const text = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (text.includes("windows") || text.includes("microsoft")) return "windows";
    if (result.exitCode === 0 && text.trim()) return "posix";
  } catch { /* unknown */ }
  return "unknown";
}

class Runtime implements OctsshRuntime {
  private readonly cfg: OctsshConfig;
  private readonly pool: ConnectionPool<string, MachineConnection>;
  private sweepTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private started = false;
  private shuttingDown = false;
  private generation = 0;
  private readonly authRequests = new Map<string, AuthorizationRecord>();
  private readonly grants = new Map<string, AuthorizationRecord>();

  constructor() {
    this.cfg = loadConfig(getOctsshDir());
    this.pool = new ConnectionPool({
      create: async (machine: string, signal?: AbortSignal) => {
        const plan = planMachineConnection(machine);
        const ssh = plan.jump
          ? await connectWithProxyJump({ jump: { ...plan.jump, signal }, target: { ...plan.target, signal }, signal })
          : await connectDirect({ ...plan.target, signal });
        const platform = await detectRemotePlatform(ssh.client, signal);
        const connection: MachineConnection = { ssh, warnings: plan.warnings, platform };
        // connectSsh2 keeps an error listener to prevent ssh2 EventEmitter
        // crashes. Pooling must additionally discard that client: otherwise a
        // disconnected socket remains reusable until its idle TTL expires.
        const invalidate = () => { void this.pool.invalidate(machine, connection).catch(() => undefined); };
        ssh.client.on("error", invalidate);
        ssh.client.on("close", invalidate);
        return connection;
      },
      close: (value) => value.ssh.end(),
      options: { maxConnections: this.cfg.maxConnections, idleTtlMs: this.cfg.idleTtlSeconds * 1000 },
    });
  }

  start() {
    if (this.started && !this.shuttingDown) return;
    if (this.shuttingDown) throw new Error("OctSSH runtime is shutting down");
    this.started = true;
    const generation = ++this.generation;
    this.sweepTimer = setInterval(() => { if (this.isCurrent(generation)) this.pool.sweep().catch(() => undefined); }, Math.min(this.cfg.idleTtlSeconds * 1000, 60_000));
    this.sweepTimer.unref();
    this.cleanupTimer = setInterval(() => { if (this.isCurrent(generation)) this.cleanupExpired(generation).catch(() => undefined); }, 60 * 60 * 1000);
    this.cleanupTimer.unref();
  }

  async shutdown() {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.started = false;
    this.generation += 1;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.sweepTimer = undefined;
    this.cleanupTimer = undefined;
    this.authRequests.clear();
    this.grants.clear();
    await shutdownTransfers("interrupted by runtime shutdown");
    await this.pool.closeAll();
  }

  authorize(request: AuthorizationRequest): Authorization {
    this.ensureActive();
    const rec = this.authRequests.get(request.id);
    this.authRequests.delete(request.id);
    if (!rec || rec.consumed || rec.expiresAt < Date.now() || request.expiresAt !== rec.expiresAt) throw new Error("Confirmation request expired or invalid");
    const token = crypto.randomUUID();
    this.grants.set(token, rec);
    return { token };
  }

  async listHosts(target?: string[]) {
    this.ensureActive();
    const hosts = discoverHostAliases();
    const inv = loadInventory(getOctsshDir());
    if (!target || !inv?.extended) return { hosts };
    const byName = new Map(inv.machines.map((m) => [m.name, m]));
    return { machines: hosts.map((name) => Object.fromEntries([["name", name], ...target.filter((k) => Object.prototype.hasOwnProperty.call(byName.get(name) ?? {}, k)).map((k) => [k, (byName.get(name) as any)[k]])])), target };
  }

  async machineInfo(machine: string, refresh = false, signal?: AbortSignal) {
    this.ensureActive();
    const inv = loadInventory(getOctsshDir());
    if (!refresh) return inv?.machines.find((m) => m.name === machine) ?? { error: "No cached info. Refresh this machine first." };
    const lease = await this.pool.get(machine, signal);
    try {
      const info = await collectExtendedInfo(lease.value.ssh.client);
      const updated = { name: machine, updatedAt: isoNow(), ...info };
      const existing = inv ?? { extended: true, machines: [] };
      saveInventory({ extended: true, machines: [...existing.machines.filter((m) => m.name !== machine), updated] }, getOctsshDir());
      return { ...updated, platform: lease.value.platform, warnings: lease.value.warnings };
    } finally { lease.release(); }
  }

  async exec(params: { machine: string; command: string; sudo?: boolean; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    try {
      if (params.sudo && lease.value.platform === "windows") return { kind: "blocked", reason: "unsupported_remote_platform", message: "remote Windows does not support screen/sudo" } as BlockedResult;
      const payload = { machine: params.machine, command: params.command, sudo: !!params.sudo, async: false };
      const authorized = this.consume(params.authorization, "exec", payload);
      const decision = await guardExecCommand({ client: lease.value.ssh.client, machine: params.machine, command: params.command, allowSudo: !!params.sudo, security: this.cfg.security, authorized, signal: params.signal });
      if (decision.action === "block") return { kind: "blocked", reason: decision.reason, message: decision.message } as BlockedResult;
      if (decision.action === "needs_confirmation") return this.requestAuthorization("exec", payload, decision.message, decision.preview);
      const result = await runCommand(lease.value.ssh.client, params.sudo ? wrapSudoSh(params.command) : wrapSh(params.command), { signal: params.signal });
      return { kind: "success", machine: params.machine, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, warnings: lease.value.warnings, sudoHint: params.sudo && result.exitCode !== 0 && isSudoPasswordError(result.stderr) ? "Passwordless sudo is required." : null } as ExecSuccess;
    } finally { lease.release(); }
  }

  async execAsync(params: { machine: string; command: string; sudo?: boolean; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    try {
      if (lease.value.platform === "windows") return { kind: "blocked", reason: "unsupported_remote_platform", message: "remote Windows does not support screen/sudo" };
      const payload = { machine: params.machine, command: params.command, sudo: !!params.sudo, async: true };
      const authorized = this.consume(params.authorization, "exec", payload);
      const decision = await guardExecCommand({ client: lease.value.ssh.client, machine: params.machine, command: params.command, allowSudo: !!params.sudo, security: this.cfg.security, authorized, signal: params.signal });
      if (decision.action === "block") return { kind: "blocked", reason: decision.reason, message: decision.message };
      if (decision.action === "needs_confirmation") return this.requestAuthorization("exec", payload, decision.message, decision.preview);
      return { kind: "success", ...(await startAsyncInScreen(lease.value.ssh.client, { machine: params.machine, command: params.command, sudo: !!params.sudo })) };
    } finally { lease.release(); }
  }

  async upload(params: { machine: string; localPath: string; remotePath: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    try {
      const plan = await planUpload(lease.value.ssh.client, params.localPath, params.remotePath, params.signal);
      const conflicts = await findUploadConflicts(lease.value.ssh.client, plan, params.signal);
      const payload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, conflicts };
      if (conflicts.length && !this.consume(params.authorization, "upload", payload)) return this.requestAuthorization("upload", payload, "Upload would overwrite existing remote files.", { type: "upload-conflicts", total: conflicts.length, truncated: conflicts.length > 10, sample: conflicts.slice(0, 10) });
      return { kind: "success", machine: params.machine, ...(await performUpload(lease.value.ssh.client, plan, params.signal)) };
    } finally { lease.release(); }
  }

  async download(params: { machine: string; remotePath: string; localPath: string; signal?: AbortSignal }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    try {
      const plan = await planDownload(lease.value.ssh.client, params.remotePath, params.localPath, params.signal);
      const conflicts = findDownloadConflicts(plan);
      if (conflicts.length) return { kind: "blocked", reason: "local_conflict", message: "Refusing to overwrite local files.", conflicts: conflicts.slice(0, 10), totalConflicts: conflicts.length };
      return { kind: "success", machine: params.machine, ...(await performDownload(lease.value.ssh.client, plan, params.signal)) };
    } finally { lease.release(); }
  }

  async uploadAsync(params: { machine: string; localPath: string; remotePath: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    let handedOff = false;
    try {
      const plan = await planUpload(lease.value.ssh.client, params.localPath, params.remotePath, params.signal);
      const conflicts = await findUploadConflicts(lease.value.ssh.client, plan, params.signal);
      const payload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, conflicts, async: true };
      if (conflicts.length && !this.consume(params.authorization, "upload", payload)) return this.requestAuthorization("upload", payload, "Async upload would overwrite existing remote files.", { type: "upload-conflicts", total: conflicts.length, truncated: conflicts.length > 10, sample: conflicts.slice(0, 10) });
      handedOff = true;
      return { kind: "success", ...startUploadAsync({ client: lease.value.ssh.client, machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, plan, release: lease.release }) };
    } finally { if (!handedOff) lease.release(); }
  }

  async downloadAsync(params: { machine: string; remotePath: string; localPath: string; signal?: AbortSignal }) {
    this.ensureActive();
    const lease = await this.pool.get(params.machine, params.signal);
    let handedOff = false;
    try {
      const plan = await planDownload(lease.value.ssh.client, params.remotePath, params.localPath, params.signal);
      const conflicts = findDownloadConflicts(plan);
      if (conflicts.length) return { kind: "blocked", reason: "local_conflict", message: "Refusing to overwrite local files.", conflicts: conflicts.slice(0, 10), totalConflicts: conflicts.length };
      handedOff = true;
      return { kind: "success", ...startDownloadAsync({ client: lease.value.ssh.client, machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, plan, release: lease.release }) };
    } finally { if (!handedOff) lease.release(); }
  }

  async getSession(sessionId: string, lines?: number) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec) return { kind: "error", error: "session not found" };
    if (isTransferSession(rec)) return { ...rec, resultKind: "success", tails: lines && rec.localLogPath ? { log: tailLocalFile(rec.localLogPath, Math.min(2000, Math.max(1, lines))) } : null };
    if (isLocalSession(rec)) return { kind: "error", error: "legacy local sessions are not supported" };
    const lease = await this.pool.get(rec.machine);
    try {
      const meta = await runCommand(lease.value.ssh.client, wrapSh(`test -f "${toHomeAbs(rec.metaPath)}" && cat "${toHomeAbs(rec.metaPath)}" || true`), { maxStdoutBytes: 16 * 1024, maxStderrBytes: 4096 });
      let remoteMeta: any = null; try { remoteMeta = meta.stdout.trim() ? JSON.parse(meta.stdout) : null; } catch { /* ignore */ }
      let status = rec.status; let exitCode = rec.exitCode ?? null;
      if (remoteMeta?.status === "running") status = "running";
      if (remoteMeta?.status === "done") { status = remoteMeta.exitCode === 0 ? "done" : "failed"; exitCode = typeof remoteMeta.exitCode === "number" ? remoteMeta.exitCode : exitCode; }
      if (status !== rec.status || exitCode !== (rec.exitCode ?? null)) saveSession({ ...rec, status, exitCode: exitCode ?? undefined, updatedAt: isoNow() }, getOctsshDir());
      let tails: any = null;
      if (lines) {
        const n = Math.min(2000, Math.max(1, Math.floor(lines)));
        const out = await runCommand(lease.value.ssh.client, wrapSh(`tail -n ${n} "${toHomeAbs(rec.stdoutPath)}" 2>/dev/null || true`));
        const err = await runCommand(lease.value.ssh.client, wrapSh(`tail -n ${n} "${toHomeAbs(rec.stderrPath)}" 2>/dev/null || true`));
        tails = { stdout: out.stdout, stderr: err.stdout };
      }
      return { kind: "success", session_id: sessionId, machine: rec.machine, status, exitCode, screenName: rec.screenName, cmdPid: rec.cmdPid ?? null, tails };
    } finally { lease.release(); }
  }

  async grepSession(sessionId: string, pattern: string, options: { maxMatches?: number; contextLines?: number } = {}) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec || isTransferSession(rec) || isLocalSession(rec)) return { kind: "error", error: "remote session not found" };
    const lease = await this.pool.get(rec.machine);
    try {
      const m = Math.min(500, Math.max(1, options.maxMatches ?? 50)); const c = Math.min(50, Math.max(0, options.contextLines ?? 2));
      const grep = (file: string) => wrapSh(`command -v grep >/dev/null 2>&1 && grep -n -E -m ${m} -C ${c} -e ${quoteForSh(pattern)} "${toHomeAbs(file)}" 2>/dev/null || true`);
      const stdout = await runCommand(lease.value.ssh.client, grep(rec.stdoutPath));
      const stderr = await runCommand(lease.value.ssh.client, grep(rec.stderrPath));
      return { kind: "success", session_id: sessionId, pattern, matches: { stdout: stdout.stdout, stderr: stderr.stdout } };
    } finally { lease.release(); }
  }

  async writeStdin(sessionId: string, data: string, options: { appendNewline?: boolean } = {}) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec || isTransferSession(rec) || isLocalSession(rec) || !rec.stdinPath || !rec.stdinLogPath) return { kind: "error", error: "stdin is not available for this session" };
    if (rec.status !== "running") return { kind: "error", error: "session is not running" };
    const payload = Buffer.from(options.appendNewline === false ? data : `${data}\n`, "utf8");
    if (payload.byteLength > 64 * 1024) return { kind: "error", error: "payload too large (max 64KiB)" };
    const lease = await this.pool.get(rec.machine);
    try {
      const encoded = payload.toString("base64");
      const command = [`command -v base64 >/dev/null 2>&1 || exit 1`, `stdin="${toHomeAbs(rec.stdinPath)}"`, `stdinlog="${toHomeAbs(rec.stdinLogPath)}"`, `test -p "$stdin" || exit 1`, `printf %s ${quoteForSh(encoded)} | base64 -d | tee -a "$stdinlog" > "$stdin"`].join("; ");
      const result = await runCommand(lease.value.ssh.client, wrapSh(command), { maxStdoutBytes: 8192, maxStderrBytes: 8192 });
      if (result.exitCode !== 0) return { kind: "error", error: result.stderr || "failed to write stdin" };
      return { kind: "success", session_id: sessionId, bytes: payload.byteLength };
    } finally { lease.release(); }
  }

  async cancelSession(sessionId: string, signal?: string) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec) return { kind: "error", error: "session not found" };
    if (isTransferSession(rec)) {
      const aborted = cancelTransfer(sessionId);
      saveSession({ ...rec, status: "cancelled", error: aborted ? "cancelled" : "cancel requested (no active runtime)", updatedAt: isoNow() }, getOctsshDir());
      return { kind: "success", session_id: sessionId, status: "cancelled", aborted };
    }
    if (isLocalSession(rec)) return { kind: "error", error: "legacy local sessions are not supported" };
    if (rec.status !== "running") return { kind: "success", session_id: sessionId, status: rec.status };
    const lease = await this.pool.get(rec.machine);
    try {
      const sig = /^[A-Z0-9]+$/.test((signal ?? "TERM").toUpperCase()) ? (signal ?? "TERM").toUpperCase() : "TERM";
      const parts = rec.cmdPid ? [`kill -s ${sig} ${rec.cmdPid} 2>/dev/null || true`] : [];
      parts.push(`screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`);
      await runCommand(lease.value.ssh.client, wrapSh(parts.join("; ")));
      saveSession({ ...rec, status: "cancelled", updatedAt: isoNow() }, getOctsshDir());
      return { kind: "success", session_id: sessionId, status: "cancelled", signal: sig };
    } finally { lease.release(); }
  }

  private requestAuthorization(operation: "exec" | "upload", payload: unknown, message: string, preview: ConfirmationPreview): NeedsConfirmation {
    const id = crypto.randomUUID(); const expiresAt = Date.now() + 60_000;
    this.authRequests.set(id, { digest: digest(operation, payload), expiresAt, consumed: false });
    return { kind: "needs_confirmation", authorizationRequest: { id, operation, message, preview, expiresAt } };
  }
  private consume(auth: Authorization | undefined, operation: "exec" | "upload", payload: unknown) {
    if (!auth) return false;
    const rec = this.grants.get(auth.token); this.grants.delete(auth.token);
    if (!rec || rec.consumed || rec.expiresAt < Date.now() || rec.digest !== digest(operation, payload)) return false;
    rec.consumed = true; return true;
  }
  private ensureActive() { if (!this.started || this.shuttingDown) throw new Error("OctSSH runtime is not running"); }
  private isCurrent(generation: number) { return this.started && !this.shuttingDown && this.generation === generation; }
  private async cleanupExpired(generation: number) {
    for (const rec of findExpiredSessions({ baseDir: getOctsshDir(), retentionDays: loadConfig(getOctsshDir()).retentionDays })) {
      if (!this.isCurrent(generation)) return;
      if (isTransferSession(rec)) { if (rec.localLogPath) fs.rmSync(rec.localLogPath, { force: true }); deleteSessionFile(rec.session_id, getOctsshDir()); continue; }
      if (isLocalSession(rec)) { deleteSessionFile(rec.session_id, getOctsshDir()); continue; }
      try {
        const lease = await this.pool.get(rec.machine);
        try { if (lease.value.platform !== "windows") await runCommand(lease.value.ssh.client, wrapSh(`rm -rf "$HOME/${rec.remoteDir}" 2>/dev/null || true; screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`)); } finally { lease.release(); }
      } catch { /* best effort */ }
      if (this.isCurrent(generation)) deleteSessionFile(rec.session_id, getOctsshDir());
    }
  }
}

export function createOctsshRuntime(): OctsshRuntime { return new Runtime(); }
