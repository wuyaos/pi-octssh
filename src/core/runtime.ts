import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import type { Client } from "ssh2";
import { ConnectionPool, type ConnectionLease } from "../ssh/connectionPool.ts";
import { connectDirect, connectWithProxyJump, type ConnectedSsh } from "../ssh/connect.ts";
import { planMachineConnection, resolveIdentity } from "../ssh/machine.ts";
import { createHostVerifier, type HostKeyConfirm } from "../ssh/hostVerifier.ts";
import { displayIdentity, identityKey, type SshIdentity } from "../security/identity.ts";
import { invalidateCredential, requestCredential, type CredentialPrompt } from "../ssh/credentials.ts";
import { evaluateForProject, type EvaluationResult, type OperationRequest } from "../security/evaluate.ts";
import { execRequest, fileRequest, type OperationScope } from "../security/authorize.ts";
import type { ManagedOperation } from "../security/rules.ts";
import type { SshAuthOptions } from "../ssh/connect.ts";
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
import { startUploadAsync, startDownloadAsync, cancelTransfer, listActiveTransfers, shutdownTransfers } from "../transfer/manager.ts";
import { withSftp, type SftpClient } from "../ssh/sftp.ts";
import { applyEdit, type RemoteFileOps, type ApplyEditResult } from "../remote/applyEdit.ts";
import { createSftpFileOps } from "../remote/sftpFileOps.ts";
import { readRemoteFile, type ReadRemoteFileResult } from "../remote/readFile.ts";
import { buildStatCommand, parseStatOutput, nextTemplateToTry, type StatTemplate } from "../remote/fingerprint.ts";
import { createTaskStore, type TaskStore } from "../tasks/store.ts";
import { createDelivery, type NotificationPayload } from "../tasks/delivery.ts";
import { runTaskSweep, type SweepSummary } from "../tasks/notify.ts";
import type { TaskObservation, TaskRecord, TaskState } from "../tasks/state.ts";
import { listSessionIds } from "../state/cleanup.ts";

