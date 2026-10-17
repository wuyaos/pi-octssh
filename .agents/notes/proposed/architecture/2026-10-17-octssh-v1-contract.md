# Agent Note: pi-octssh v1 契约冻结（身份/认证/权限/远端编辑/任务通知）

Status: proposed

## Problem

现有 pi-octssh 只有 `hosts/exec/transfer/session` 四个工具与「内建危险模式 + 60s 内存授权」。要补的六项功能（远端可靠编辑、SSH 密码与私钥口令、项目级持久权限、主机密钥验证、异步完成通知、任务面板）都落在同一批共享契约上：连接身份、操作裁决、编辑版本校验、任务归属与通知投递。这些契约一旦各写一套，就会出现「别名换指向后旧授权仍然生效」「弱版本指纹被当作 CAS 用」「断网被记成失败」这类不会在本地测试里暴露、但上线即真实发生的错误。本笔记冻结这批契约，并记录取证与放弃的选项。

## Decision

### 1. 身份必须绑定真实端点，别名不是身份

- 主机信任记录绑定 `host + port + 服务器主机公钥`；操作权限绑定 `alias + host + port + user + 跳板路线`。
- `ssh_config` 把别名重指向别的 HostName/User 后，既有信任与授权**不得继承**。
- 身份由宿主计算并注入 Runtime；模型工具参数只能选主机别名，不能提供身份或项目标识。

取证：`extensions/octssh.ts` 的工厂函数拿不到 cwd，`createOctsshRuntime()` 无参（`src/core/runtime.ts:355`）；`src/ssh/machine.ts` 的 host/port/user 只在连接期算出，从不进入授权摘要。

### 2. 主机密钥与凭据

- 用 ssh2 `hostVerifier(key, verify)`，**不设 `hostHash`**，从而拿到原始主机公钥字节：自己算 `SHA256:base64` 以便与 `ssh-keygen -lf` 对齐，并从 blob 首个 SSH string 解析算法名。
- `verify` 是回调，可异步：首次确认弹窗、密钥变化阻止都在回调内完成；无 UI 时直接 `verify(false)`。
- 信任记录存插件自有的 `known-hosts.json`（跨项目共享），不改系统 `~/.ssh/known_hosts`。
- 认证顺序自行指定（`authHandler(authsLeft, partialSuccess, cb)`，可异步调用 cb）：none → agent → publickey(+passphrase) → password。`authsLeft` 用来识别「服务器只接受 keyboard-interactive」，归类为不支持，而不是当成密码失败。
- 密码与私钥口令只经遮罩组件人工输入，仅进程内缓存；缓存键分别为 `identityKey` 与私钥材料哈希（换文件即失效）。

取证：`node_modules/ssh2/lib/client.js:273-286`（hostVerifier + hostHash 语义）、`:735-742`（passphrase / tryKeyboard）、`:836-853`（authsAllowed 与 authHandler 顺序）、`:1077`（authHandler 可异步）、`node_modules/@types/ssh2/index.d.ts:723-742`。

### 3. 蒙面输入必须自造组件

- `@earendil-works/pi-tui` 的 `Input` 在 0.81.1 与 1.3.0 都**没有** mask 选项，`ctx.ui.input()` 也是明文。遮罩输入用 `ctx.ui.custom<T>(factory, { overlay })` 自造 Component + Focusable。
- 两版 `Component`/`Focusable` 结构一致（1.3.0 仅多可选 `handleMouse`），因此实现按 0.81.1 devDeps 写、在 1.3.0 运行时可用，无需改 `devDependencies`。

取证：`node_modules/@earendil-works/pi-tui/dist/components/input.d.ts`、`.../dist/tui.d.ts:10-31` 与全局 1.3.0 同名文件 `:68-89`；`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:116`（custom 支持 overlay）。

### 4. 操作裁决单一入口，deny 优先

- 所有受管入口（read/edit/upload/download/exec/session 查询与取消）走同一 `evaluate()`：内建硬禁止 → 项目 deny → 项目 ask → 项目 allow → 内建需确认 → 默认沿用现状。
- allow 只跳过人工确认，不跳过主机密钥校验、上传冲突检查、编辑版本校验。
- 规则匹配：主机身份精确；命令按原始完整串 + 远端 cwd + sudo 条件；文件按精确文件或目录子树（按路径段边界，`/app` 不匹配 `/application`）。不做命令前缀授权。
- 规则文件损坏 → 拒绝模式，不自动回退可能缺最新 deny 的备份。

### 5. 远端编辑：强指纹才允许写

- `expectedVersion` 是不透明 token，自带保证等级：`v1i`（inode/链接数/uid/gid/mode/size/mtime，来自固定 `stat` 模板）允许 edit；`v1w`（仅 size/mtime/mode/type）仅供 read。edit 拿到弱指纹返回 `unsupported`，不降级当 CAS。
- SFTP v3 attrs 无 inode/nlink，硬链接与 owner 判定**只能靠远端 `stat`**：GNU `stat -c` 与 BSD `stat -f` 两套常量模板，路径仅经 `quoteForSh`，不嵌内容。
- 写入：同目录 `wx` 独占 temp → 写前再取指纹比对 → `chmod`/`chown`/`utimes` 复原 → `posix-rename@openssh.com` 原子替换 → 回读指纹 + 有界 diff。`chown` 无法复原（非特权 uid）时拒绝，不能只保 mode 静默通过。
- 结果区分 `success/conflict/unsupported/not_written/outcome_unknown/blocked`；`outcome_unknown` 不盲重试。
- 最后核验到 rename 之间仍有 TOCTOU 窗口，文档与错误信息原样写明；不宣称对外部写者的 CAS。

