---
name: octssh
description: 使用 Pi 原生 OctSSH 工具操作 SSH 远程主机。适用于在 minipc、qnap、fnos、interserver、para-GPU-N40、para-GPU-N56、para-CPU-A6 等 ssh_config 主机上执行命令、部署、上传下载、查询或取消后台任务。触发词：SSH、服务器、远程执行、部署到、上传到服务器、从服务器下载、重启远程服务、查看远端日志。
---

# pi-octssh — SSH 远程操作

当任务目标是 `~/.ssh/config` 中的远程主机时，使用本 Skill 提供的 Pi 原生工具。操作本机时继续使用 Pi 内置的 `bash`、`read`、`write`、`edit`，不要用 OctSSH。

## 工具

| 工具 | 用途 |
|---|---|
| `octssh_hosts` | 列出 SSH 主机；读取或刷新单台主机信息 |
| `octssh_exec` | 同步执行命令，或在远端 `screen` 中启动异步任务；可选 passwordless sudo |
| `octssh_transfer` | 通过 SFTP 上传或下载文件/目录；支持同步和异步传输 |
| `octssh_session` | 查询异步任务、搜索日志、写入 stdin、取消任务 |
| `octssh_read` | 读取远端文本文件；返回**整份文件**的版本 token（可用于 edit）与行窗口 |
| `octssh_edit` | 对远端文本文件做逐字节精确替换；必须带上一步 read 返回的版本 token |

## 已知主机

minipc · qnap · fnos · interserver · para-GPU-N40 · para-GPU-N56 · para-CPU-A6

实际可用主机以 `octssh_hosts({})` 返回结果为准。

## 常用模式

### 列主机

```text
octssh_hosts({})
```

### 刷新主机信息

```text
octssh_hosts({ machine: "minipc", refresh: true })
```

### 同步执行

```text
octssh_exec({ machine: "minipc", command: "uname -a" })
```

### passwordless sudo

```text
octssh_exec({ machine: "qnap", command: "docker ps", sudo: true })
```

### 启动远端异步任务

```text
octssh_exec({ machine: "minipc", command: "./build.sh", mode: "async" })
```

保存返回的 `session_id`，然后查询：

```text
octssh_session({ action: "get", sessionId: "...", lines: 100 })
```

搜索日志：

```text
octssh_session({ action: "grep", sessionId: "...", pattern: "error|failed" })
```

取消任务：

```text
octssh_session({ action: "cancel", sessionId: "..." })
```

### 上传

```text
octssh_transfer({
  machine: "minipc",
  direction: "upload",
  localPath: "./app.tar.gz",
  remotePath: "/tmp/app.tar.gz"
})
```

### 下载

```text
octssh_transfer({
  machine: "minipc",
  direction: "download",
  localPath: "./logs",
  remotePath: "/var/log/myapp"
})
```

### 读取与修改远端文件

读远端文件优先用 `octssh_read`，改远端文本优先用 `octssh_edit`；不要用 `sed`、heredoc 拼接或「下载—改—上传」，那些方式容易在引号、编码、换行和并发覆盖上出错。

```text
octssh_read({ machine: "minipc", path: "/srv/app/config.yml" })

octssh_edit({
  machine: "minipc",
  path: "/srv/app/config.yml",
  expectedVersion: "<octssh_read 返回的 token>",
  oldText: "workers = 4",
  newText: "workers = 8",
})
```

约束（违反时工具会拒绝，不要试图绕过）：

- `expectedVersion` **必填**，必须是刚读到的 token；弱 token（`v1w`，主机 `stat` 模板不可用时产生）**不能**用于编辑。
- 即使只读了一部分行，token 仍覆盖**整份文件**；`offset` / `limit` 只影响返回内容。
- `oldText` 必须在文件中**恰好出现一次**；0 次或多次都拒绝。不做前缀、正则或模糊匹配。
- 首版只支持 UTF-8 普通文本且不超过 2 MiB；符号链接、硬链接、非 UTF-8、含 NUL 一律拒绝。
- 返回 `conflict` = 文件已变，**重新读一次**再决定；返回 `outcome_unknown` = 写入结果未知，**不要重试**，先用 `octssh_read` 核对内容。
- 需要新建文件、批量改多个文件或必须保留 ACL/扩展属性时，改用其它方式（例如上传脚本后执行）。
- 版本 token 由 size/mtime/mode/inode 等元数据构成，**不是内容哈希**；同长度且 mtime 被还原的外部改写察觉不到。

