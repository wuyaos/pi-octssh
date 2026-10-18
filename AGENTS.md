# pi-octssh：Pi 的原生 SSH 扩展（无 MCP、无独立进程）

本地与远端严格分离：本机操作走 Pi 内置工具，远端操作必须显式给 `machine`。扩展运行在 Pi 进程内。

## 目录地图

- `extensions/octssh.ts`：工具注册、四选项确认弹窗、`/octssh` 命令、通知投递通道、任务面板
- `src/core/runtime.ts`：唯一编排入口——连接计划、权限裁决、read/edit、任务扫描与投递
- `src/ssh/`：ssh_config 解析、连接池、ProxyJump、SFTP 原语、screen 任务、主机密钥校验、凭据与认证
- `src/security/`：远端身份、项目身份、持久规则、裁决纯函数、请求↔规则映射
- `src/remote/`：远端文本读取与可靠编辑（有局部 AGENTS.md）
- `src/tasks/`：任务状态、恢复、投递、落盘持久化（有局部 AGENTS.md）
- `src/transfer/`：上传下载规划、冲突检测、异步传输管理
- `src/state/`：配置、会话、主机信任、路径与原子写
- `src/tui/`：自定义组件（遮罩密码输入）
- `skills/octssh/`：配套 Skill；`test/`：`node:test` 用例（CJS 里加载 TS 源码）

## 命令

- 安装：`npm ci`
- 类型检查：`npm run typecheck`
- 测试：`npm test`（单文件：`node --experimental-strip-types --test test/<file>.test.js`）
- 全部检查：`npm run check`

`node_modules/` 是基线产物，勿删。

## 规范

- 远端能力经**依赖注入 seam** 引入（如 `RemoteFileOps`），编排保持纯逻辑，便于离线验证。
- 预期分支用显式 `kind` 表达，不用异常；异常只留给真正的意外。
- 工具 schema 里**不得**出现 `projectId` 等项目身份字段。
- 项目身份只由宿主从 `ctx.cwd` 推导（`src/security/project.ts`）：git 仓库取工作树根；
  非 git 时从 cwd 向上找 `.pi/octssh.json`，找到就以其所在目录为根（只查存在性）；
  都没有才退回启动目录。git 检测优先——仓库子目录里的标记文件不会切碎项目。
- 注释写「为什么」与不可逾越的边界（TOCTOU、为何不重试），不写「做了什么」。
- 只在真实边界（用户输入、远端返回、文件 IO、跨进程）做校验；内部调用按约定信任，不加兜底 try/catch。
- 设计取舍记 `.agents/notes/`；机械改动不记。
- 中文注释与文档用中文标点；代码标识符与命令保持原样。

## 红线

- **裁决先于连接**：命中 `deny` 的操作必须在建立 SSH 连接之前就返回。
- **内建硬禁止高于项目规则**：项目 `allow` 不得覆盖安全策略的 `block`。
- **命令规则按完整原串匹配**，不做前缀或模糊授权；也不要假设它能挡住改写后的等价命令。
- **edit 只接受强指纹**（`v1i`）；弱指纹（`v1w`）一律 `unsupported`，不得降级当 CAS。
- **`posixRename` 成功之后的一切失败都是 `outcome_unknown`**，绝不能报 `not_written`；`outcome_unknown` 不自动重试。
- **无法安全保留即拒绝**：符号链接、硬链接、非 UTF-8、超限、属性不可复原一律 `unsupported`，不静默降级。
- **密码与私钥口令**不得进入工具结果、会话文件、日志；只经遮罩输入、仅进程内缓存。
- **未知主机密钥在无 UI 时拒绝**；密钥变化阻止连接且不提供「仍然继续」；目标机与跳板机都要校验。
- **任务状态与可达性分离**：`unknown` 不改变任务状态、不产生完成事件。
- **通知只在会话空闲且开启自动唤醒时开新回合**；忙碌与无同项目会话都排队或不产事件，绝不丢弃。
- **`withLock` 不可重入**：`src/tasks/store.ts` 已持锁，锁内不得再调用需要取锁的 store 方法。
- **不改现有测试断言来迁就实现**；没有明确要求不新增测试。
