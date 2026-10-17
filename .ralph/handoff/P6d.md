# P6d 交接：三个体验/诚实性小修

Status: in progress
Round: P6d

## 文件变更

- [x] `src/remote/applyEdit.ts` — 新增 `bestEffortRemove()`（吞掉异常，绝不影响结果）；`outcome_unknown` 的两种来源（rename 调用未知、post-rename 校验失败）都尽力清一次临时文件；`ApplyEditResult` 的 `outcome_unknown` 增加 `tempRemoved: false`（类型固定为 false，语义是「不声称清理成功」）；`no_change` 增加 `remoteNotChecked: true`
- [x] `extensions/octssh.ts` — `finishEdit` 的 `no_change` 文案补「在建立连接之前判定，未连接远端核对」；`outcome_unknown` 文案补「已尝试清理临时文件，但不保证成功」；`withConfirmation` 在 `scope.command` 存在时于标题追加命令规则精确匹配提示

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

### ①–⑤ applyEdit（C:/tmp/p6d，假适配器，未入库）

```
① rename throws      -> outcome_unknown | tempRemoved: false | removeFile attempts: 1 | temp still there: false
② read-back throws   -> outcome_unknown | tempRemoved: false | remove attempts: 1
③ remove also throws -> outcome_unknown | tempRemoved: false | threw: no
④ no_change          -> no_change | remoteNotChecked: true | ops: 0 | temp created: false | renamed: false
⑤ success        -> success OK
⑤ write fails    -> not_written OK
⑤ conflict        -> conflict
⑤ dry_run         -> dry_run
⑤ unsupported     -> unsupported/hard_linked | temp never created: true
```

①②③ 都确实调用了 `removeFile(tempPath)`（attempts: 1），但 `tempRemoved` 恒为 false——
不声称清理成功。③ 里 `removeFile` 自己抛错也不影响返回值、不向上抛。

④ `ops: 0` 说明 `no_change` 路径一次远端调用都没发。

### ⑥ 命令规则弹窗文案（代码路径 `extensions/octssh.ts`，`withConfirmation` 内）

拼接后的正文（`scope.command` 存在时才追加，文件类规则不受影响）：

```
注意：「始终允许 / 始终禁止」保存的是这行命令的完整原文（含空格、引号与参数顺序），
改写写法（多加一个参数、换引号、尾随空格、加路径斜杠）不会命中该规则，仍需再次确认。
```
