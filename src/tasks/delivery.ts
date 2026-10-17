import os from "node:os";
import type { TaskCompletionEvent } from "./recovery.ts";

/**
 * 完成事件的投递记录与去重。
 *
 * 四条不变量（都对应契约要求）：
 * 1. 同一 `eventId` 正常路径只投递一次；崩溃窗口内的重复项仍带同一 id，
 *    因此可以识别并丢弃，绝不生成新 id。
 * 2. 同一任务同时只有一个观察者持有投递资格（单观察者租约）。
 *    租约过期或持有者确实已不在时才可接管——不因「超过 X 秒」就抢。
 * 3. 忙碌时排队不丢弃：返回 queued，之后 flush 取出。
 * 4. 没有同项目会话时不投递、也不标记已投递。
 */

/** 默认租约时长：只作为「持有者已失效」的兜底判断依据之一，不单独构成接管理由。 */
export const DEFAULT_LEASE_MS = 30_000;

/**
 * 可注入的持久化接口。本轮只提供内存实现；P4b 接上真实落盘。
 * 语义要求：`tryAcquireLease` 必须是原子的（真实实现用 lockfile.ts 的 wx 创建）。
 */
export type DeliveryStore = {
  /** 已投递过的 eventId。 */
  isDelivered(eventId: string): Promise<boolean>;
  markDelivered(eventId: string): Promise<void>;
  /** 待投递队列（按入队顺序）。 */
  loadQueue(): Promise<TaskCompletionEvent[]>;
  saveQueue(queue: readonly TaskCompletionEvent[]): Promise<void>;
  /** 原子地尝试获取某任务的观察者租约；失败返回当前持有者。 */
  tryAcquireLease(taskId: string, holder: ObserverLease): Promise<{ acquired: true } | { acquired: false; holder: ObserverLease | null }>;
  /**
   * 接管已被判定为死亡的持有者的租约。
   *
   * 与 `tryAcquireLease` 分开是刻意的：接管必须由「已确认持有者不在」驱动，
   * 而不是靠超时。真实实现里这里对应「确认 pid 不存在后 unlink 再重建」。
   * 只有 `expectedHolder` 仍是当前持有者时才允许接管（避免误抢刚被换上的新持有者）。
   */
  stealLease(taskId: string, expectedHolder: ObserverLease, holder: ObserverLease): Promise<{ acquired: true } | { acquired: false; holder: ObserverLease | null }>;
  releaseLease(taskId: string, holder: ObserverLease): Promise<void>;
};

export type ObserverLease = {
  /** 持有者标识（进程内唯一）。 */
  holderId: string;
  /** 持有者所在主机；与当前主机不同则**永不**判活。 */
  hostname: string;
  /** 持有者进程 pid，用于同机判活。 */
  pid: number;
  acquiredAt: number;
};

export type DeliveryOutcome =
  | { kind: "delivered"; eventId: string }
  | { kind: "queued"; eventId: string; reason: "busy" | "no_session" }
  | { kind: "duplicate"; eventId: string }
  | { kind: "lease_held"; taskId: string; holder: ObserverLease | null };

/** 投递内容：默认只带状态元数据，不含 stdout/stderr 或完整命令。 */
export type NotificationPayload = {
  taskId: string;
  machine: string;
  state: string;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
};

