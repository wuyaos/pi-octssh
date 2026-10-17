# P4b-2b 交接：扫描/通知接入 + /octssh tasks 面板

Status: in progress
Round: P4b-2b（不连远端）

## 文件变更

- [x] `src/core/runtime.ts` — 接上 `createTaskStore({baseDir})` + `createDelivery` + `runTaskSweep`；新增 `setNotifyHooks`/`sweepTasks`/`flushTaskNotifications`/`listTasks`/`pruneTaskDelivered`/`taskStoreStatus`；`observeTask` 把任何异常与 `kind:"error"` 一律降级为 `unknown`；`syncTaskRecords` 只补新 session、不覆盖已有记录（避免把终态重置成 running）；`storeCorrupt` 用 `taskStoreCorruptReported` 只上报一次
- [x] `extensions/octssh.ts` — 通知通道 `channel`/`sink`（`sendMessage` 走 `ExtensionAPI`，ctx 上没有该方法）；`isIdle()` + `triggerTurn:true` 双闸；`/octssh tasks [wake on|off]` 面板（默认只看当前项目、可切全部、详情/日志/取消）；取消走 `rt.cancelSession(...)`；`startSweepTimer`/`stopSweepTimer` 在 `session_start`/`session_shutdown` 成对
- [x] `src/state/config.ts` — 新增 `taskNotify: { autoWake, sweepIntervalSeconds, deliveredRetentionDays, deliveredMaxEntries }`（`.strict()` + `.default({})`，不影响已有 config.json）

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

### 六项核实方法与结果

**① 工具 schema 与新命令不引入 `projectId`** —— 用脚本对 `extensions/octssh.ts` 做源码结构断言（TypeBox 源对象 + `argv[0]` 提取）：

```
① hostsSchema      keys: machine,refresh,target | banned: (none)
① execSchema       keys: machine,command,mode,sudo | banned: (none)
① transferSchema   keys: machine,direction,localPath,remotePath,async | banned: (none)
① sessionSchema    keys: action,sessionId,lines,pattern,maxMatches,contextLines,data,appendNewline,signal | banned: (none)
① readSchema       keys: machine,path,offset,limit | banned: (none)
① editSchema       keys: machine,path,expectedVersion,oldText,newText,dryRun | banned: (none)
① subcommands: forget,wake,remove,trust,permissions,tasks,credentials
① projectId only from ctx: true | appears in schemas: false
```

**② `sendMessage` 只在 `isIdle()` 为真时以 `triggerTurn: true` 调用** —— 代码路径 + 行号（`extensions/octssh.ts`）：

```
168:      if (!notifyConfig.autoWake) return "no_session";        ← channel: 关掉唤醒就当无通道，事件排队
170:      return ctx.isIdle() ? "ready" : "busy";                  ← channel: 忙则 busy
177:      if (!notifyConfig.autoWake || !ctx.isIdle()) return;     ← sink: 二次确认后才发
178:      api.sendMessage(..., { triggerTurn: true });             ← 唯一调用点
```

只有一处 `sendMessage`，且被 `isIdle()` + `autoWake` 双重拦截。

**③ 关闭自动唤醒后不再调 `sendMessage`** —— 两种验证都做了：
- 代码路径：`autoWake=false` 时 `channel` 直接返回 `no_session`（第 168 行），`sink` 也在第 177 行提前 return；
- 探针（等价路径，用 delivery 的注入点模拟同一闸门）：

```
③ autoWake-off path: {"kind":"queued","eventId":"e1","reason":"no_session"} | sink calls: 0 | queued: 1 | marked delivered: false
```
即：不发、不丢、不标已投递——恢复开会话后仍能补发。

**④ 定时器在 shutdown 被清理** —— 代码路径 + 行号：

```
193:function stopSweepTimer() { 195: clearInterval(sweepTimer);
200:function startSweepTimer() { 201: stopSweepTimer();   ← 重复启动前先清
1025:      startSweepTimer();                              ← session_start
1040:    stopSweepTimer();                                ← session_shutdown
```
另加 `sweepTimer.unref?.()`，避免定时器阻止进程退出。

**⑤ `storeCorrupt` 只提示一次** —— 真实 runtime 探针（C:/tmp 临时目录，写入损坏 index.json）：

```
⑤ sweep1 storeCorrupt: true reported: true
⑤ sweep2 storeCorrupt: true reported: false
⑤ sweep3 reported: false
⑤ flag stays true (not silently cleared): true
```

**⑥ 面板里的取消走 runtime 裁决** —— 代码路径 + 行号：

```
661:      const result = (await rt.cancelSession(task.taskId, undefined, pid)) as Record<string, unknown>;
```
面板只调 `rt.cancelSession`，而 runtime 内该入口已接 `sessionDenied(...)` 裁决（P2b）；面板里
没有任何 `screen -X`/`kill` 直连调用。

## 未完成 / 待真机

- 未连真实远端：`observeTask` 的真实 `getSession` 往返、`sendMessage` 在真实 TUI 的开回合行为、
  定时器在长时间会话中的实际节奏都未验证。
- `/octssh tasks` 的日志视图只取 `getSession` 返回的前 60 行并硬截断 8000 字符，未做分页。
- `deliveredRetentionDays`/`deliveredMaxEntries` 已进 config，但 `pruneTaskDelivered` 目前没有自动调用点
  （只有面板/runtime 暴露的方法），需要 P4c 或后续接周期裁剪。
