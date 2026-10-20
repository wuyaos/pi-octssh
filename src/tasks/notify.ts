import type { createDelivery } from "./delivery.ts";
import { recoverTask, type TaskCompletionEvent, type NotAwakenedReason } from "./recovery.ts";
import type { TaskObservation, TaskRecord } from "./state.ts";
import type { TaskStore } from "./store.ts";

/**
 * 一次任务扫描的编排。
 *
 * 全部依赖注入：`observe` 由调用方提供（可能很慢，也可能失败），因此这一层
 * 可以完全离线验证——包括「观测失败不得变成任务失败」这类关键行为。
 *
 * 三条硬性规则：
 * 1. `storeCorrupt` 必须显式上报。`loadTasks()` 在索引损坏时返回空数组，
 *    如果忽略这个标记，用户看到的就是「没有任务」，而不是「记录读不出来」。
 * 2. 观测失败/unknown 只更新可达性：不产生事件、不改状态，重试留给下一轮。
 * 3. 单个任务出错不中断整轮：其余任务照常处理。
 */

export type SweepDelivery = ReturnType<typeof createDelivery>;

export type SweepDeps = {
  store: TaskStore;
  delivery: SweepDelivery;
  /** 观测单个任务。可能抛错，也可能返回 unknown。 */
  observe: (record: TaskRecord) => Promise<TaskObservation>;
  /** 该项目的会话是否可用（决定事件是投递还是排队）。 */
  hasSessionForProject?: (projectId: string) => boolean;
  now?: () => string;
  signal?: AbortSignal;
};

export type SweepEventResult = {
  event: TaskCompletionEvent;
  outcome: "delivered" | "queued" | "duplicate" | "lease_held";
  queueReason?: "busy" | "no_session";
};

export type SweepSummary = {
  scanned: number;
  /** 观测失败的任务 id（本轮跳过，状态未改）。 */
  observationFailures: { taskId: string; error: string }[];
  eventsProduced: number;
  delivered: SweepEventResult[];
  queued: SweepEventResult[];
  duplicates: number;
  notAwakened: { taskId: string; state: string; reason: NotAwakenedReason }[];
  /** 索引损坏等存储问题的显式标记：调用方应提示用户一次。 */
  storeCorrupt: boolean;
  corruptFiles: { file: string; renamedTo: string; error: string }[];
  recordsUpdated: number;
};

export async function runTaskSweep(deps: SweepDeps): Promise<SweepSummary> {
  const now = deps.now ?? (() => new Date().toISOString());
  const summary: SweepSummary = {
    scanned: 0,
    observationFailures: [],
    eventsProduced: 0,
    delivered: [],
    queued: [],
    duplicates: 0,
    notAwakened: [],
    storeCorrupt: false,
    corruptFiles: [],
    recordsUpdated: 0,
  };

  // 先读状态：损坏标记必须在读记录时就取到（loadTasks 会隔离损坏文件）。
  const records = deps.store.loadTasks();
  const status = deps.store.status();
  summary.storeCorrupt = status.storeCorrupt;
  summary.corruptFiles = status.corruptFiles;
  summary.scanned = records.length;

  for (const record of records) {
    if (deps.signal?.aborted) break;
    let observation: TaskObservation;
    try {
      observation = await deps.observe(record);
    } catch (error) {
      // 观测失败 ≠ 任务失败：只记一笔，状态保持原样，下一轮再试。
      summary.observationFailures.push({
        taskId: record.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    if (deps.signal?.aborted) break;
    let outcome;
    try {
      outcome = recoverTask({
        record,
        observation,
        hasSessionForProject: deps.hasSessionForProject,
        now: now(),
      });
    } catch (error) {
      summary.observationFailures.push({
        taskId: record.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    // 可达性 unknown：recoverTask 已保证不产事件、不改状态；这里不再写盘。
    if (outcome.observation === "unknown") continue;

    for (const item of outcome.notAwakened) {
      summary.notAwakened.push({ taskId: item.taskId, state: item.state, reason: item.reason });
    }

    for (const event of outcome.events) {
      summary.eventsProduced += 1;
      const result = await deps.delivery.deliver(event);
      switch (result.kind) {
        case "delivered":
          summary.delivered.push({ event, outcome: "delivered" });
          break;
        case "queued":
          summary.queued.push({ event, outcome: "queued", queueReason: result.reason });
          break;
        case "duplicate":
          summary.duplicates += 1;
          break;
        case "lease_held":
          summary.duplicates += 1;
          break;
      }
    }

    if (deps.signal?.aborted) break;
    if (outcome.shouldPersist) {
      try {
        deps.store.upsertTask(outcome.record);
        summary.recordsUpdated += 1;
      } catch (error) {
        // 写回失败不能让整轮扫描中断；下一轮会重新观测并再算一次。
        summary.observationFailures.push({
          taskId: record.taskId,
          error: `persist failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  return summary;
}
