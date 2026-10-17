# P4a 交接：任务状态/恢复判定/通知投递记录

Status: in progress
Round: P4a（纯逻辑 + 注入，不改 runtime/extension/命令/远端）

## 文件变更

- [x] `src/tasks/state.ts`（新）— `TaskState` 与 `ObservationState` 分离；`transition(record, observation)` 按规则 ①–⑥ 判定；`eventId(taskId, state)` 为纯哈希（不含时间/随机）；`requestCancel` 只在 running→cancelling
- [x] `src/tasks/recovery.ts`（新）— `recoverTask`/`recoverTasks` 纯函数：终态只发一次、`unknown` 不发、缺归属或无可投会话时记入 `notAwakened` 且**不**写 `emittedEventId`（下一轮可补发）
- [x] `src/tasks/delivery.ts`（新）— `DeliveryStore` 注入接口 + 内存实现；`createDelivery` 提供 `deliver`/`drainQueue`/`flush`；去重靠 eventId；租约靠 `tryAcquireLease` + 显式 `stealLease`（只在确认持有者死亡后）；busy/no_session 一律排队；`buildPayload` 只含元数据

## 验证输出

### typecheck / test

```
> pi-octssh@0.1.0 typecheck
> tsc --noEmit
TC=0

ℹ tests 22
ℹ pass 21
ℹ fail 1
✖ walkLocal rejects symlinks instead of following directory loops
```

### 十项（C:/tmp/p4a，未入库）

```
① requestCancel running: {"state":"cancelling","observation":"reachable","changed":true,"reason":"cancel requested"}
① cancel + observed running : {"state":"cancelling",...,"reason":"cancel requested, task still running"}
① cancel + observed done    : {"state":"done",...,"reason":"cancel raced with natural completion; observed result wins"}
① cancel + observed failed  : {"state":"failed",...,"reason":"cancel raced with natural completion; observed result wins"}
② unknown -> state: running | observation: unknown | events: 0 | persist: false
③ first  events: 1 evt-3b7e9c83c5cb2715f93c74424c3f4be7
③ second events: 0 | same id: true | id stable across calls: true
③ id independent of time: true
④ deliver 1: {"kind":"delivered","eventId":"evt-3b7e..."} | send calls: 1
④ deliver 2: {"kind":"duplicate","eventId":"evt-3b7e..."} | send calls: 1 | ids equal: true
⑤ B while A alive: {"kind":"lease_held","taskId":"t1","holder":{"holderId":"A",...}}
⑤ B when A dead  : {"kind":"delivered","eventId":"evt-3b7e..."} | delivered: 1
⑤b concurrent kinds: ["delivered","lease_held"] | send calls: 1 | delivered flags: 1
⑥ busy deliver: {"kind":"queued",...,"reason":"busy"}  (×2)
⑥ queued count: 2 | delivered marked: 0 | sent: 0
⑥ flush delivered: 2 | remaining: 0 | sent: 2
⑦ no_session: {"kind":"queued",...,"reason":"no_session"}
⑦ queue: 1 | marked delivered: 0 | sent to: []
⑦ recovery with no session -> events: 0 | notAwakened: [{"taskId":"t1","state":"done","reason":"no_session_for_project"}] | emittedEventId: (none)
⑧ missing project -> events: 0 | notAwakened: [{"taskId":"t1","state":"done","reason":"missing_project_id"}] | state: done
⑨ owner gone: {"state":"running","observation":"reachable","changed":false,"reason":"local owner gone; remote task keeps running"}
⑩ in-process restart: {"state":"interrupted",...,"changed":true,"reason":"in-process transfer cannot survive a restart"}
⑩ interrupted event: 1 interrupted | not done/failed: true
```

补充（同目录第二个探针）：

```
payload: {"taskId":"t9","machine":"web","state":"done","exitCode":0,"startedAt":"2026-01-01T00:00:00Z","endedAt":"2026-01-01T00:01:30Z","durationMs":90000}
payload banned keys: (none)
eventId stable x5: true
eventId differs by state: true
eventId differs by task : true
```

## 未完成 / 待 P4b

- 记录持久化与 `sessions.ts` schema 迁移（本轮明确不做）：`TaskRecord` 目前是独立类型，
  尚未与 `SessionRecord` 对齐，P4b 需要决定是扩字段还是旁挂 `tasks/*.json`。
- `DeliveryStore` 只有内存实现；落盘版需用 `withLock` 保证 `tryAcquireLease`/`stealLease` 原子性。
- `notAwakened` 的 `no_session_for_project` 与面板展示尚未接入（无 runtime/extension 改动）。
