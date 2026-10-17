# P6-fix 交接：对抗审查发现的三处真问题

Status: in progress
Round: P6-fix

## 文件变更

- [x] `src/remote/applyEdit.ts` — 新增 `renamed` 标志；rename 成功后的回读抛错/字节不一致/指纹取不到一律 `outcome_unknown`（外层 catch 分支按 `renamed` 区分）。rename 调用本身抛错维持现状
- [x] `src/security/evaluate.ts` — 新增导出 `operationFamily()`（exec↔exec-async、upload↔upload-async、download↔download-async，其余自身）；`ruleApplies` 改按族比较；注释说明 deny 与 allow 都必须按族
- [x] `src/core/runtime.ts` — `readFile`/`download`/`downloadAsync`/`upload`/`uploadAsync`/`cancelSession`/`writeStdin` 支持 `ask`（新增 `authorization` 参数 + `sessionConfirmation` 辅助）；upload/uploadAsync 的 ask 闸门**移到建连之前**、与覆盖冲突用不同 payload；接口同步更新
- [x] `extensions/octssh.ts` — `octssh_read`、`octssh_transfer`（下载也走确认）、`octssh_session`（write-stdin/cancel）、任务面板取消全部经 `withConfirmation`；README 补 ask 覆盖范围与 `session-get`/`session-grep` 的例外说明

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

### ①②③ applyEdit 语义（C:/tmp/p6fix，假适配器，未入库）

```
① read-back throws       -> outcome_unknown | renamed, then post-write verification failed: connection res | renamed: true
② read-back mismatch     -> outcome_unknown | renamed, but read-back bytes differ from the bytes we wrote | renamed: true
③ normal               -> success OK
③ write fails          -> not_written OK
③ chown fails          -> unsupported/chown_not_restorable OK
③ rename unsupported   -> unsupported/posix_rename_unsupported OK
③ rename throws        -> outcome_unknown OK
③ nlink=2              -> unsupported/hard_linked OK
③ missing file         -> unsupported/not_found OK
③ no_change            -> no_change
③ dry_run              -> dry_run
③ conflict(version)    -> conflict
```

①② 都确认 `rename` 已经发生（`renamed: true`），结果不再是「未写入」。

### ④ 操作族

```
④ exec deny -> exec-async                  -> deny OK
④ exec deny -> exec                        -> deny OK
④ upload allow -> upload-async             -> allow OK
④ upload allow -> download (cross-family)  -> ask OK
④ exec deny -> upload (cross-family)       -> ask OK
④ families: exec=exec exec-async=exec upload=upload upload-async=upload download=download download-async=download read=read edit=edit session-cancel=session-cancel
```

### ⑤ ask 生效（真实 runtime + 真实规则文件，C:/tmp 临时 OCTSSH_HOME）

```
⑤ read ask                               -> needs_confirmation | op: read
⑤ download ask                           -> needs_confirmation | op: download
⑤ download-async via download rule       -> needs_confirmation | op: download
⑤ session-cancel ask                     -> needs_confirmation | op: session-cancel
⑤ read allow (reaches connection)         -> threw: NETWORK
⑤ read deny                              -> blocked | op: -
⑤ upload ask                             -> needs_confirmation | op: upload
```

`read allow` 与 `read deny` 是对照组：allow 直接走到连接层（`NETWORK` 说明没被策略挡），deny 仍然阻塞。

## 说明：为什么 `session-get`/`session-grep` 不插 ask

这两个操作只读本地 session 文件、不改变远端状态；每次读日志都弹确认会训练用户盲点「是」，
反而降低后续确有副作用操作（取消、写 stdin）的确认价值。因此它们的 `ask` 不转化为弹窗，
只保留在规则记录里。这一点已写进 README 的约束段。
