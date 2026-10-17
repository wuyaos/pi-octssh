# pi-octssh v1 最终交付报告（Ralph loop octssh-v1，20/20 轮）

Status: delivered-partial（离线验收完成；真机验收 blocked）

## 交付内容

六项功能的代码全部完成，文档与模块说明齐备：

1. **远端可靠编辑**：`octssh_read` / `octssh_edit`（强/弱版本 token、逐字节替换、原子替换、六种结果语义）
2. **SSH 密码与私钥口令**：遮罩输入组件、进程内缓存、并发合并、2 次上限
3. **项目持久权限**：allow/deny/ask 三档、四选项确认、`/octssh permissions`
4. **主机密钥验证**：目标机与跳板机都校验、独立信任表、变化即阻止
5. **异步任务通知**：状态机与可达性分离、稳定事件 ID 去重、落盘投递记录、重启补报
6. **任务面板**：`/octssh tasks` 按需打开、详情/日志/取消走裁决

对抗审查（audit agent，非实现者）发现 3 个真问题并已修复验收；另有 3 个体验项也已修复。

## 复跑命令（外部监视器可执行）

```bash
cd D:/work/project/person/pi-octssh
npm run typecheck && npm test
```

- 无额外环境变量、无需网络
- 期望结果：typecheck 退出码 0；测试 `tests 22 / pass 21 / fail 1`
- 唯一失败：`walkLocal rejects symlinks instead of following directory loops`（`EPERM`，Windows 非管理员/未开 Developer Mode 的环境限制，**改动前基线即存在**，与本次实现无关）
- 所需工件：`node_modules/`（`npm ci` 产物，勿删）

## 已验路径（离线，48+ 项，全部主线程自写探针）

| 领域 | 验了什么 | 验法 |
|---|---|---|
| 主机指纹 | `computeHostKeyFingerprint` 与 `ssh-keygen -lf` 逐字符一致（ed25519/RSA） | 本机对拍 |
| 主机信任 | 无 UI 拒绝/落盘/变化阻止/损坏 fail-closed 6 例 | 假 UI + 临时目录 |
| 凭据语义 | 合并、失效、清除、取消不缓存、异常不泄明文、全局串行 | 假 prompt |
| 项目身份 | 仓库根/子目录同 id、跨项目隔离 | 真实临时目录 |
| 裁决 | deny 优先、路径段边界、命令原串、cwd/sudo 独立、fail-closed 14 例 | 纯函数探针 |
| 规则回放 | 请求↔规则双向映射，含空格/引号/中文命令，5 例 | 纯函数探针 |
| 锁 | 串行、崩溃接管（真实 instanceId 格式）、异机不抢、损坏不抢 | 真实临时目录 |
| 版本 token | 强/弱往返、7 字段篡改全检出、弱 token 进不了 edit | 纯函数探针 |
| 编辑规划 | CRLF/BOM/emoji、非法 UTF-8/NUL、0/多匹配、超限、有界 diff | 纯函数探针 |
| 写入编排 | 11 项结果语义、调用顺序、rename 前后失败注入、temp 清理 | 假适配器 |
| 读取 | token 覆盖整份文件、行窗口、弱 token 警告、空窗口 null | 假适配器 |
| 任务状态 | 取消语义、owner 消失、interrupted、unknown 零事件 | 假依赖 |
| 投递去重 | duplicate、payload 仅元数据、忙碌排队、flush 补发 | 假依赖 |
| 持久化 | 重启保留、损坏改名、v0→v1/v1→v2 迁移、高版本不降级、并发写 | 真实临时目录 |
| 扫描 | 观察失败不污染、多任务互不影响、无会话等待靠重新推导 | 假依赖 |
| 裁剪 | maxEntries/时长、旧条目永不被时间裁剪、队列独立 | 真实临时目录 |
| 回归面 | `npm test` 唯一失败与基线相同，17 轮无新增失败 | 每轮复跑 |

另有一条**真实进程**验证：`pi -p --no-session` 确认 `src/remote/AGENTS.md` 子目录注入生效。

## 未验项（blocked，不计入完成）

**P6c：真机验收 48 项**（`.ralph/real-machine-checklist.md`），全程阻塞于「WSL Debian 内装 openssh-server」的授权（迭代 1 至迭代 20 共 6 次询问，均未获批）。ssh2 内置 Server 不支持 SFTP 文件操作、不广播扩展，无法替代。

主要未验类别：

- 真实 SSH 握手与指纹展示（1.1–1.6）
- 真实密码/passphrase 登录、错误处理、keyboard-interactive-only（2.1–2.10）
- SFTP 原语与 `stat` 模板真实行为（3.1–3.12）：`createSftpFileOps`/`readAllVia`/`probeStat` 三个适配函数从未对真机执行过
- 权限在真实连接路径上的端到端（4.1–4.7），尤其 `ask` 分支只做了代码路径核实
- 通知的真实 `ctx.isIdle`/`sendMessage` 开回合、面板交互、cancelSession 往返（5.1–5.11）
- 双 Pi 进程并发（6.1–6.2）
- 对抗审查补充的真机项：`posixRename` 失败时是否可能已生效、回读断连在 ssh2 中的表现、非特权 `chown` 到自身、BSD `stat -f`/`setTimes` 秒级精度、`newVersion` 回落的影响

## 已知限制（文档已如实声明，非缺陷）

- 版本 token 不是内容哈希：同长 + mtime 还原的外部改写察觉不到（有复现）
- 命令规则是本次调用完整原串的精确匹配：`rm -rf /data` 挡不住 `rm -rf /data/`、引号、尾随空格
- `no_change` 不做远端确认（建连前即返回，带 `remoteNotChecked` 标记）
- `outcome_unknown` 尽力清理临时文件但不保证成功
- 非 git 目录从子目录启动会得到不同 projectId，已批准规则不生效
- `SecretPrompt` 不支持粘贴（bracketed paste），已记入后续改进

## 交接物

- 代码：48 文件修改 + 约 20 个新文件（`src/security/`、`src/remote/`、`src/tasks/`、`src/tui/`、`src/util/lockfile.ts` 等）
- 文档：`README.md`（工具/命令/配置/13 条限制边界）、`skills/octssh/SKILL.md`、根 `AGENTS.md` + `src/remote/AGENTS.md` + `src/tasks/AGENTS.md`
- 契约与决策：`.agents/notes/proposed/architecture/2026-10-17-octssh-v1-contract.md`
- 真机验收清单：`.ralph/real-machine-checklist.md`（48 项，含 fixture 准备命令）
- 过程证据：`.ralph/octssh-v1.md`（Verification 19 轮原文）、`.ralph/handoff/*.md`
- 未提交：所有改动留在工作区，未 commit（任务约束「不覆盖已有修改」）

## 结论

**离线可验的部分已全部完成并验收通过；真机验收因 fixture 授权未获批而 blocked。** 按任务规则（未真路径验收不得 COMPLETE），本轮以 blocked 状态收尾，不输出 COMPLETE 标记。
