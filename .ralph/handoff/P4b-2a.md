# P4b-2a 交接：扫描/通知编排 + 已投递记录保留期裁剪

Status: in progress
Round: P4b-2a（不改 extension、不注册命令）

## 文件变更

- [x] `src/tasks/notify.ts`（新）— `runTaskSweep({store, delivery, observe, hasSessionForProject, now})`；观测抛错/unknown → 只跳过、不改状态、不产事件；单任务失败不中断整轮；`storeCorrupt`/`corruptFiles` 显式进汇总；区分 delivered/queued/duplicate
- [x] `src/tasks/store.ts` — 已投递记录 v1→v2 迁移（`ids` → `entries[{id, deliveredAt?}]`，缺时间按最老且**不因时间被删**）、`pruneDeliveredEntries` 导出保留策略、`pruneDelivered()`；顺带修掉 `markDelivered`/`readDeliveredState` 的 `withLock` 不可重入死锁

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

### 八项（C:/tmp/p4b2a，真实临时目录，未入库）

```
① sweep1: scanned 1 | events 1 | delivered 1 | queued 0 | updated 1 | sent 1
① written back: state done | emittedEventId true
① sweep2: events 0 | delivered 0 | sent total 1
② failures: [{"taskId":"bad","error":"ssh timeout"}] | bad state: running | bad emitted: (none) | events: 1 | good handled: true
③ events: 0 | state: running | emitted: (none) | updated: 0 | sent: 0
④ events: 0 | notAwakened: [{"taskId":"t1","state":"done","reason":"no_session_for_project"}] | queue: 0 | sent: 0
④ next sweep events: 1 | flushed: 0 | sent total: 1
⑤ events: 2 | delivered: 2 | sent: 2 | states: a:done,b:done
⑥ storeCorrupt: true | corruptFiles: 1 | scanned: 0
⑦ old ids still block: true true
⑦ migrated version: 2 | entries: 2 | old kept: old-1,old-2
⑦ prune removed: 12 | kept: 2 | entry kept sample: old-1,old-2
⑦ maxEntries=3 -> removed: 0 | kept: 2
⑧ prune removed: 6 | queue still: 1
```

补充（裁剪边界，第二个探针）：

```
overflow maxEntries=5: {"removed":["v1-a","v1-b","r-0","r-1","r-2","r-3","r-4"],"kept":["r-5","r-6","r-7","r-8","r-9"]}
cutoff exact kept: [{"id":"a","deliveredAt":999900}]
no-time never dropped by age: {"kept":[{"id":"old"}],"removed":[]}
```

⑦ 是保留期这一项的关键：v1 旧文件迁移后旧 id 仍在（重复投递仍被拦），时间裁剪**不删**这些
无时间条目（`kept: 2 | entry kept sample: old-1,old-2`），只有条数压缩时才从最老的丢起。

### 本轮修掉的一个死锁

`markDelivered` 在已持有 `store.lock` 的临界区里又调用了会自己加锁的 `readDeliveredState`，
而 `withLock` 不可重入——同进程会等自己直到 `LockBusyError`。已拆成
`readDeliveredUnlocked`（持锁路径用）+ `readDeliveredState`（自己持锁一次完成读+迁移），
现在 `markDelivered`/`tryAcquireLease`/`pruneDelivered` 都在同一层锁内完成读改写。

## 未完成 / 待 P4b-2b

- `runTaskSweep` 尚未接入 runtime/extension；`storeCorrupt` 的一次性用户提示未接；`pruneDelivered` 无定时调用点。
- 投递「排队」当前只发生在 `runTaskSweep` 之外（delivery 的 channelState）；sweep 里没有为 queued 补发，
  补发依赖 `delivery.flush()` 由宿主周期调用。
