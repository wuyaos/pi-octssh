import fs from "node:fs";
import path from "node:path";
import { atomicWriteFileSync, ensureDirSync, readJsonIfExistsSync } from "../state/fs.ts";
import { getOctsshDir } from "../state/paths.ts";
import { withLock } from "../util/lockfile.ts";
import type { TaskRecord } from "./state.ts";
import type { DeliveryStore, ObserverLease } from "./delivery.ts";
import type { TaskCompletionEvent } from "./recovery.ts";

/**
 * 任务与投递记录的落盘实现。
 *
 * 与 `sessions.ts` 刻意分开（那个 schema 是 `.strict()` 且有手写测试）：
 * 任务索引单独一个文件，避免为加字段去动它。
 *
 * 三条硬性要求：
 * 1. 崩溃恢复：重启后必须能读到已投递 id（绝不重复唤醒）与待投递队列。
 * 2. 损坏**不得静默当空**：那会重复唤醒或丢通知。一律改名保留 + 标记。
 * 3. 写盘用 `withLock` + 原子写：锁不可仅因超时被抢（沿用 lockfile 的策略）。
 */

export const TASKS_DIR_NAME = "tasks";
/** 索引文件版本。旧文件没有 version 视为 v0。 */
export const TASK_INDEX_VERSION = 1;

/** 已投递记录版本：v1 只有 `ids`，v2 起每条带投递时间。 */
export const DELIVERED_VERSION = 2;

/**
 * 保留策略：两者任一超出即裁剪。
 *
 * 默认 30 天 / 5000 条：足以覆盖正常重启窗口，又不会让文件无界增长。
 */
export const DELIVERED_RETENTION = { maxAgeMs: 30 * 24 * 60 * 60 * 1000, maxEntries: 5000 };

export type CorruptFile = { file: string; renamedTo: string; error: string };

export type StoreStatus = {
  /** 本次实例的生命周期内是否发现过损坏文件。调用方应提示用户一次。 */
  storeCorrupt: boolean;
  corruptFiles: CorruptFile[];
};

export type TaskStoreOptions = {
  baseDir?: string;
};

function tasksDir(baseDir?: string): string {
  return path.join(baseDir ?? getOctsshDir(), TASKS_DIR_NAME);
}

function deliveredPath(baseDir?: string) {
  return path.join(tasksDir(baseDir), "delivered.json");
}

function queuePath(baseDir?: string) {
  return path.join(tasksDir(baseDir), "queue.json");
}

function leasesPath(baseDir?: string) {
  return path.join(tasksDir(baseDir), "leases.json");
}

function indexPath(baseDir?: string) {
  return path.join(tasksDir(baseDir), "index.json");
}

/**
 * 把损坏文件改名保留，返回新路径。
 *
 * 绝不用 `.bak` 之类固定名：第二次损坏会覆盖掉第一次的证据。
 */
