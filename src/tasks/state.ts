import crypto from "node:crypto";

/**
 * 任务状态与可达性是**两个独立维度**。
 *
 * 把它们合并成一个枚举是这类系统最常见的错误：网络抖一下就得出「任务失败」，
 * 或者「查不到」被当成「已经结束」。因此这里强制分开：
 *
 *   TaskState        任务本身发生了什么（由任务语义决定）
 *   ObservationState 我们这次能不能看到它（由观测通道决定）
 *
 * 一条铁律：`unknown` 只更新可达性，**永远不产生完成事件**。
 */

export type TaskState = "running" | "cancelling" | "done" | "failed" | "cancelled" | "interrupted";

export type ObservationState = "reachable" | "unknown";

/** 终态：只有这些状态可以产生完成事件。 */
export const TERMINAL_STATES: readonly TaskState[] = ["done", "failed", "cancelled", "interrupted"];

export function isTerminal(state: TaskState): boolean {
  return TERMINAL_STATES.includes(state);
}

export type TaskKind = "screen" | "transfer";

/** 已保存的任务记录（持久化形状由 P4b 决定，这里只描述判定需要的最小集合）。 */
export type TaskRecord = {
  taskId: string;
  kind: TaskKind;
  /** 项目归属。旧记录可能缺失——缺失时不得猜。 */
  projectId?: string;
  machine: string;
  state: TaskState;
  /** 进程内异步传输：Pi 退出后不再有进程继续它。 */
  inProcess?: boolean;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
  /** 已产生并通过判定的终态事件 id（用于去重）。 */
  emittedEventId?: string;
};

/** 这次实际观测到的结果。`observation: "unknown"` 时其余字段一律不参与判定。 */
export type TaskObservation =
  | { observation: "unknown"; reason?: string }
  | {
      observation: "reachable";
      /** 任务实际处于什么状态；来自远端 meta 或进程内表。 */
      state: TaskState;
      exitCode?: number;
      /** screen 会话的 owner（进程内标识）是否还在。 */
      ownerAlive?: boolean;
    };

/**
 * 稳定 eventId：同一 (任务, 终态) 永远得到同一个值。
 *
 * 这是投递去重的唯一基础——崩溃窗口内重复扫描必须能被识别成同一条，
 * 因此绝不能把时间戳、随机数或扫描序号掺进来。
 */
export function eventId(taskId: string, state: TaskState): string {
  const digest = crypto.createHash("sha256").update(`octssh-task-event-v1\0${taskId}\0${state}`, "utf8").digest("hex");
  return `evt-${digest.slice(0, 32)}`;
}

export type TransitionResult = {
  state: TaskState;
  observation: ObservationState;
  /** 状态是否发生了变化（用于决定是否要写回记录）。 */
  changed: boolean;
  reason: string;
};

/**
 * 由「旧状态 + 本次观测」算出新状态。
 *
 * 逐条对应契约里的判定规则，注释里标了规则编号。
 */
export function transition(record: TaskRecord, observation: TaskObservation): TransitionResult {
  // 规则 ③：可达性 unknown 永远只更新可达性，不改任务状态。
  if (observation.observation === "unknown") {
    return {
      state: record.state,
      observation: "unknown",
      changed: false,
      reason: "observation unavailable; only reachability is updated",
    };
  }

  const observed = observation.state;

  // 规则 ①：已请求取消（cancelling）时，只有确认真的停了才算 cancelled。
  // 观测到仍在 running 就保持 cancelling，不要提前宣布取消成功。
  if (record.state === "cancelling") {
    if (observed === "running") {
      return { state: "cancelling", observation: "reachable", changed: false, reason: "cancel requested, task still running" };
    }
    if (observed === "cancelling") {
      return { state: "cancelling", observation: "reachable", changed: false, reason: "still cancelling" };
    }
    // 规则 ②：取消与自然完成竞争，以实际结果为准——观测到 done/failed 就照实记录，
    // 不要因为我们请求过取消就把它改写成 cancelled。
    return { state: observed, observation: "reachable", changed: true, reason: "cancel raced with natural completion; observed result wins" };
  }

  // 已经在终态：不接受任何改写（终态只发一次事件，状态也不该被后续扫描翻转）。
  if (isTerminal(record.state)) {
    return { state: record.state, observation: "reachable", changed: false, reason: "already terminal; state is frozen" };
  }

  // 规则 ④：screen 任务的 owner 消失不等于任务失败。任务在远端 screen 里继续跑，
  // 只是我们本地的 owner 进程不在了——观测结果仍然以远端 meta 为准。
  if (record.kind === "screen" && observation.ownerAlive === false && observed === "running") {
    return { state: "running", observation: "reachable", changed: false, reason: "local owner gone; remote task keeps running" };
  }

  // 规则 ⑤：进程内异步传输无法在 Pi 退出后继续，因此重启后只能归 interrupted，
  // 不能声称它还在跑（更不续传）。
  if (record.inProcess && observed === "running") {
    return { state: "interrupted", observation: "reachable", changed: true, reason: "in-process transfer cannot survive a restart" };
  }

  // running 收到终态：照实记录。
  return { state: observed, observation: "reachable", changed: observed !== record.state, reason: `observed ${observed}` };
}

/** 请求取消：只有 running 才能进入 cancelling。 */
export function requestCancel(record: TaskRecord): TransitionResult {
  if (record.state === "running") {
    return { state: "cancelling", observation: "reachable", changed: true, reason: "cancel requested" };
  }
  return { state: record.state, observation: "reachable", changed: false, reason: `cannot cancel from ${record.state}` };
}
