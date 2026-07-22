# pi-octssh

> **Pi 原生 SSH 扩展** — 远程执行、文件传输、异步任务、安全确认。

## Fork 来源

本项目基于 [`aliyahzombie/OctSSH`](https://github.com/aliyahzombie/OctSSH) 进行 Fork 和 Pi 原生扩展改造。

- **上游仓库**:`aliyahzombie/OctSSH`
- **上游 commit**:`2a2f255`(v0.1.7)
- **原作者**:`aliyahzombie`

### 改造说明

原项目是一个 MCP Server,通过 stdio / Streamable HTTP 向 MCP 客户端暴露 SSH 工具。本 Fork 的改造方向:

- **移除** MCP Server、MCP stdio、Streamable HTTP、`@modelcontextprotocol/sdk` 依赖;
- **移除** `confirm_code` 模型可提交的确认机制,改用 Pi `ctx.ui.confirm()` 人工确认;
- **新增** Pi Extension API 原生工具注册、TUI 安全确认、结果渲染、`/octssh` 管理面板;
- **新增** 完整的 `AbortSignal`、连接池生命周期、`session_shutdown` 清理;
- **修复** Windows / Linux / macOS 跨平台兼容问题;
- **保留** 上游 SSH、ProxyJump、SFTP、远程 `screen` 异步任务、安全策略、状态持久化等核心能力。

本项目**不是**上游作者的官方发行版本。

## 功能

### Pi 原生工具

| 工具 | 作用 |
|---|---|
| `octssh_hosts` | 列出 ssh_config 主机、查询主机扩展信息 |
| `octssh_exec` | 远程命令执行(同步 / 异步 / sudo) |
| `octssh_transfer` | 文件上传 / 下载(同步 / 异步) |
| `octssh_session` | 异步任务管理(查询 / 搜索日志 / 写 stdin / 取消) |

### 安全确认

高危操作(递归删除、文件覆盖)通过 Pi `ctx.ui.confirm()` 弹窗,由用户人工确认。模型无法自行提交确认码,无 UI 时默认拒绝。

### `/octssh` 命令

打开管理面板:主机列表、连接状态、远程任务、传输进度。

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

## 安装

```bash
pi install /path/to/pi-octssh
```

或加入 `~/.pi/agent/settings.json`:

```json
{
  "packages": ["git:github.com/wuyaos/pi-octssh"]
}
```

## 配置

读取标准 `~/.ssh/config`。状态保存在 `~/.octssh/`。

环境变量:

| 变量 | 默认 | 作用 |
|---|---|---|
| `OCTSSH_HOME` | `~/.octssh` | 状态目录 |
| `OCTSSH_SSH_CONFIG` | `~/.ssh/config` | ssh_config 路径 |
| `OCTSSH_ALLOW_SSH_G` | `false` | 是否用 `ssh -G` 解析连接参数 |

## 致谢

感谢 [`aliyahzombie`](https://github.com/aliyahzombie) 的原项目 OctSSH,本项目在其基础上进行 Pi 原生适配。
