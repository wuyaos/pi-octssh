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

## 安全确认

- 明显危险的命令会被安全策略直接禁止。
- 递归删除、覆盖远端文件等操作会在 Pi 界面弹出人工确认框。
- 模型不需要也无法提交任何确认凭据；危险操作只能由用户在 Pi 界面内批准。
- 用户拒绝、确认超时或当前模式没有确认界面时，操作必须停止。
- 确认只对同一次、参数完全一致的操作有效，不能复用。

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
- 不要频繁轮询；需要进度时按需调用 `octssh_session`。