取证：`node_modules/ssh2/lib/protocol/SFTP.js:107-112`（固定 v3）、`:2418-2435`（attrs 无 inode/nlink）、`:1314`（posix-rename 不支持时抛错）、`:2536`（OPEN_MODE.EXCL）、`:1009`（lstat）；`src/ssh/sftp.ts:110-124`（现有 `sftpPut` 直写目标，不可复用）。

### 6. 任务状态与通知

- 状态 `running/cancelling/done/failed/cancelled/interrupted` 与可达性 `reachable/unknown` 分离；断网只更新可达性，不生成失败事件。
- screen 任务可在 Pi 退出后继续，恢复靠重探；进程内异步传输不承诺续传，重启识别为中断/待核对。
- 通知用稳定 `eventId` + 用户侧投递记录，正常去重，崩溃窗口允许可识别重复；不承诺 exactly once。
- 唤醒：`ctx.isIdle()` 时 `sendMessage({ triggerTurn: true })`；忙时用 `deliverAs` 排队而不是丢弃；关闭唤醒仍保留 UI 提示与面板记录。这一条与 SDK 语义一致：`triggerTurn` 仅对 idle 的自定义消息开启新回合。

取证：`.../core/extensions/types.d.ts:735`（idle custom message 启动回合）、`:1258`（sendMessage + deliverAs）、`:236`（isIdle）；`src/transfer/manager.ts:14`（活跃表为模块级 Map，跨进程不可见）；`src/state/sessions.ts`（`.strict()` schema，加字段需同步迁移）。

## Alternatives considered

1. **用 ssh2 内置 Server 做本地隔离 fixture**：改动最小、无需系统服务。放弃——其 SFTP 子系统不支持文件操作、也不广播扩展（本轮实测结论），`posix-rename`/`stat` 契约根本无法验证，验证会退化成「看起来通过」。
2. **`expectedVersion` 设为可选，缺省按「读到即写」**：接口更顺手。放弃——这正是要修的「远程改代码容易出错」；缺省弱校验等于把旧副本覆盖当作正常路径。
3. **复用现有 `sftpPut` 并加「写入后回读」当作可靠编辑**：代码量最小。放弃——直写目标无法提供半写保护，回读只能事后发现损坏，不能避免。
4. **用远端 `flock`/锁文件实现真 CAS**：语义最强。放弃——SFTP 无可靠锁原语，僵尸锁清理会引入新的误删风险；首版明确「同写者串行 + 冲突检测 + last-writer-wins」，并把 TOCTOU 写进文档。
5. **主机信任与权限沿用别名（不放 host/port/user 进键）**：改动最小、规则文件更短。放弃——别名重指向会把授权静默套到另一台机器。
6. **默认「未命中规则即询问」**：安全姿态更强。放弃——会让每条 `uname -a` 都弹窗，与「不常驻打扰」冲突；改为显式覆盖层，未命中沿用现有内建策略。
7. **把系统 `~/.ssh/known_hosts` 作为信任源**：避免重复确认。放弃——格式兼容与污染风险；改为插件自有文件，系统互通列为后续独立议题。
8. **通知使用 `pi.sendMessage` 无脑触发新回合**：实现更简单。放弃——忙碌时会被并入/打断当前流，改为 idle 触发、忙时排队。

## Acceptance criteria

- 首次连接未知主机弹出指纹确认且与 `ssh-keygen -lf` 一致；密钥变化阻止，且不发出任何认证尝试。
- 只有密码的机器：错误两次后停止且不再弹窗；密码/passphrase 不出现在 session json、transfer 日志、工具结果与终端输出。
- 同命令换别名指向另一 user 时规则不命中；`始终禁止` 后同一命令被拒；`始终允许` 后 host key 变化仍被拦。
- 编辑真实文件：diff 正确、回读一致、mode 保留、mtime 更新；期间被外部改动则返回 `conflict` 且文件未变；symlink/非 UTF-8/超限/`stat` 模板缺失一律 `unsupported`。
- 编辑过程中 kill Pi，目标文件不出现半写；残留 temp 可定位。
- 断网期间任务显示 `unknown` 而非 `failed`；取消请求不等于已取消；Pi 重启补报且同事件不重复交付。
- 面板可查看/详情/按需日志/取消，关闭后无后台刷新。

## Risks

- 强指纹依赖远端 `stat` 模板：BusyBox 等极简实现字段可能不同，需一次探测并缓存「哪套模板可用」，否则普通主机被误判为不支持编辑。
- 每次 edit 多 2–3 次 exec RTT 取指纹，是明确的性能代价，需在文档点明「额外命令而非内容通道」。
- `chown` 需特权：普通用户编辑他人/root 文件会落到拒绝分支，可用性低于直觉预期，需在错误信息里给出确切原因。
- hostVerifier 拿到的是原始公钥字节，指纹展示格式靠自己算；格式算错会让用户比对失败——必须在真机与 `ssh-keygen -lf` 对拍。
- `sessions`/规则 schema 为 `.strict()`：加字段必须同时做读写迁移，否则旧文件在旧读取者处直接解析失败。
- 真路径验收需要真 OpenSSH 服务端（本机 Windows sshd 需管理员启动；WSL Debian 内可装 `openssh-server` 走回环）。缺该 fixture 时 SFTP/认证类验收只能标 blocked。