export function buildPayload(event: TaskCompletionEvent): NotificationPayload {
  const durationMs =
    event.startedAt && event.endedAt
      ? Math.max(0, new Date(event.endedAt).getTime() - new Date(event.startedAt).getTime())
      : undefined;
  return {
    taskId: event.taskId,
    machine: event.machine,
    state: event.state,
    ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
    ...(event.startedAt ? { startedAt: event.startedAt } : {}),
    ...(event.endedAt ? { endedAt: event.endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

export type DeliveryDeps = {
  store: DeliveryStore;
  /** 当前进程的持有者身份。 */
  self: ObserverLease;
  /**
   * 投递通道状态：
   * - ready     ：可以投递
   * - busy      ：当前会话正忙（模型在跑），排队等 flush
   * - no_session：没有同项目会话，排队等待该项目的会话出现
   * 后两种都必须排队而不是丢弃，也绝不能标成已投递。
   */
  channelState?: (event: TaskCompletionEvent) => "ready" | "busy" | "no_session";
  /** 真正把通知送出去的函数（注入，便于离线验证）。 */
  send?: (payload: NotificationPayload) => void;
  /**
   * **仅**回答「同机 pid 是否存活」。
   *
   * 调用方注入的实现**必须**对异机持有者返回 `true`。不过「异机永不接管」
   * 这条规则已上移到 `leaseIsTakeable`（库内）先行判断，注入点无法再绕过它——
   * 即使实现错误地对异机返回 false，也不会抢到异机租约。
   */
  isHolderAlive?: (holder: ObserverLease) => boolean;
};

/** 同机 + pid 不存在才算死；异机一律视为活（参照 lockfile.ts 的保守策略）。 */
function defaultIsHolderAlive(holder: ObserverLease): boolean {
  if (holder.hostname !== hostnameOf()) return true;
  if (!Number.isInteger(holder.pid) || holder.pid <= 0) return true;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    // ESRCH 才是「不存在」；EPERM 说明进程在但无权发信号。
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function hostnameOf(): string {
  return os.hostname();
}

export function createDelivery(deps: DeliveryDeps) {
  const isAlive = deps.isHolderAlive ?? defaultIsHolderAlive;

  async function leaseIsTakeable(holder: ObserverLease | null): Promise<boolean> {
    if (!holder) return true;
    // 持有者自己：允许重入（同一观察者连续处理）。
    if (holder.holderId === deps.self.holderId) return true;

    // 异机持有者**永不可抢**。这条判断必须在库内做，不能委托给注入点：
    // 调用方注入的判活实现可能对异机返回 false（那样就会误抢别人的租约）。
    if (holder.hostname !== os.hostname()) return false;

    // 同机：只有确认进程确实不存在才能接管；「超过 X 秒」不构成接管理由。
    return !isAlive(holder);
  }

  async function deliver(event: TaskCompletionEvent): Promise<DeliveryOutcome> {
    if (await deps.store.isDelivered(event.eventId)) {
      return { kind: "duplicate", eventId: event.eventId };
    }

    const acquisition = await deps.store.tryAcquireLease(event.taskId, deps.self);
    if (!acquisition.acquired) {
      if (!(await leaseIsTakeable(acquisition.holder))) {
        return { kind: "lease_held", taskId: event.taskId, holder: acquisition.holder };
      }
      // 持有者已确认不在：走显式接管，而不是重试普通获取（那样永远拿不到）。
      const stolen = await deps.store.stealLease(event.taskId, acquisition.holder as ObserverLease, deps.self);
      if (!stolen.acquired) return { kind: "lease_held", taskId: event.taskId, holder: stolen.holder };
    }

    try {
      const channel = deps.channelState?.(event) ?? "ready";
      if (channel !== "ready") {
        // 忙碌 / 无同项目会话：排队，**不**标记已投递。
        await enqueue(event);
        return { kind: "queued", eventId: event.eventId, reason: channel === "busy" ? "busy" : "no_session" };
      }

      deps.send?.(buildPayload(event));
      await deps.store.markDelivered(event.eventId);
      return { kind: "delivered", eventId: event.eventId };
    } finally {
      await deps.store.releaseLease(event.taskId, deps.self);
    }
  }

  async function enqueue(event: TaskCompletionEvent): Promise<void> {
    const queue = await deps.store.loadQueue();
    // 同一 eventId 在队列里只保留一份。
    if (queue.some((item) => item.eventId === event.eventId)) return;
    await deps.store.saveQueue([...queue, event]);
  }

  /** 取出待投递项（不投递、不标记）。调用方决定怎么送。 */
  async function drainQueue(): Promise<TaskCompletionEvent[]> {
    const queue = await deps.store.loadQueue();
    await deps.store.saveQueue([]);
    return queue;
  }

  /** flush：把队列里现在能投的都投出去，返回仍然留下的。 */
  async function flush(): Promise<{ delivered: TaskCompletionEvent[]; remaining: TaskCompletionEvent[] }> {
    const queue = await drainQueue();
    const delivered: TaskCompletionEvent[] = [];
    const remaining: TaskCompletionEvent[] = [];

    for (const event of queue) {
      const outcome = await deliver(event);
      if (outcome.kind === "delivered") delivered.push(event);
      else if (outcome.kind === "duplicate") delivered.push(event);
      else remaining.push(event);
    }

    if (remaining.length > 0) await deps.store.saveQueue(remaining);
    return { delivered, remaining };
  }

  return { deliver, drainQueue, flush };
}

/** 内存实现：本轮用；P4b 换成真实落盘实现时保持接口不变。 */
export function createMemoryDeliveryStore(): DeliveryStore & { snapshot(): { delivered: string[]; queue: TaskCompletionEvent[]; leases: Record<string, ObserverLease> } } {
  const delivered = new Set<string>();
  let queue: TaskCompletionEvent[] = [];
  const leases = new Map<string, ObserverLease>();

  return {
    async isDelivered(eventId) {
      return delivered.has(eventId);
    },
    async markDelivered(eventId) {
      delivered.add(eventId);
    },
    async loadQueue() {
      return [...queue];
    },
    async saveQueue(next) {
      queue = [...next];
    },
    async tryAcquireLease(taskId, holder) {
      const current = leases.get(taskId);
      if (current && current.holderId !== holder.holderId) {
        return { acquired: false, holder: current };
      }
      leases.set(taskId, holder);
      return { acquired: true };
    },
    async stealLease(taskId, expectedHolder, holder) {
      const current = leases.get(taskId);
      if (current && current.holderId !== expectedHolder.holderId) {
        return { acquired: false, holder: current };
      }
      leases.set(taskId, holder);
      return { acquired: true };
    },
    async releaseLease(taskId, holder) {
      const current = leases.get(taskId);
      if (current && current.holderId === holder.holderId) leases.delete(taskId);
    },
    snapshot() {
      return { delivered: [...delivered], queue: [...queue], leases: Object.fromEntries(leases) };
    },
  };
}
