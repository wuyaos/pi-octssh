---
name: octssh
description: 用 Pi 原生 OctSSH 工具操作 SSH 远端主机：执行命令、上传下载、后台异步任务、远端文本读取与精确编辑、部署与排查。触发词：SSH、服务器、远程执行、部署到、上传到服务器、从服务器下载、重启远程服务、查看远端日志、远端改配置。
---

# pi-octssh — SSH 远程操作

当任务目标是 `~/.ssh/config` 中的远程主机时，使用本 Skill 提供的 Pi 原生工具。操作本机时继续使用 Pi 内置的 `bash`、`read`、`write`、`edit`，不要用 OctSSH。

## 工具

| 工具 | 用途 |
|---|---|
| `octssh_hosts` | 列出 SSH 主机；读取或刷新单台主机信息 |
| `octssh_exec` | 同步执行命令，或在远端后台启动异步任务（有 `screen` 用 `screen`，否则自动用 `nohup`）；可选 passwordless sudo |
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

同步等待默认 60 秒，可用 `timeoutSeconds` 设置 1–3600 秒；该值不限制后台任务运行时长。超时或取消只表示停止本地等待，远端可能仍在执行，不自动重跑。

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

- 简单查询命令和 `octssh_read` 无匹配规则时默认放行；项目显式 ask/deny 仍生效。复杂 shell、包装命令、sudo、删除、服务/容器修改等会请求确认。curl 的输出、上传、修改请求或未知参数，以及 wget 下载均要求确认。
- 确认选项为「允许一次 / 永久允许 / 永久禁止 / 拒绝」。永久规则绑定当前项目、真实 SSH 身份和操作；用 `/octssh permissions` 查看与撤销。
- 命令规则默认精确匹配完整原文及 sudo/cwd 条件。支持的 Docker/systemctl 简单命令可显式选择子命令范围，例如 `docker restart *`、`docker compose restart *`；不等于任意字符串前缀，不匹配组合 shell、变量替换或目标切换参数。
- 同步与异步按操作族共用规则。项目 deny 和内建硬禁止始终优先；永久允许不覆盖显式 ask。
- 用户可用 `/octssh allow-all <主机> [on|off]` 开启或关闭本项目、本主机、本会话免确认。它可以代替 ask，但不能绕过 deny、硬禁止、主机密钥、文件版本或能力校验；结束会话或重载后失效。
- 模型不能代替用户开启免确认或写入授权规则。用户拒绝或取消时停止；仍需确认而无可用界面时拒绝执行。
- 上传确认合并项目要求与覆盖清单；永久范围仅限实际目标单文件，目录上传不提供永久选项。下载不会覆盖本地已有文件；传输无规则时仍可能询问。
- 首次连接需确认主机密钥；密钥变化必须停止，不得删除信任来绕过。密码仅经遮罩输入，不进入模型上下文或落盘。
- 权限不是 shell 沙箱；不能识别任意脚本内部行为。已有授权并不证明命令安全。


## 人工入口（由用户执行，模型不能代替批准）

| 命令 | 作用 |
|---|---|
| `/octssh` | 状态：运行时长、活跃任务数、连接池占用、凭据缓存条数、自动唤醒开关 |
| `/octssh trust [forget <host:port>]` | 列出/移除主机密钥信任；密钥合法轮换后唯一的出路 |
| `/octssh permissions [remove <id>]` | 查看/移除当前项目的持久规则 |
| `/octssh allow-all <主机> [on\|off]` | 本项目、本主机、本会话免确认；结束会话或重载后失效 |
| `/octssh tasks [wake on\|off]` | 打开任务面板；控制任务完成是否自动开新回合 |
| `/octssh credentials clear` | 清除进程内的密码与私钥口令缓存 |

模型**没有**修改权限规则、清除禁止项或批准危险操作的工具；这些只能由用户在界面内完成。
## 异步任务生命周期

- `octssh_exec` 的异步模式在远端后台运行：主机装了 `screen` 就用 `screen`，否则自动用 `nohup`（无需用户装包）。返回值里的 `backend` 会写明用的哪一种。
- 两种后端都靠远端 `~/.octssh/runs/<session_id>/` 下的文件记录状态（`meta.json` 退出码、`stdout.log`/`stderr.log` 输出、`stdin.fifo` 输入管道），因此输出**不在本地**：要读日志用 `octssh_session`，或用 `octssh_exec` 直接读那些文件。
- Pi 重启或 `/reload` 不会杀死已经成功启动的远端任务；之后可继续用 `octssh_session` 查询。
- 异步上传和下载运行在 Pi 进程内，Pi 退出或 reload 时会中断；它们不等同于远端后台任务（本地只留一份 `localLogPath` 日志）。
- 使用 `octssh_session({ action: "cancel", ... })` 明确终止任务，不要把停止本地轮询当作远端任务已经停止。

## 平台支持

### Pi 客户端

Windows、Linux、macOS 均支持。连接信息默认读取本机 OpenSSH 配置。

### 远端服务器

- Linux、macOS、FreeBSD 等 POSIX 远端：同步执行、SFTP、sudo、后台异步任务（`screen` 或 `nohup`，无需预装）。
- 远端需要 `mkfifo`（几乎所有 POSIX 系统都有）；缺失时异步任务会明确报错，不会假装启动成功。
- Windows OpenSSH 远端：仅支持同步执行和 SFTP；不支持 POSIX `sudo`，也没有 `screen`/`nohup`，因此不能用异步任务。

## 使用边界

- 本地操作使用 Pi 内置工具，不使用 OctSSH。
- 普通短命令优先同步执行；编译、部署等长任务使用 `mode: "async"`。
- 多步骤脚本尽量上传脚本后执行，避免把复杂多行逻辑塞进单次 shell 参数。
- 下载不会覆盖本地已有文件；出现冲突时选择新的 `localPath`。
- 不要频繁轮询；需要进度时按需调用 `octssh_session`，也可以用 `/octssh tasks` 面板查看。
- 任务完成通知默认只在会话空闲时开启新回合，不会打断正在进行的对话；`/octssh tasks wake off` 可关闭自动唤醒（面板记录仍然保留）。
- 任务状态为 `unknown` 只表示当前观测不到（例如网络不通），**不是失败**，不要据此判定任务已终止或重跑。
- 取消请求不证明进程已停止：当前控制路径可能先返回 `cancelled`，需重新核对远端进程；不要把该返回值当作所有子进程已经退出。
- 进程内异步传输不承诺在 Pi 退出后继续，重启后会被标为 `interrupted`，不会自动续传。
- 目录里提到的所有远端操作都只在用户已授权的主机上执行；不确定时先用 `octssh_hosts({})` 确认主机与连接身份。