export type RemotePlatform = "posix" | "windows" | "unknown";
type MachineConnection = { ssh: ConnectedSsh; warnings: string[]; platform: RemotePlatform };
export type ConfirmationPreview = { type: string; total: number; truncated: boolean; sample: string[] };
export type AuthorizationRequest = {
  id: string;
  operation: string;
  message: string;
  preview: ConfirmationPreview;
  expiresAt: number;
  /** 本次操作的可持久化范围；扩展层据此生成「始终允许/禁止」规则。 */
  scope?: OperationScope;
  /** 范围是否可安全持久化（涉及文件过多或预览被截断时为 false）。 */
  allowPermanent?: boolean;
};
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
  // projectId 由宿主从 ctx.cwd 算得后传入；模型无法提供，运行时也不接受来自工具参数的规则。
  exec(params: { machine: string; command: string; sudo?: boolean; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<ExecSuccess | NeedsConfirmation | BlockedResult>;
  execAsync(params: { machine: string; command: string; sudo?: boolean; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  upload(params: { machine: string; localPath: string; remotePath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  download(params: { machine: string; remotePath: string; localPath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  uploadAsync(params: { machine: string; localPath: string; remotePath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  downloadAsync(params: { machine: string; remotePath: string; localPath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<unknown>;
  setNotifyHooks(hooks: {
    channel: (event: { projectId: string }) => "ready" | "busy" | "no_session";
    sink: (payload: NotificationPayload) => void;
  }): void;
  sweepTasks(params?: { projectId?: string; hasSessionForProject?: (projectId: string) => boolean }): Promise<SweepSummary & { storeCorruptReported: boolean; deliveredPruned: number }>;
  flushTaskNotifications(): Promise<{ delivered: number; remaining: number }>;
  listTasks(params?: { projectId?: string; includeAllProjects?: boolean }): {
    tasks: TaskRecord[];
    notAwakened: { taskId: string; reason: string }[];
  };
  pruneTaskDelivered(options?: { maxAgeMs?: number; maxEntries?: number }): { removed: number; kept: number };
  taskStoreStatus(): { storeCorrupt: boolean; corruptFiles: { file: string; renamedTo: string; error: string }[] };
  /** 连接池实况：`/octssh status` 展示用。`size` 是当前缓存的连接数（含空闲）。 */
  poolStats(): { connections: number; maxConnections: number };
  /** 进程内仍在跑的异步传输；清凭据前用它判断断开会踩到什么。 */
  activeTransfers(): { sessionId: string; direction: "upload" | "download"; machine: string; localPath: string; remotePath: string }[];
  /** 清凭据并「退出登录」用：断开所有缓存连接，但运行时继续可用。返回断开条数。 */
  dropConnections(): Promise<number>;
  readFile(params: { machine: string; path: string; offset?: number; limit?: number; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<ReadRemoteFileResult | BlockedResult | NeedsConfirmation>;
  editFile(params: { machine: string; path: string; expectedVersion: string; oldText: string; newText: string; dryRun?: boolean; projectId?: string; signal?: AbortSignal; authorization?: Authorization }): Promise<ApplyEditResult | NeedsConfirmation | BlockedResult>;
  getSession(sessionId: string, lines?: number, projectId?: string): Promise<unknown>;
  grepSession(sessionId: string, pattern: string, options?: { maxMatches?: number; contextLines?: number }, projectId?: string): Promise<unknown>;
  writeStdin(sessionId: string, data: string, options?: { appendNewline?: boolean }, projectId?: string, authorization?: Authorization): Promise<unknown>;
  cancelSession(sessionId: string, signal?: string, projectId?: string, authorization?: Authorization): Promise<unknown>;
}

/** lstat 适配：把 ssh2 attrs 收窄成编排需要的形状。 */
async function lstatVia(sftp: SftpClient, p: string) {
  const attrs = await sftpLstatLocal(sftp, p);
  if (!attrs) return null;
  const kind = typeof attrs.isSymbolicLink === "function" && attrs.isSymbolicLink()
    ? "symlink"
    : typeof attrs.isDirectory === "function" && attrs.isDirectory()
      ? "directory"
      : typeof attrs.isFile === "function" && attrs.isFile()
        ? "file"
        : "other";
  return {
    mode: attrs.mode,
    uid: attrs.uid,
    gid: attrs.gid,
    size: attrs.size,
    atime: attrs.atime,
    mtime: attrs.mtime,
    kind: kind as "file" | "directory" | "symlink" | "other",
  };
}

async function sftpLstatLocal(sftp: SftpClient, p: string): Promise<any | null> {
  return new Promise((resolve, reject) => {
    sftp.lstat(p, (err: any, stats: any) => {
      if (!err) return resolve(stats);
      if (err?.code === 2 || err?.code === "ENOENT" || err?.code === "ENOTDIR") return resolve(null);
      reject(err);
    });
  });
}

/** 整文件读取到 Buffer（编辑流程需要完整字节，不能流式截断）。 */
async function readAllVia(sftp: SftpClient, p: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const stream = sftp.createReadStream(p);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/** session 记录状态 → 任务状态。 */
function mapSessionStatus(status: string): TaskState {
  switch (status) {
    case "running":
      return "running";
    case "done":
      return "done";
    case "cancelled":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    default:
      return "failed";
  }
}

const isoNow = () => new Date().toISOString();

/** 超过这个数量的文件不提供「始终允许」：范围不可完整展示即不可永久授权。 */
const MAX_PERMANENT_SCOPE = 10;
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
  private readonly hostKeyConfirmProvider?: () => HostKeyConfirm | undefined;
  private readonly credentialPromptProvider?: () => CredentialPrompt | undefined;
  /** 每台机器可用的 stat 模板；null 表示都不可用。 */
  private readonly statTemplates = new Map<string, StatTemplate | null>();
  private readonly taskStore: TaskStore;
  private readonly taskDelivery: ReturnType<typeof createDelivery>;
  /** 通知投递通道：由扩展层注入（决定 ready/busy/no_session）。 */
  private notifyChannel?: (event: { projectId: string }) => "ready" | "busy" | "no_session";
  private notifySink?: (payload: NotificationPayload) => void;
  /** 存储损坏只提示一次，反复扫描不重复打扰。 */
  private taskStoreCorruptReported = false;
  private readonly pool: ConnectionPool<string, MachineConnection>;
  private sweepTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;
  private started = false;
  private shuttingDown = false;
  private generation = 0;
  private readonly authRequests = new Map<string, AuthorizationRecord>();
  private readonly grants = new Map<string, AuthorizationRecord>();

  constructor(
    options: { hostKeyConfirm?: () => HostKeyConfirm | undefined; credentialPrompt?: () => CredentialPrompt | undefined } = {},
  ) {
    this.cfg = loadConfig(getOctsshDir());
    this.hostKeyConfirmProvider = options.hostKeyConfirm;
    this.taskStore = createTaskStore({ baseDir: getOctsshDir() });
    this.taskDelivery = createDelivery({
      store: this.taskStore,
      self: { holderId: `${process.pid}-${Date.now()}`, hostname: os.hostname(), pid: process.pid, acquiredAt: Date.now() },
      channelState: (event) => this.notifyChannel?.(event) ?? "no_session",
      send: (payload) => this.notifySink?.(payload),
    });
    this.credentialPromptProvider = options.credentialPrompt;
    this.pool = new ConnectionPool({
      create: async (machine: string, signal?: AbortSignal) => {
        const plan = planMachineConnection(machine);
        // 主机密钥校验按真实端点构造：身份来自 ssh_config 解析结果，不是别名。
        const identity = resolveIdentity(machine);
        const confirm = this.getHostKeyConfirm();
        const hostVerifier = createHostVerifier({ identity, confirm });
        // 跳板机是链路上另一台真实主机，同样校验；否则「校验目标机」可以被中间人从跳板段绕过。
        const jumpVerifier = plan.jump
          ? createHostVerifier({
              identity: {
                alias: `${machine}~jump`,
                host: plan.jump.host,
                port: plan.jump.port,
                user: plan.jump.username,
              },
              confirm,
            })
          : undefined;
        const authTarget = this.buildAuthOptions(identity, plan.target.privateKey);
        const authJump = plan.jump
          ? this.buildAuthOptions(
              { alias: `${machine}~jump`, host: plan.jump.host, port: plan.jump.port, user: plan.jump.username },
              plan.jump.privateKey,
            )
          : undefined;
        const ssh = plan.jump
          ? await connectWithProxyJump({
              jump: { ...plan.jump, signal, hostVerifier: jumpVerifier, auth: authJump },
              target: { ...plan.target, signal, hostVerifier, auth: authTarget },
              signal,
            })
          : await connectDirect({ ...plan.target, signal, hostVerifier, auth: authTarget });
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

  async exec(params: { machine: string; command: string; sudo?: boolean; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    // 规则 deny 在建立连接之前判定：被禁止的操作不该先握手再报错。
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = {
      operation: "exec",
      identity,
      command: { value: params.command, sudo: !!params.sudo },
    };
    const pre = this.decide(params.projectId, execRequest({ operation: "exec", identity, command: params.command, sudo: !!params.sudo }));
    if (pre.decision === "deny") return this.denyResult(pre);

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      if (params.sudo && lease.value.platform === "windows") return { kind: "blocked", reason: "unsupported_remote_platform", message: "remote Windows does not support screen/sudo" } as BlockedResult;
      const payload = { machine: params.machine, command: params.command, sudo: !!params.sudo, async: false };
      const authorized = this.consume(params.authorization, "exec", payload);
      const guard = await guardExecCommand({ client: lease.value.ssh.client, machine: params.machine, command: params.command, allowSudo: !!params.sudo, security: this.cfg.security, authorized, signal: params.signal });

      // 内建硬禁止永远优先：项目 allow 不能覆盖它。
      const request = execRequest({ operation: "exec", identity, command: params.command, sudo: !!params.sudo, guard });
      const post = this.decide(params.projectId, request);
      if (post.decision === "deny") {
        return guard.action === "block"
          ? ({ kind: "blocked", reason: guard.reason, message: guard.message } as BlockedResult)
          : this.denyResult(post);
      }

      const needsConfirm = guard.action === "needs_confirmation" || post.decision === "ask";
      // authorized=true 表示调用方已为本次 payload 消费过一次性授权：
      // ask 再拦一次会形成「确认→重试→仍 ask」的无限确认循环。
      if (needsConfirm && post.decision !== "allow" && !authorized) {
        const preview = guard.action === "needs_confirmation" ? guard.preview : this.askPreview(post.rule ? `Matched project rule ${post.rule.id} (ask).` : "No project rule matched; confirmation required.");
        const message = guard.action === "needs_confirmation" ? guard.message : "该操作需要确认。";
        return this.requestAuthorization("exec", payload, message, preview, scope);
      }

      const result = await runCommand(lease.value.ssh.client, params.sudo ? wrapSudoSh(params.command) : wrapSh(params.command), { signal: params.signal });
      return { kind: "success", machine: params.machine, exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, truncated: result.truncated, warnings: lease.value.warnings, sudoHint: params.sudo && result.exitCode !== 0 && isSudoPasswordError(result.stderr) ? "Passwordless sudo is required." : null } as ExecSuccess;
    } finally { lease.release(); }
  }

  async execAsync(params: { machine: string; command: string; sudo?: boolean; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = {
      operation: "exec-async",
      identity,
      command: { value: params.command, sudo: !!params.sudo },
    };
    const pre = this.decide(params.projectId, execRequest({ operation: "exec-async", identity, command: params.command, sudo: !!params.sudo }));
    if (pre.decision === "deny") return this.denyResult(pre);

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      if (lease.value.platform === "windows") return { kind: "blocked", reason: "unsupported_remote_platform", message: "remote Windows does not support screen/sudo" };
      const payload = { machine: params.machine, command: params.command, sudo: !!params.sudo, async: true };
      const authorized = this.consume(params.authorization, "exec", payload);
      const guard = await guardExecCommand({ client: lease.value.ssh.client, machine: params.machine, command: params.command, allowSudo: !!params.sudo, security: this.cfg.security, authorized, signal: params.signal });

      const request = execRequest({ operation: "exec-async", identity, command: params.command, sudo: !!params.sudo, guard });
      const post = this.decide(params.projectId, request);
      if (post.decision === "deny") {
        return guard.action === "block"
          ? { kind: "blocked", reason: guard.reason, message: guard.message }
          : this.denyResult(post);
      }

      const needsConfirm = guard.action === "needs_confirmation" || post.decision === "ask";
      if (needsConfirm && post.decision !== "allow" && !authorized) {
        const preview = guard.action === "needs_confirmation" ? guard.preview : this.askPreview(post.rule ? `Matched project rule ${post.rule.id} (ask).` : "No project rule matched; confirmation required.");
        const message = guard.action === "needs_confirmation" ? guard.message : "该操作需要确认。";
        return this.requestAuthorization("exec", payload, message, preview, scope);
      }

      return { kind: "success", ...(await startAsyncInScreen(lease.value.ssh.client, { machine: params.machine, command: params.command, sudo: !!params.sudo })) };
    } finally { lease.release(); }
  }

  async upload(params: { machine: string; localPath: string; remotePath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = { operation: "upload", identity, path: { value: params.remotePath, subtree: false } };
    const pre = this.decide(params.projectId, fileRequest({ operation: "upload", identity, remotePath: params.remotePath }));
    if (pre.decision === "deny") return this.denyResult(pre);

    // 项目规则 ask 在建立连接之前就问：这是策略层结论，不需要先握手。
    // 与「覆盖冲突」用不同 payload，两者是独立的确认理由，各自一次性有效。
    const askPayload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, reason: "project-ask" };
    if (pre.decision === "ask" && !this.consume(params.authorization, "upload", askPayload)) {
      return this.requestAuthorization(
        "upload", askPayload, "This upload needs confirmation (project rule).",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        { ...scope, operation: "upload" },
        false,
      );
    }

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      const plan = await planUpload(lease.value.ssh.client, params.localPath, params.remotePath, params.signal);
      const conflicts = await findUploadConflicts(lease.value.ssh.client, plan, params.signal);
      const payload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, conflicts };
      if (conflicts.length && !this.consume(params.authorization, "upload", payload)) {
        // 涉及文件过多时不给「始终允许」：拿不到完整范围就不能授权整个目录。
        const allowPermanent = conflicts.length <= MAX_PERMANENT_SCOPE && !scope.path?.subtree;
        return this.requestAuthorization(
          "upload", payload, "Upload would overwrite existing remote files.",
          { type: "upload-conflicts", total: conflicts.length, truncated: conflicts.length > 10, sample: conflicts.slice(0, 10) },
          { ...scope, operation: "upload" },
          allowPermanent,
        );
      }
      return { kind: "success", machine: params.machine, ...(await performUpload(lease.value.ssh.client, plan, params.signal)) };
    } finally { lease.release(); }
  }

  async download(params: { machine: string; remotePath: string; localPath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = { operation: "download", identity, path: { value: params.remotePath, subtree: false } };
    const pre = this.decide(params.projectId, fileRequest({ operation: "download", identity, remotePath: params.remotePath }));
    if (pre.decision === "deny") return this.denyResult(pre);

    // 下载会在本地写文件，属于有副作用的操作：ask 必须真的问一次。
    const payload = { machine: params.machine, remotePath: params.remotePath, localPath: params.localPath, async: false };
    if (pre.decision === "ask" && !this.consume(params.authorization, "download", payload)) {
      return this.requestAuthorization(
        "download", payload, "This download needs confirmation (project rule).",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        scope,
      );
    }

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      const plan = await planDownload(lease.value.ssh.client, params.remotePath, params.localPath, params.signal);
      const conflicts = findDownloadConflicts(plan);
      if (conflicts.length) return { kind: "blocked", reason: "local_conflict", message: "Refusing to overwrite local files.", conflicts: conflicts.slice(0, 10), totalConflicts: conflicts.length };
      return { kind: "success", machine: params.machine, ...(await performDownload(lease.value.ssh.client, plan, params.signal)) };
    } finally { lease.release(); }
  }

  async uploadAsync(params: { machine: string; localPath: string; remotePath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = { operation: "upload-async", identity, path: { value: params.remotePath, subtree: false } };
    const pre = this.decide(params.projectId, fileRequest({ operation: "upload-async", identity, remotePath: params.remotePath }));
    if (pre.decision === "deny") return this.denyResult(pre);

    const askPayload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, reason: "project-ask", async: true };
    if (pre.decision === "ask" && !this.consume(params.authorization, "upload", askPayload)) {
      return this.requestAuthorization(
        "upload", askPayload, "This async upload needs confirmation (project rule).",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        scope,
        false,
      );
    }

    const lease = await this.pool.get(params.machine, params.signal);
    let handedOff = false;
    try {
      const plan = await planUpload(lease.value.ssh.client, params.localPath, params.remotePath, params.signal);
      const conflicts = await findUploadConflicts(lease.value.ssh.client, plan, params.signal);
      const payload = { machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, conflicts, async: true };
      if (conflicts.length && !this.consume(params.authorization, "upload", payload)) {
        const allowPermanent = conflicts.length <= MAX_PERMANENT_SCOPE && !scope.path?.subtree;
        return this.requestAuthorization(
          "upload", payload, "Async upload would overwrite existing remote files.",
          { type: "upload-conflicts", total: conflicts.length, truncated: conflicts.length > 10, sample: conflicts.slice(0, 10) },
          scope,
          allowPermanent,
        );
      }
      handedOff = true;
      return { kind: "success", ...startUploadAsync({ client: lease.value.ssh.client, machine: params.machine, localPath: params.localPath, remotePath: params.remotePath, plan, release: lease.release }) };
    } finally { if (!handedOff) lease.release(); }
  }

  async downloadAsync(params: { machine: string; remotePath: string; localPath: string; projectId?: string; signal?: AbortSignal; authorization?: Authorization }) {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = { operation: "download-async", identity, path: { value: params.remotePath, subtree: false } };
    const pre = this.decide(params.projectId, fileRequest({ operation: "download-async", identity, remotePath: params.remotePath }));
    if (pre.decision === "deny") return this.denyResult(pre);

    const authPayload = { machine: params.machine, remotePath: params.remotePath, localPath: params.localPath, async: true };
    if (pre.decision === "ask" && !this.consume(params.authorization, "download", authPayload)) {
      return this.requestAuthorization(
        "download", authPayload, "This async download needs confirmation (project rule).",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        scope,
      );
    }

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

  async readFile(params: {
    machine: string;
    path: string;
    offset?: number;
    limit?: number;
    projectId?: string;
    signal?: AbortSignal;
    authorization?: Authorization;
  }): Promise<ReadRemoteFileResult | BlockedResult | NeedsConfirmation> {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const pre = this.decide(params.projectId, fileRequest({ operation: "read", identity, remotePath: params.path }));
    if (pre.decision === "deny") return this.denyResult(pre);

    // 契约要求：命中项目 ask 时即使本来不需确认也要问一次。读虽无副作用，
    // 但规则写了 ask 就是用户的明确意图（例如只允许人工查看敏感文件）。
    const askPayload = { machine: params.machine, path: params.path, reason: "project-ask" };
    if (pre.decision === "ask" && !this.consume(params.authorization, "read", askPayload)) {
      return this.requestAuthorization(
        "read", askPayload, "Reading this file needs confirmation (project rule).",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        { operation: "read", identity, path: { value: params.path, subtree: false } },
      );
    }

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      return await withSftp(lease.value.ssh.client, (sftp) =>
        readRemoteFile({
          fileOps: {
            lstat: (p) => lstatVia(sftp, p),
            readFile: (p) => readAllVia(sftp, p),
          },
          statProbe: (p) => this.probeStat(lease.value.ssh.client, params.machine, p, params.signal),
          path: params.path,
          offset: params.offset,
          limit: params.limit,
        }),
      );
    } finally {
      lease.release();
    }
  }

  async editFile(params: {
    machine: string;
    path: string;
    expectedVersion: string;
    oldText: string;
    newText: string;
    dryRun?: boolean;
    projectId?: string;
    signal?: AbortSignal;
    authorization?: Authorization;
  }): Promise<ApplyEditResult | NeedsConfirmation | BlockedResult> {
    this.ensureActive();
    const identity = resolveIdentity(params.machine);
    const scope: OperationScope = { operation: "edit", identity, path: { value: params.path, subtree: false } };
    const request = fileRequest({ operation: "edit", identity, remotePath: params.path });

    // deny 在建连之前：被禁止的编辑不该先握手。
    const pre = this.decide(params.projectId, request);
    if (pre.decision === "deny") return this.denyResult(pre);

    const payload = { machine: params.machine, path: params.path, dryRun: !!params.dryRun };
    if (pre.decision === "ask" && !this.consume(params.authorization, "edit", payload)) {
      return this.requestAuthorization(
        "edit",
        payload,
        "This edit needs confirmation.",
        this.askPreview(pre.rule ? `Matched project rule ${pre.rule.id} (ask).` : "No project rule matched."),
        scope,
        // 精确文件 + 单次编辑：范围完整可见，可以永久授权。
        true,
      );
    }

    const lease = await this.pool.get(params.machine, params.signal);
    try {
      return await withSftp(lease.value.ssh.client, (sftp) => {
        const fileOps = createSftpFileOps({
          sftp,
          readStat: (p) => this.probeStat(lease.value.ssh.client, params.machine, p, params.signal),
          read: (p) => readAllVia(sftp, p),
        });
        return applyEdit({
          fileOps,
          path: params.path,
          expectedVersion: params.expectedVersion,
          oldText: params.oldText,
          newText: params.newText,
          dryRun: params.dryRun,
        });
      });
    } finally {
      lease.release();
    }
  }

  /**
   * stat 模板探测：每台机器只探一次，结果缓存在 `statTemplates` 里。
   * 两套模板都不可用时返回 null（调用方据此产出弱 token / 拒绝 edit）。
   */
  private async probeStat(
    client: Client,
    machine: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ inode: string; nlink: string } | null> {
    const cached = this.statTemplates.get(machine);
    if (cached !== undefined) {
      if (cached === null) return null;
      return this.runStat(client, cached, path, signal);
    }

    const tried: StatTemplate[] = [];
    for (;;) {
      const candidate = nextTemplateToTry(tried);
      if (!candidate) {
        this.statTemplates.set(machine, null);
        return null;
      }
      tried.push(candidate);
      const result = await this.runStatParse(client, candidate, path, signal);
      if (result === "template_not_applicable") continue;
      if (result === null) {
        // 命令本身跑不通（不是模板问题）：不缓存，下次再试。
        return null;
      }
      this.statTemplates.set(machine, candidate);
      return result;
    }
  }

  private async runStat(
    client: Client,
    template: StatTemplate,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ inode: string; nlink: string } | null> {
    const parsed = await this.runStatParse(client, template, path, signal);
    return parsed === "template_not_applicable" || parsed === null ? null : parsed;
  }

  private async runStatParse(
    client: Client,
    template: StatTemplate,
    path: string,
    signal?: AbortSignal,
  ): Promise<{ inode: string; nlink: string } | "template_not_applicable" | null> {
    const res = await runCommand(client, buildStatCommand(template, path), {
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
      signal,
    });
    if (res.exitCode !== 0) {
      const parsedFailure = parseStatOutput(template, res.stderr || res.stdout);
      return parsedFailure.ok ? null : parsedFailure.reason === "template_not_applicable" ? "template_not_applicable" : null;
    }
    const parsed = parseStatOutput(template, res.stdout);
    if (parsed.ok) return { inode: parsed.inode, nlink: parsed.nlink };
    return parsed.reason === "template_not_applicable" ? "template_not_applicable" : null;
  }

  async getSession(sessionId: string, lines?: number, projectId?: string) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec) return { kind: "error", error: "session not found" };
    const denied = this.sessionDenied(projectId, "session-get", rec.machine);
    if (denied) return denied;
    if (isTransferSession(rec)) return { ...rec, resultKind: "success", tails: lines && rec.localLogPath ? { log: tailLocalFile(rec.localLogPath, Math.min(2000, Math.max(1, lines))) } : null };
    if (isLocalSession(rec)) return { kind: "error", error: "legacy local sessions are not supported" };
    const lease = await this.pool.get(rec.machine);
    try {
      const meta = await runCommand(lease.value.ssh.client, wrapSh(`test -f "${toHomeAbs(rec.metaPath)}" && cat "${toHomeAbs(rec.metaPath)}" || true`), { maxStdoutBytes: 16 * 1024, maxStderrBytes: 4096 });
      let remoteMeta: any = null; try { remoteMeta = meta.stdout.trim() ? JSON.parse(meta.stdout) : null; } catch { /* ignore */ }
      let status = rec.status; let exitCode = rec.exitCode ?? null;
      if (remoteMeta?.status === "running") status = "running";
      if (remoteMeta?.status === "running") status = "running";
      // 本地已判 cancelled、远端 meta 显示被信号杀掉（128+SIG，如 TERM=143）：
      // 真实终态就是「被我们取消」，不能降级成 failed。
      if (remoteMeta?.status === "done") {
        if (rec.status === "cancelled" && typeof remoteMeta.exitCode === "number" && remoteMeta.exitCode >= 128) {
          status = "cancelled";
        } else {
          status = remoteMeta.exitCode === 0 ? "done" : "failed";
        }
        exitCode = typeof remoteMeta.exitCode === "number" ? remoteMeta.exitCode : exitCode;
      }
      if (status !== rec.status || exitCode !== (rec.exitCode ?? null)) saveSession({ ...rec, status, exitCode: exitCode ?? undefined, updatedAt: isoNow() }, getOctsshDir());
      let tails: any = null;
      if (lines) {
        const n = Math.min(2000, Math.max(1, Math.floor(lines)));
        const out = await runCommand(lease.value.ssh.client, wrapSh(`tail -n ${n} "${toHomeAbs(rec.stdoutPath)}" 2>/dev/null || true`));
        const err = await runCommand(lease.value.ssh.client, wrapSh(`tail -n ${n} "${toHomeAbs(rec.stderrPath)}" 2>/dev/null || true`));
        tails = { stdout: out.stdout, stderr: err.stdout };
      }
      const backend = rec.backend ?? "screen";
      return { kind: "success", session_id: sessionId, machine: rec.machine, status, exitCode, backend, screenName: backend === "screen" ? rec.screenName ?? null : null, cmdPid: rec.cmdPid ?? null, tails };
    } finally { lease.release(); }
  }

  async grepSession(sessionId: string, pattern: string, options: { maxMatches?: number; contextLines?: number } = {}, projectId?: string) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec || isTransferSession(rec) || isLocalSession(rec)) return { kind: "error", error: "remote session not found" };
    const denied = this.sessionDenied(projectId, "session-grep", rec.machine);
    if (denied) return denied;
    const lease = await this.pool.get(rec.machine);
    try {
      const m = Math.min(500, Math.max(1, options.maxMatches ?? 50)); const c = Math.min(50, Math.max(0, options.contextLines ?? 2));
      const grep = (file: string) => wrapSh(`command -v grep >/dev/null 2>&1 && grep -n -E -m ${m} -C ${c} -e ${quoteForSh(pattern)} "${toHomeAbs(file)}" 2>/dev/null || true`);
      const stdout = await runCommand(lease.value.ssh.client, grep(rec.stdoutPath));
      const stderr = await runCommand(lease.value.ssh.client, grep(rec.stderrPath));
      return { kind: "success", session_id: sessionId, pattern, matches: { stdout: stdout.stdout, stderr: stderr.stdout } };
    } finally { lease.release(); }
  }

  async writeStdin(sessionId: string, data: string, options: { appendNewline?: boolean } = {}, projectId?: string, authorization?: Authorization) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec || isTransferSession(rec) || isLocalSession(rec) || !rec.stdinPath || !rec.stdinLogPath) return { kind: "error", error: "stdin is not available for this session" };
    const denied = this.sessionDenied(projectId, "session-write-stdin", rec.machine);
    if (denied) return denied;
    // 写入 stdin 等于向远端进程注入输入：同样有副作用。
    const confirmation = await this.sessionConfirmation(
      projectId,
      "session-write-stdin",
      rec.machine,
      { sessionId, dataLength: data.length },
      "Writing to a task's stdin needs confirmation (project rule).",
      authorization,
    );
    if (confirmation) return confirmation;
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

  async cancelSession(sessionId: string, signal?: string, projectId?: string, authorization?: Authorization) {
    this.ensureActive();
    const rec = loadSession(sessionId, getOctsshDir());
    if (!rec) return { kind: "error", error: "session not found" };
    const denied = this.sessionDenied(projectId, "session-cancel", rec.machine);
    if (denied) return denied;
    // 取消有副作用（会杀掉远端进程）：ask 必须真的确认一次。
    const confirmation = await this.sessionConfirmation(
      projectId,
      "session-cancel",
      rec.machine,
      { sessionId, signal: signal ?? "TERM" },
      "Cancelling this task needs confirmation (project rule).",
      authorization,
    );
    if (confirmation) return confirmation;
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
      // screen 后端才退出 screen 会话；nohup 后端 kill cmdPid 后 wrapper 会自然写 done meta。
      if ((rec.backend ?? "screen") === "screen" && rec.screenName) parts.push(`screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true`);
      await runCommand(lease.value.ssh.client, wrapSh(parts.join("; ")));
      saveSession({ ...rec, status: "cancelled", updatedAt: isoNow() }, getOctsshDir());
      return { kind: "success", session_id: sessionId, status: "cancelled", signal: sig };
    } finally { lease.release(); }
  }

  private requestAuthorization(
    operation: string,
    payload: unknown,
    message: string,
    preview: ConfirmationPreview,
    scope?: OperationScope,
    allowPermanent = true,
  ): NeedsConfirmation {
    const id = crypto.randomUUID(); const expiresAt = Date.now() + 60_000;
    this.authRequests.set(id, { digest: digest(operation, payload), expiresAt, consumed: false });
    return {
      kind: "needs_confirmation",
      authorizationRequest: { id, operation, message, preview, expiresAt, scope, allowPermanent },
    };
  }

  /**
   * 项目规则裁决。projectId 由宿主从 ctx.cwd 算得后作为独立参数传入，
   * 模型无法提供；不传则视为「无项目规则」，沿用现有确认流程。
   */
  private decide(projectId: string | undefined, request: OperationRequest): EvaluationResult {
    if (!projectId) return { decision: "ask", reason: "no_project" };
    return evaluateForProject(projectId, request);
  }

  /** 命中项目 deny 时的统一阻塞返回；不建立连接。 */
  private denyResult(result: EvaluationResult): BlockedResult {
    return {
      kind: "blocked",
      reason: "project_deny",
      message: result.rule
        ? `Blocked by project rule ${result.rule.id} (deny, ${result.rule.operation}).`
        : "Blocked by project rules.",
    };
  }

  /** 扩展层注入通知通道与投递目标。 */
  setNotifyHooks(hooks: {
    channel: (event: { projectId: string }) => "ready" | "busy" | "no_session";
    sink: (payload: NotificationPayload) => void;
  }): void {
    this.notifyChannel = hooks.channel;
    this.notifySink = hooks.sink;
  }

  /**
   * 把 session 目录与任务索引对齐。
   *
   * 任务索引承载投递去重，session 目录是任务事实来源：新 session 首次出现时
   * 补一条记录，之后由扫描更新。已有记录不覆盖（否则会把终态重置成 running）。
   */
  private syncTaskRecords(projectId?: string): void {
    const known = new Set(this.taskStore.loadTasks().map((record) => record.taskId));
    for (const sessionId of listSessionIds(getOctsshDir())) {
      if (known.has(sessionId)) continue;
      const rec = loadSession(sessionId, getOctsshDir());
      if (!rec || isLocalSession(rec)) continue;
      const transfer = isTransferSession(rec);
      this.taskStore.upsertTask({
        taskId: rec.session_id,
        kind: transfer ? "transfer" : "screen",
        // 旧 session 没有项目归属：不猜，留空让 recovery 标 notAwakened。
        ...(projectId ? { projectId } : {}),
        machine: rec.machine,
        state: mapSessionStatus(rec.status),
        ...(transfer ? { inProcess: true } : {}),
        ...(typeof (rec as unknown as { exitCode?: unknown }).exitCode === "number"
          ? { exitCode: (rec as unknown as { exitCode: number }).exitCode }
          : {}),
        startedAt: rec.createdAt,
      });
    }
  }

  /** 观测单个任务。任何失败都归为 unknown——观测不到不等于任务失败。 */
  private async observeTask(record: TaskRecord): Promise<TaskObservation> {
    try {
      const rec = loadSession(record.taskId, getOctsshDir());
      if (!rec) {
        // 记录还在但 session 文件已按保留期清理：running 一定不再跑了。
        return { observation: "reachable", state: record.state === "running" ? "interrupted" : record.state };
      }
      if (isTransferSession(rec)) {
        // 进程内异步传输在 Pi 重启后没有进程继续它，交给 transition 判 interrupted。
        return {
          observation: "reachable",
          state: mapSessionStatus(rec.status),
          ...(typeof (rec as unknown as { exitCode?: unknown }).exitCode === "number"
            ? { exitCode: (rec as unknown as { exitCode: number }).exitCode }
            : {}),
        };
      }
      const info = (await this.getSession(record.taskId)) as Record<string, unknown>;
      if (info && info.kind === "error") {
        return { observation: "unknown", reason: String(info.error ?? "session unreadable") };
      }
      const status = String(info?.status ?? rec.status);
      return {
        observation: "reachable",
        state: mapSessionStatus(status),
        ...(typeof (rec as unknown as { exitCode?: unknown }).exitCode === "number"
          ? { exitCode: (rec as unknown as { exitCode: number }).exitCode }
          : {}),
      };
    } catch (error) {
      return { observation: "unknown", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  /** 跑一轮扫描。 */
  async sweepTasks(params: { projectId?: string; hasSessionForProject?: (projectId: string) => boolean } = {}): Promise<SweepSummary & { storeCorruptReported: boolean; deliveredPruned: number }> {
    this.ensureActive();
    this.syncTaskRecords(params.projectId);
    const summary = await runTaskSweep({
      store: this.taskStore,
      delivery: this.taskDelivery,
      observe: (record) => this.observeTask(record),
      hasSessionForProject: params.hasSessionForProject,
    });
    const firstReport = summary.storeCorrupt && !this.taskStoreCorruptReported;
    if (summary.storeCorrupt) this.taskStoreCorruptReported = true;

    // 每轮扫描顺带裁剪已投递记录：配置里的保留参数必须真的生效，
    // 否则 delivered.json 只会无界增长。
    const pruning = this.pruneTaskDelivered();
    return { ...summary, storeCorruptReported: firstReport, deliveredPruned: pruning.removed };
  }

  /** 把排队的事件补发出去。 */
  async flushTaskNotifications(): Promise<{ delivered: number; remaining: number }> {
    this.ensureActive();
    const result = await this.taskDelivery.flush();
    return { delivered: result.delivered.length, remaining: result.remaining.length };
  }

  /** 面板用：任务列表（含未投递原因）。 */
  listTasks(params: { projectId?: string; includeAllProjects?: boolean } = {}): {
    tasks: TaskRecord[];
    notAwakened: { taskId: string; reason: string }[];
  } {
    const records = this.taskStore.loadTasks();
    const scoped = params.includeAllProjects || !params.projectId
      ? records
      : records.filter((record) => record.projectId === params.projectId);
    const notAwakened = scoped
      .filter((record) => record.state !== "running" && record.state !== "cancelling" && !record.emittedEventId)
      .map((record) => ({
        taskId: record.taskId,
        reason: record.projectId
          ? "completion not delivered yet (waiting for a session in this project)"
          : "missing project id; not awakened",
      }));
    return { tasks: scoped, notAwakened };
  }

  /**
   * 裁剪已投递记录。默认参数来自配置（`taskNotify.deliveredRetention*`），
   * 面板/测试可显式覆盖。裁剪失败不影响扫描主流程。
   */
  pruneTaskDelivered(options?: { maxAgeMs?: number; maxEntries?: number }): { removed: number; kept: number } {
    const { deliveredRetentionDays, deliveredMaxEntries } = this.cfg.taskNotify;
    try {
      const result = this.taskStore.pruneDelivered({
        maxAgeMs: options?.maxAgeMs ?? deliveredRetentionDays * 24 * 60 * 60 * 1000,
        maxEntries: options?.maxEntries ?? deliveredMaxEntries,
      });
      return { removed: result.removed.length, kept: result.kept.length };
    } catch {
      // 裁剪只是清理：读不到/写不进就跳过本轮，下一轮再试。
      return { removed: 0, kept: 0 };
    }
  }

  /** 面板用：任务存储状态。 */
  taskStoreStatus(): { storeCorrupt: boolean; corruptFiles: { file: string; renamedTo: string; error: string }[] } {
    return this.taskStore.status();
  }

  poolStats(): { connections: number; maxConnections: number } {
    return { connections: this.pool.size(), maxConnections: this.cfg.maxConnections };
  }

  activeTransfers() {
    return listActiveTransfers(getOctsshDir());
  }

  async dropConnections(): Promise<number> {
    return this.pool.dropAll();
  }

  /**
   * session 类操作的规则判定。命令与路径都不适用，只按主机身份 + 操作裁决，
   * 因此 deny 会挡掉整台机器上的这类操作。
   */
  private sessionDenied(projectId: string | undefined, operation: ManagedOperation, machine: string): BlockedResult | undefined {
    const result = this.sessionDecision(projectId, operation, machine);
    return result.decision === "deny" ? this.denyResult(result) : undefined;
  }

  /** 供 session 类入口复用：deny 直接阻塞，ask 交由调用方决定要不要弹确认。 */
  private sessionDecision(projectId: string | undefined, operation: ManagedOperation, machine: string): EvaluationResult {
    if (!projectId) return { decision: "ask", reason: "no_project" };
    return this.decide(projectId, { operation, identity: resolveIdentity(machine) });
  }

  /**
   * 有副作用的 session 操作（取消、写 stdin）命中 ask 时必须真的问一次。
   *
   * 纯读取类（session-get/session-grep）不插确认：读不改变任何远端状态，
   * 强行加一步确认只会训练用户盲点「是」。这类入口的 ask 在 README 里说明。
   */
  private async sessionConfirmation(
    projectId: string | undefined,
    operation: ManagedOperation,
    machine: string,
    payload: unknown,
    message: string,
    authorization: Authorization | undefined,
    signal?: AbortSignal,
  ): Promise<NeedsConfirmation | BlockedResult | undefined> {
    const result = this.sessionDecision(projectId, operation, machine);
    if (result.decision !== "ask") return undefined;
    if (this.consume(authorization, operation, payload)) return undefined;
    return this.requestAuthorization(
      operation,
      payload,
      message,
      this.askPreview(result.rule ? `Matched project rule ${result.rule.id} (ask).` : "No project rule matched."),
      { operation, identity: resolveIdentity(machine) },
    );
  }

  private askPreview(message: string): ConfirmationPreview {
    return { type: "policy-ask", total: 1, truncated: false, sample: [message] };
  }
  private consume(auth: Authorization | undefined, operation: string, payload: unknown) {
    if (!auth) return false;
    const rec = this.grants.get(auth.token); this.grants.delete(auth.token);
    if (!rec || rec.consumed || rec.expiresAt < Date.now() || rec.digest !== digest(operation, payload)) return false;
    rec.consumed = true; return true;
  }
  /**
   * 凭据请求接上 credentials 模块：缓存键用 identityKey，私钥口令额外用
   * 私钥材料哈希，换文件即失效。没有可用的遮罩输入时不注入，连接层会
   * 报 AUTH_REQUIRES_UI 而不是静默失败。
   */
  private buildAuthOptions(identity: SshIdentity, privateKey: string | undefined): SshAuthOptions | undefined {
    const prompt = this.credentialPromptProvider?.();
    if (!prompt) return undefined;
    const idKey = identityKey(identity);
    const keyHash = privateKey
      ? crypto.createHash("sha256").update(privateKey, "utf8").digest("hex")
      : undefined;
    return {
      label: displayIdentity(identity),
      keyHash,
      requestPassword: async (label) => (await requestCredential("password", idKey, label, prompt))?.value,
      requestPassphrase: async (label, hash) =>
        (await requestCredential("key-passphrase", hash ?? idKey, label, prompt))?.value,
      onAuthFailure: (kind) => invalidateCredential(kind, kind === "password" ? idKey : (keyHash ?? idKey)),
    };
  }

  /** 连接期取一次：确认 UI 只在 TUI 且 hasUI 时由扩展层提供。 */
  private getHostKeyConfirm(): HostKeyConfirm | undefined {
    return this.hostKeyConfirmProvider?.();
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
        try {
          if (lease.value.platform !== "windows") {
            const quit = (rec.backend ?? "screen") === "screen" && rec.screenName ? `; screen -S ${quoteForSh(rec.screenName)} -X quit 2>/dev/null || true` : "";
            await runCommand(lease.value.ssh.client, wrapSh(`rm -rf "$HOME/${rec.remoteDir}" 2>/dev/null || true${quit}`));
          }
        } finally { lease.release(); }
      } catch { /* best effort */ }
      if (this.isCurrent(generation)) deleteSessionFile(rec.session_id, getOctsshDir());
    }
  }
}

export function createOctsshRuntime(
  options?: { hostKeyConfirm?: () => HostKeyConfirm | undefined; credentialPrompt?: () => CredentialPrompt | undefined },
): OctsshRuntime { return new Runtime(options); }