## 安全确认

- 明显危险的命令会被安全策略直接禁止，**内建禁止无法被「始终允许」覆盖**。
- 递归删除、覆盖远端文件、远端编辑等操作会在 Pi 界面弹出人工确认框，可选：仅本次允许 / 此项目始终允许 / 此项目始终禁止 / 本次拒绝。
- 「此项目始终允许／禁止」按「项目 + 主机 + 用户 + 操作 + 路径或完整命令」精确匹配并跨会话生效；命令按完整原串 + 远端 cwd + sudo 条件匹配，不做前缀授权。用 `/octssh permissions` 查看与撤销。
- 规则按**操作族**匹配：一条 `exec` 规则同时约束 `exec-async`（同理 `upload`/`upload-async`、`download`/`download-async`），换个工具名不能绕开。
- 命令规则匹配的是**本次调用的完整原串**：同一命令换个写法（尾随斜杠、引号、空格）不会命中。它是精确匹配，不是通配；需要更宽的拦截请用内建危险模式或远端权限。
- 模型不需要也无法提交任何确认凭据，也无法修改权限规则；危险操作只能由用户在 Pi 界面内批准。
- 用户拒绝、确认超时或当前模式没有确认界面时，操作必须停止；已有规则仍然生效。
- 确认只对同一次、参数完全一致的操作有效，不能复用。
- 首次连接某主机会要求人工确认主机密钥指纹；密钥变化时连接被阻止，**不要**试图删除信任记录来绕过。
- 连接需要密码或私钥口令时，会在遮罩输入框中向你索取；密码不进入模型上下文、不落盘。取消输入即停止连接。
- **项目权限不是沙箱**：文件规则只约束插件的文件操作，不构成任意 shell 的文件访问隔离。允许执行某条命令，即代表信任该命令及其引用的脚本。

## 异步任务生命周期

- `octssh_exec` 的异步模式使用远端 `screen`，任务在远端持续运行。
- Pi 重启或 `/reload` 不会杀死已经成功启动的远端任务；之后可继续用 `octssh_session` 查询。
- 异步上传和下载运行在 Pi 进程内，Pi 退出或 reload 时会中断；它们不等同于远端 `screen`。
- 使用 `octssh_session({ action: "cancel", ... })` 明确终止任务，不要把停止本地轮询当作远端任务已经停止。

## 平台支持

### Pi 客户端

Windows、Linux、macOS 均支持。连接信息默认读取本机 OpenSSH 配置。

### 远端服务器

- Linux、macOS、FreeBSD 等 POSIX 远端：同步执行、SFTP、sudo、`screen` 异步任务。
- macOS/FreeBSD 使用异步模式前需安装 `screen`。
- Windows OpenSSH 远端：仅支持同步执行和 SFTP；不支持 POSIX `sudo` 或 `screen` 异步任务。

## 使用边界

- 本地操作使用 Pi 内置工具，不使用 OctSSH。
- 普通短命令优先同步执行；编译、部署等长任务使用 `mode: "async"`。
- 多步骤脚本尽量上传脚本后执行，避免把复杂多行逻辑塞进单次 shell 参数。
- 下载不会覆盖本地已有文件；出现冲突时选择新的 `localPath`。
- 不要频繁轮询；需要进度时按需调用 `octssh_session`，也可以用 `/octssh tasks` 面板查看。
- 任务完成通知默认只在会话空闲时开启新回合，不会打断正在进行的对话；`/octssh tasks wake off` 可关闭自动唤醒（面板记录仍然保留）。
- 任务状态为 `unknown` 只表示当前观测不到（例如网络不通），**不是失败**，不要据此判定任务已终止或重跑。
- 取消请求发出后任务进入 `cancelling`，只有确认停止才算 `cancelled`；与自然完成竞争时以实际结果为准。
- 进程内异步传输不承诺在 Pi 退出后继续，重启后会被标为 `interrupted`，不会自动续传。
- 目录里提到的所有远端操作都只在用户已授权的主机上执行；不确定时先用 `octssh_hosts({})` 确认主机与连接身份。
