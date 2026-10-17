import {
  eventId,
  isTerminal,
  transition,
  type ObservationState,
  type TaskObservation,
  type TaskRecord,
  type TaskState,
} from "./state.ts";

/**
 * 恢复判定：给「已保存的记录 + 本次观测」，算出新状态与本次应产生的完成事件。
 *
 * 纯函数，不做 IO，不读文件、不发通知。这样同一份输入永远得到同一份输出，
 * 面板展示与投递逻辑都能离线验满。
 */

export type TaskCompletionEvent = {
  /** 稳定 id：同一 (任务, 终态) 重复扫描必然相同。 */
  eventId: string;
  taskId: string;
  kind: TaskRecord["kind"];
  machine: string;
  projectId: string;
  state: TaskState;
  exitCode?: number;
  startedAt?: string;
  endedAt?: string;
};

export type NotAwakenedReason = "missing_project_id" | "no_session_for_project";

export type RecoveryOutcome = {
  /** 更新后的记录（未变化时与原记录内容相同）。 */
  record: TaskRecord;
  observation: ObservationState;
  /** 本次应投递的完成事件；终态只出现一次。 */
  events: TaskCompletionEvent[];
  /**
   * 因缺少项目归属而未唤醒的任务。不猜归属，所以不产生事件，
   * 但要让面板能解释「为什么这个已完成的任务没有通知」。
   */
  notAwakened: { taskId: string; state: TaskState; reason: NotAwakenedReason }[];
  /** 需要写回磁盘的标记：状态或观察结果发生了变化。 */
  shouldPersist: boolean;
};

export type RecoverInput = {
  record: TaskRecord;
  observation: TaskObservation;
  /** 本次可用的同项目会话（由调用方查好；空数组表示没有）。 */
  hasSessionForProject?: (projectId: string) => boolean;
  now?: string;
};

/**
 * 只有终态、有项目归属、并且尚未为同一终态发过事件时才产生事件。
 *
 * `emittedEventId` 存在且等于本次算出的 id 时说明已经发过——这是崩溃窗口
 * 之后重新扫描的唯一判据，绝不靠时间或计数。
 */
function shouldEmit(record: TaskRecord, state: TaskState): boolean {
  if (!isTerminal(state)) return false;
  return record.emittedEventId !== eventId(record.taskId, state);
}

export function recoverTask(input: RecoverInput): RecoveryOutcome {
  const { record, observation } = input;
  const result = transition(record, observation);
  const newlyTerminal = !isTerminal(record.state) && isTerminal(result.state);

  const events: TaskCompletionEvent[] = [];
  const notAwakened: RecoveryOutcome["notAwakened"] = [];

  if (shouldEmit(record, result.state)) {
    if (!record.projectId) {
      // 规则 ⑥：旧记录缺项目归属时不猜，也不唤醒到任意会话。
      notAwakened.push({ taskId: record.taskId, state: result.state, reason: "missing_project_id" });
    } else if (input.hasSessionForProject && !input.hasSessionForProject(record.projectId)) {
      // 没有同项目会话：事件先不产生，记录也**不**标记为已发（下一轮还能补发）。
      notAwakened.push({ taskId: record.taskId, state: result.state, reason: "no_session_for_project" });
    } else {
      const id = eventId(record.taskId, result.state);
      events.push({
        eventId: id,
        taskId: record.taskId,
        kind: record.kind,
        machine: record.machine,
        projectId: record.projectId,
        state: result.state,
        exitCode: observation.observation === "reachable" ? observation.exitCode ?? record.exitCode : record.exitCode,
        startedAt: record.startedAt,
        endedAt: record.endedAt ?? (newlyTerminal || isTerminal(result.state) ? (input.now ?? new Date().toISOString()) : undefined),
      });
    }
  }

  const updated: TaskRecord = {
    ...record,
    state: result.state,
    exitCode:
      observation.observation === "reachable" && observation.exitCode !== undefined
        ? observation.exitCode
        : record.exitCode,
    // 只有真的产出了事件才记下 id：否则下一轮会被误判为「已通知」而永不补发。
    emittedEventId: events.length > 0 ? events[0].eventId : record.emittedEventId,
    ...(isTerminal(result.state) && !record.endedAt ? { endedAt: input.now ?? new Date().toISOString() } : {}),
  };

  return {
    record: updated,
    observation: result.observation,
    events,
    notAwakened,
    shouldPersist:
      updated.state !== record.state ||
      updated.exitCode !== record.exitCode ||
      updated.emittedEventId !== record.emittedEventId ||
      updated.endedAt !== record.endedAt,
  };
}

/** 批量恢复：按传入顺序处理，逐个产出事件（顺序稳定，便于测试与展示）。 */
export function recoverTasks(inputs: readonly RecoverInput[]): RecoveryOutcome[] {
  return inputs.map((item) => recoverTask(item));
}
