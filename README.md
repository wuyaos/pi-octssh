# pi-octssh

> **Pi 原生 SSH 扩展** — 远程执行、文件传输、异步任务、安全确认。

把 SSH 远程操作能力直接注入 [Pi](https://pi.dev) coding agent。模型通过 4 个原生工具操作你 `~/.ssh/config` 里的主机,本机操作仍用 Pi 内置 `bash`,两者各司其职。

## Fork 来源

本项目基于 [`aliyahzombie/OctSSH`](https://github.com/aliyahzombie/OctSSH) 进行 Fork 和 Pi 原生扩展改造。

- **上游仓库**:`aliyahzombie/OctSSH`
- **上游 commit**:`2a2f255`(v0.1.7)
- **原作者**:`aliyahzombie`

原项目是一个 MCP Server,通过 stdio / Streamable HTTP 向 MCP 客户端暴露 SSH 工具。本 Fork 移除 MCP 层,改为 Pi Extension API 原生实现,并修复了 Windows / Linux / macOS 跨平台兼容问题,保留上游 SSH、ProxyJump、SFTP、远程 `screen` 异步任务、安全策略、状态持久化等核心能力。

本项目**不是**上游作者的官方发行版本。

## 安装

```bash
pi install git:github.com/wuyaos/pi-octssh
```

或手动加入 `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/wuyaos/pi-octssh"]
}
```

安装后重启 Pi 或执行 `/reload` 即可加载。

## Pi 原生工具

| 工具 | 作用 |
|---|---|
| `octssh_hosts` | 列出 ssh_config 主机、查询主机扩展信息 |
| `octssh_exec` | 远程命令执行(同步 / 异步 / sudo) |
| `octssh_transfer` | 文件上传 / 下载(同步 / 异步) |
| `octssh_session` | 异步任务管理(查询 / 搜索日志 / 写 stdin / 取消) |

### 使用示例

列出主机:

```text
octssh_hosts({})
octssh_hosts({ machine: "minipc", refresh: true })
```

同步执行命令:

```text
octssh_exec({ machine: "minipc", command: "uname -a && df -h" })
octssh_exec({ machine: "minipc", command: "systemctl restart nginx", sudo: true })
```

后台异步任务(长任务在远端 `screen` 中运行,Pi 重启后仍可查询):

```text
octssh_exec({ machine: "para-GPU-N40", command: "python train.py", mode: "async" })
octssh_session({ action: "get", sessionId: "s-xxxx", lines: 100 })
octssh_session({ action: "grep", sessionId: "s-xxxx", pattern: "Error" })
octssh_session({ action: "cancel", sessionId: "s-xxxx" })
```

文件传输:

```text
octssh_transfer({ machine: "minipc", direction: "upload", localPath: "./app.tar.gz", remotePath: "~/deploy/" })
octssh_transfer({ machine: "minipc", direction: "download", remotePath: "~/logs/app.log", localPath: "./app.log" })
```

## 安全确认

高危操作(递归删除、文件覆盖)通过 Pi `ctx.ui.confirm()` 弹窗,由用户人工确认:

- 模型**无法**自行提交确认码(旧版 MCP 的 `confirm_code` 机制已移除);
- 无 UI 时(如 `-p` 程序化模式)默认拒绝,fail closed;
- 下载不会覆盖本地已存在文件。

## `/octssh` 命令

在 Pi 中输入 `/octssh` 查看 runtime 状态:运行时长、活跃异步任务数。

## 平台支持

### 客户端(运行 Pi 的机器)

| 平台 | 支持 |
|---|---|
| Linux | ✅ |
| macOS | ✅ |
| Windows | ✅(pwsh / powershell / cmd / Git Bash) |

### 远端服务器

| 平台 | 同步 exec / SFTP | 异步 screen / sudo |
|---|---|---|
| Linux | ✅ | ✅ |
| macOS | ✅ | ✅(需安装 screen) |
| FreeBSD | ✅ | ⚠️(需安装 screen) |
| Windows OpenSSH | ✅ | ❌(不支持 screen / sudo) |

## 配置

读取标准 `~/.ssh/config`。状态保存在 `~/.octssh/`。

环境变量:

| 变量 | 默认 | 作用 |
|---|---|---|
| `OCTSSH_HOME` | `~/.octssh` | 状态目录 |
| `OCTSSH_SSH_CONFIG` | `~/.ssh/config` | ssh_config 路径 |
| `OCTSSH_ALLOW_SSH_G` | `false` | 是否用 `ssh -G` 解析连接参数(需系统 ssh 在 PATH) |

## 设计要点

- **无独立进程**:扩展与 Pi 会话同进程,SSH 连接按需建立、空闲回收,无本地守护服务。
- **生命周期对齐**:`session_start` 创建 runtime,`session_shutdown` 幂等关闭连接池与定时器;已启动的远端 `screen` 任务在 Pi 退出后继续运行,重连后可查询。
- **取消信号**:`exec` / `upload` / `download` 全链路支持 `AbortSignal`,Pi 中断工具时关闭对应 SSH channel 而非整条连接。

## 致谢

感谢 [`aliyahzombie`](https://github.com/aliyahzombie) 的原项目 OctSSH,本项目在其基础上进行 Pi 原生适配。
