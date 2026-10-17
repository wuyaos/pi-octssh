# src/remote：远端文本读取与可靠编辑

只处理「远端是一个普通 UTF-8 文本文件」的场景；其它形态一律明确拒绝。

## 入口

- `fingerprint.ts`：版本 token 编解码、强/弱保证等级、GNU/BSD `stat` 模板
- `editPlan.ts`：纯函数——校验 token 与匹配唯一性、逐字节替换、生成有界 diff
- `applyEdit.ts`：写入编排，远端能力经 `RemoteFileOps` 注入
- `readFile.ts`：读取，行窗口只影响展示，token 始终覆盖整份文件
- `sftpFileOps.ts`：真适配器，只转发不自作判断

## 契约

- token 是**字符串比较**的 CAS 载体，不是内容哈希；`editPlan` 同时要 `expectedVersion`（调用方认知）与 `currentVersion`（刚实测）。
- 写入顺序固定：取指纹 → 读 → 规划 → 独占临时文件 → 写 → 复原属性 → 再次核验目标 → `posixRename` → 回读。
- **`posixRename` 成功之后的任何失败（回读抛错、回读不一致、取指纹失败）都是 `outcome_unknown`**；报 `not_written` 就是谎报。
- `rename` 之前失败 → `not_written`；版本不符 / 目标状态变化 → `conflict`；能力或形态不符 → `unsupported`。
- 结果里的 `no_change` 与 `dry_run` 都不落盘、不建临时文件。

## 坑

- SFTP v3 的 attrs 没有 inode/nlink，**强指纹只能由远端 `stat` 模板补齐**（每次 edit 多 1 次 RTT，属已知代价）；模板缺失时只给弱 token。
- `chown`/`chmod`/`setTimes` 一律作用于**临时文件**；目标文件只被 `posixRename` 动一次。
- 临时文件必须与目标**同目录**（否则 rename 可能跨设备失败）。
- 最后核验与 `posixRename` 之间存在 TOCTOU 窗口，注释与错误信息里必须如实写明；不声称对外部写者的 CAS。
- `no_change` 在建连与读文件之前就返回，因此它不代表「远端确认过内容」。
- 回读不一致时 `outcome_unknown` 会比 `conflict` 更诚实：改名可能已经生效。