function quarantine(filePath: string, error: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${filePath}.corrupt-${stamp}`;
  try {
    fs.renameSync(filePath, target);
    return target;
  } catch {
    // 连改名都失败（权限/占用）：至少不要让调用方以为文件是空的。
    return filePath;
  }
}

type LoadResult<T> = { value: T; corrupt: CorruptFile | null };

/**
 * 读 JSON；不存在返回 fallback；损坏则隔离并返回 fallback + 记录。
 *
 * `parse` 负责结构校验：结构不对也算损坏——「能 parse 但字段形状错了」
 * 与「根本不是 JSON」在语义上同样是不可信输入。
 */
function loadJson<T>(filePath: string, fallback: T, parse: (raw: unknown) => T): LoadResult<T> {
  let raw: unknown;
  try {
    raw = readJsonIfExistsSync<unknown>(filePath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const renamedTo = quarantine(filePath, message);
    return { value: fallback, corrupt: { file: filePath, renamedTo, error: message } };
  }
  if (raw === null) return { value: fallback, corrupt: null };

  try {
    return { value: parse(raw), corrupt: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const renamedTo = quarantine(filePath, message);
    return { value: fallback, corrupt: { file: filePath, renamedTo, error: message } };
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 一条已投递记录。`deliveredAt` 缺失表示来自 v1 旧文件（按最老处理）。 */
export type DeliveredEntry = { id: string; deliveredAt?: number };

function parseDeliveredEntries(raw: unknown): { entries: DeliveredEntry[]; migratedFromV1: boolean } {
  const record = raw as { version?: unknown; ids?: unknown; entries?: unknown };

  if (Array.isArray(record?.ids)) {
    // v1（或更早的无版本文件）：只有 id，没有时间。
    // 绝不能因为「没有时间」就丢掉它们——那会让已经通知过的任务再唤醒一次。
    const ids = [...new Set(record.ids.filter((item): item is string => typeof item === "string"))];
    return { entries: ids.map((id) => ({ id })), migratedFromV1: true };
  }

  if (!Array.isArray(record?.entries)) throw new Error("delivered.json: entries must be an array");
  const seen = new Set<string>();
  const entries: DeliveredEntry[] = [];
  for (const item of record.entries) {
    const entry = item as Partial<DeliveredEntry>;
    if (typeof entry?.id !== "string") throw new Error("delivered.json: entry is missing id");
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push({
      id: entry.id,
      ...(typeof entry.deliveredAt === "number" ? { deliveredAt: entry.deliveredAt } : {}),
    });
  }
  return { entries, migratedFromV1: false };
}

/**
 * 裁剪：按时间与条数上限丢弃最老的记录。
 *
 * 缺 `deliveredAt` 的条目（v1 迁移而来）**永不因时间被删**：没有时间就不能
 * 断言它过期了，删掉等于允许重复唤醒。它们只参与条数压缩，并在排序时算作
 * 最老——这既落实「按最老处理」，又不会因为缺字段就丢掉记录。
 */
export function pruneDeliveredEntries(
  entries: readonly DeliveredEntry[],
  options: { now: number; maxAgeMs?: number; maxEntries?: number } = { now: Date.now() },
): { kept: DeliveredEntry[]; removed: DeliveredEntry[] } {
  const maxAgeMs = options.maxAgeMs ?? DELIVERED_RETENTION.maxAgeMs;
  const maxEntries = options.maxEntries ?? DELIVERED_RETENTION.maxEntries;

  const sorted = [...entries].sort((a, b) => (a.deliveredAt ?? 0) - (b.deliveredAt ?? 0));
  const cutoff = options.now - maxAgeMs;

  const removed: DeliveredEntry[] = [];
  const byAge = sorted.filter((entry) => {
    if (entry.deliveredAt === undefined) return true; // 无时间：不因时间删除。
    if (entry.deliveredAt < cutoff) {
      removed.push(entry);
      return false;
    }
    return true;
  });

  // 仍然超量：继续从最老的丢。
  const overflow = Math.max(0, byAge.length - maxEntries);
  const dropped = byAge.slice(0, overflow);
  removed.push(...dropped);

  return { kept: byAge.slice(overflow), removed };
}

function parseQueue(raw: unknown): TaskCompletionEvent[] {
  const record = raw as { version?: number; events?: unknown };
  if (!record || !Array.isArray(record.events)) throw new Error("queue.json: events must be an array");
  for (const event of record.events) {
    const item = event as Partial<TaskCompletionEvent>;
    if (typeof item?.eventId !== "string" || typeof item?.taskId !== "string") {
      throw new Error("queue.json: event is missing eventId/taskId");
    }
  }
  return record.events as TaskCompletionEvent[];
}

function parseLeases(raw: unknown): Record<string, ObserverLease> {
  const record = raw as { version?: number; leases?: unknown };
  if (!record || typeof record.leases !== "object" || record.leases === null) {
    throw new Error("leases.json: leases must be an object");
  }
  const out: Record<string, ObserverLease> = {};
  for (const [taskId, value] of Object.entries(record.leases as Record<string, unknown>)) {
    const lease = value as Partial<ObserverLease>;
    if (typeof lease?.holderId !== "string" || typeof lease?.hostname !== "string") {
      throw new Error(`leases.json: invalid lease for ${taskId}`);
    }
    out[taskId] = {
      holderId: lease.holderId,
      hostname: lease.hostname,
      pid: typeof lease.pid === "number" ? lease.pid : 0,
      acquiredAt: typeof lease.acquiredAt === "number" ? lease.acquiredAt : 0,
    };
  }
  return out;
}

/**
 * 任务索引的迁移与校验。
 *
 * - 无 `version` → 视为 v0，补齐后回写（v0 的字段与 v1 相同，只是没版本号）。
 * - 更高 version → 抛错（不猜测降级：未知字段可能承载安全语义）。
 */
export function parseTaskIndex(raw: unknown): { version: number; tasks: TaskRecord[]; migrated: boolean } {
  const record = raw as { version?: unknown; tasks?: unknown };
  const hasVersion = record !== null && typeof record === "object" && "version" in record;

  if (hasVersion) {
    const version = record.version;
    if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
      throw new Error("index.json: version must be a non-negative integer");
    }
    if (version > TASK_INDEX_VERSION) {
      throw new Error(
        `index.json: version ${version} is newer than this build supports (${TASK_INDEX_VERSION}); refusing to downgrade`,
      );
    }
  }

  if (!record || !Array.isArray(record.tasks)) throw new Error("index.json: tasks must be an array");
  for (const task of record.tasks) {
    const item = task as Partial<TaskRecord>;
    if (typeof item?.taskId !== "string" || typeof item?.state !== "string" || typeof item?.machine !== "string") {
      throw new Error("index.json: task is missing taskId/state/machine");
    }
  }

  return {
    version: TASK_INDEX_VERSION,
    tasks: record.tasks as TaskRecord[],
    migrated: !hasVersion,
  };
}

export type TaskStore = DeliveryStore & {
  status(): StoreStatus;
  /** 读全部任务记录（触发迁移与回写）。 */
  loadTasks(): TaskRecord[];
  /** 写回全部任务记录。 */
  saveTasks(tasks: readonly TaskRecord[]): void;
  /** 单个任务 upsert（读-改-写整体持锁）。 */
  upsertTask(task: TaskRecord): void;
  /** 租约是否可被当前观察者接管（用于面板/调试）。 */
  readLeases(): Record<string, ObserverLease>;
  /** 裁剪已投递记录；只动 delivered.json，不碰队列。 */
  pruneDelivered(options?: { now?: number; maxAgeMs?: number; maxEntries?: number }): { removed: string[]; kept: string[] };
};

export function createTaskStore(options: TaskStoreOptions = {}): TaskStore {
  const baseDir = options.baseDir;
  ensureDirSync(tasksDir(baseDir));

  const corruptFiles: CorruptFile[] = [];
  const noteCorrupt = <T,>(result: LoadResult<T>): T => {
    if (result.corrupt) {
      // 同一文件在一个实例里只记一次，避免每读一次就追加一条。
      if (!corruptFiles.some((item) => item.file === result.corrupt!.file)) corruptFiles.push(result.corrupt);
    }
    return result.value;
  };

  const writeDelivered = (entries: readonly DeliveredEntry[]) => {
    writeJson(deliveredPath(baseDir), DELIVERED_VERSION, { entries: [...entries] });
  };

  /**
   * 读已投递记录，**不持锁**。所有调用点都已持有 `store.lock`，
   * 或者由下面的 `readDeliveredState` 统一加锁。
   */
  const readDeliveredUnlocked = (): { entries: DeliveredEntry[]; migratedFromV1: boolean } =>
    noteCorrupt(
      loadJson<{ entries: DeliveredEntry[]; migratedFromV1: boolean }>(
        deliveredPath(baseDir),
        { entries: [], migratedFromV1: false },
        parseDeliveredEntries,
      ),
    );

  /**
   * 读已投递记录；v1（只有 ids）读出来即迁移并按 v2 回写一次。
   *
   * 注意锁的边界：`withLock` 不可重入，因此这里自己持锁一次完成「读 + 迁移写」，
   * 绝不在已持锁的临界区里再调用它（否则同一进程会等自己而死锁）。
   */
  const readDeliveredState = (): DeliveredEntry[] => {
    const loaded = readDeliveredUnlocked();
    if (!loaded.migratedFromV1 || loaded.entries.length === 0) return loaded.entries;
    return withStoreLock(() => {
      const again = readDeliveredUnlocked();
      if (again.migratedFromV1 && again.entries.length > 0) writeDelivered(again.entries);
      return again.entries.length > 0 ? again.entries : loaded.entries;
    });
  };
  const readQueue = () => noteCorrupt(loadJson(queuePath(baseDir), [] as TaskCompletionEvent[], parseQueue));
  const readLeases = () => noteCorrupt(loadJson(leasesPath(baseDir), {} as Record<string, ObserverLease>, parseLeases));

  /** 所有写操作都在同一把锁里，避免「读-改-写」互相覆盖。 */
  const withStoreLock = <T,>(fn: () => T): T =>
    withLock(path.join(tasksDir(baseDir), "store.lock"), fn) as T;

  const writeJson = (file: string, version: number, body: Record<string, unknown>) => {
    atomicWriteFileSync(file, JSON.stringify({ version, ...body }, null, 2) + "\n");
  };

  return {
    status() {
      return { storeCorrupt: corruptFiles.length > 0, corruptFiles: [...corruptFiles] };
    },

    async isDelivered(eventId) {
      return readDeliveredState().some((entry) => entry.id === eventId);
    },

    async markDelivered(eventId) {
      withStoreLock(() => {
        // 已持锁：用不带锁的读，写回本身就把 v1 升级成 v2。
        const { entries } = readDeliveredUnlocked();
        if (entries.some((entry) => entry.id === eventId)) return;
        writeDelivered([...entries, { id: eventId, deliveredAt: Date.now() }]);
      });
    },

    pruneDelivered(options) {
      return withStoreLock(() => {
        const { entries } = readDeliveredUnlocked();
        const { kept, removed } = pruneDeliveredEntries(entries, {
          now: options?.now ?? Date.now(),
          maxAgeMs: options?.maxAgeMs,
          maxEntries: options?.maxEntries,
        });
        if (removed.length > 0) writeDelivered(kept);
        return { removed: removed.map((entry) => entry.id), kept: kept.map((entry) => entry.id) };
      });
    },

    async loadQueue() {
      return readQueue();
    },

    async saveQueue(queue) {
      withStoreLock(() => writeJson(queuePath(baseDir), 1, { events: [...queue] }));
    },

    async tryAcquireLease(taskId, holder) {
      return withStoreLock(() => {
        const leases = readLeases();
        const current = leases[taskId];
        if (current && current.holderId !== holder.holderId) return { acquired: false as const, holder: current };
        writeJson(leasesPath(baseDir), 1, { leases: { ...leases, [taskId]: holder } });
        return { acquired: true as const };
      });
    },

    async stealLease(taskId, expectedHolder, holder) {
      return withStoreLock(() => {
        const leases = readLeases();
        const current = leases[taskId];
        if (current && current.holderId !== expectedHolder.holderId) {
          return { acquired: false as const, holder: current };
        }
        writeJson(leasesPath(baseDir), 1, { leases: { ...leases, [taskId]: holder } });
        return { acquired: true as const };
      });
    },

    async releaseLease(taskId, holder) {
      withStoreLock(() => {
        const leases = readLeases();
        const current = leases[taskId];
        if (!current || current.holderId !== holder.holderId) return;
        const next = { ...leases };
        delete next[taskId];
        writeJson(leasesPath(baseDir), 1, { leases: next });
      });
    },

    loadTasks() {
      const loaded = noteCorrupt(loadJson(indexPath(baseDir), { version: TASK_INDEX_VERSION, tasks: [] as TaskRecord[], migrated: false }, (raw) => parseTaskIndex(raw)));
      if (loaded.migrated) {
        // 旧文件（无 version）升级后立刻回写，避免每次启动都重做一次迁移。
        withStoreLock(() => writeJson(indexPath(baseDir), TASK_INDEX_VERSION, { tasks: loaded.tasks }));
      }
      return loaded.tasks;
    },

    saveTasks(tasks) {
      withStoreLock(() => writeJson(indexPath(baseDir), TASK_INDEX_VERSION, { tasks: [...tasks] }));
    },

    upsertTask(task) {
      withStoreLock(() => {
        const loaded = noteCorrupt(
          loadJson(indexPath(baseDir), { version: TASK_INDEX_VERSION, tasks: [] as TaskRecord[], migrated: false }, (raw) =>
            parseTaskIndex(raw),
          ),
        );
        const tasks = [...loaded.tasks.filter((item) => item.taskId !== task.taskId), task];
        writeJson(indexPath(baseDir), TASK_INDEX_VERSION, { tasks });
      });
    },

    readLeases() {
      return readLeases();
    },
  };
}
