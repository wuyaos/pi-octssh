# pi-octssh

> **Pi 原生 SSH 扩展** — 远程执行、文件传输、异步任务、安全确认。

把 SSH 远程操作能力直接注入 [Pi](https://pi.dev) coding agent。模型通过 6 个原生工具操作 SSH 主机，本机操作仍使用 Pi 内置工具。

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
| `octssh_read` | 读取远端文本文件(返回整份文件的版本 token 与行窗口) |
| `octssh_edit` | 远端文本文件的逐字节精确替换(必须带版本 token) |

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

同步命令可用 `timeoutSeconds` 调整等待上限（1–3600 秒，默认 60）。超时或取消后远端可能仍在运行，请先核对，勿重复执行。

后台异步任务（有 screen 用 screen，否则使用 nohup；Pi 重启后仍可查询）：

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

修改远端文件(先读后编辑,版本 token 必填):

```text
octssh_read({ machine: "minipc", path: "/srv/app/main.py" })
octssh_edit({
  machine: "minipc",
  path: "/srv/app/main.py",
  expectedVersion: "v1i|...",   // 上一步 read 返回的 token
  oldText: "old line",
  newText: "new line",
})
```

## 安全确认

查询命令（如 `uname`、`docker ps`、`docker logs`、`systemctl status` 及明确的防火墙查询）默认放行。危险操作（递归删除、覆盖、编辑、sudo、服务/容器/软件修改等）会弹窗确认。

确认选项：

- **允许一次 / 拒绝**：只影响当前操作。
- **永久允许 / 永久禁止**：写入当前项目的持久规则，可在 `/octssh permissions` 查看和撤销。
- 支持的简单命令可在选择永久允许后改为子命令范围，例如 `docker restart *`；不支持任意 `docker *`，也不匹配管道、串联、变量替换或目标切换参数。

会话级免确认：

```text
/octssh allow-all <主机>
/octssh allow-all <主机> off
```

它只绑定当前项目、指定 SSH 真实身份和当前 Pi 会话，结束会话或 `/reload` 后失效。它只免除人工确认，仍保留项目 `deny`、内建硬禁止、主机密钥、文件版本、冲突和能力校验。

约束：

- 模型不能提交确认或修改持久权限规则。
- 内建硬禁止无法被永久规则或会话免确认覆盖。
- 包装命令（如 `bash`、`env`、`nohup`、`busybox`）和未知的 `curl/wget` 参数默认要求确认。
- 项目权限不是 shell 沙箱；允许命令仍意味着信任它及其引用的脚本。
- 原始请求的项目 deny 在建连前判定；上传目录内各文件的规则在规划后检查。目前传输无规则时仍可能询问，目录上传不提供永久授权，下载不覆盖本地已有文件。
- 普通模式尊重显式 ask；需要确认而无交互界面时拒绝。会话免确认可代替 ask，但不能绕过 deny。
- 普通同步命令默认最多等待 60 秒；长任务从首次调用开始使用 `mode: "async"`，超时不自动重试。

## `/octssh` 命令

在 Pi 中输入 `/octssh` 查看 runtime 状态:运行时长、活跃异步任务数。

子命令:

| 命令 | 作用 |
|---|---|
| `/octssh trust [forget <host:port>]` | 查看或删除已信任的主机密钥 |
| `/octssh permissions [remove <id>]` | 查看或删除当前项目的持久权限规则 |
| `/octssh allow-all <主机> [on\|off]` | 当前项目、指定主机、本会话免确认；开启需人工确认 |
| `/octssh credentials clear` | 清除进程内缓存的密码与私钥口令 |
| `/octssh tasks [wake on\|off]` | 打开任务面板;`wake off` 关闭自动唤醒(仍保留面板记录) |

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
| macOS | ✅ | ✅（screen 或 nohup） |
| FreeBSD | ✅ | ✅（screen 或 nohup） |
| Windows OpenSSH | ✅ | ❌(不支持 screen / sudo) |

## 配置

读取标准 `~/.ssh/config`。状态保存在 `~/.octssh/`。

环境变量:

| 变量 | 默认 | 作用 |
|---|---|---|
| `OCTSSH_HOME` | `~/.octssh` | 状态目录 |
| `OCTSSH_SSH_CONFIG` | `~/.ssh/config` | ssh_config 路径 |
| `OCTSSH_ALLOW_SSH_G` | `false` | 是否用 `ssh -G` 解析连接参数(需系统 ssh 在 PATH) |

状态目录布局:

```text
~/.octssh/
  known-hosts.json        已信任的主机密钥(独立于系统 ~/.ssh/known_hosts)
  policy/projects/*.json  按项目保存的允许/禁止规则
  tasks/                  任务索引、待投递队列、已投递记录、租约
```

`config.json` 的任务通知设置(`taskNotify`):

| 键 | 默认 | 作用 |
|---|---|---|
| `autoWake` | `true` | 任务完成且会话空闲时是否自动开启新回合 |
| `sweepIntervalSeconds` | `120` | 任务状态扫描周期(秒) |
| `deliveredRetentionDays` | `30` | 已投递通知记录的保留天数 |
| `deliveredMaxEntries` | `5000` | 已投递通知记录的最大条数 |

## 限制与保证边界

以下边界是刻意保留的,不是待修的缺陷:

- **版本 token 不是内容哈希**。它由 size、mtime、mode、uid/gid 以及远端 `stat` 提供的 inode 与链接数构成。若外部改写**保持长度与 mtime 不变**(例如同长度改写后 `touch -r` 还原时间),校验察觉不到,编辑仍会执行。它用于发现常见的并发改动,不声称对外部写者的原子比较交换(CAS)。
- **最后一次核验到 `posix-rename` 之间存在 TOCTOU 窗口**,窗口内被外部改写的内容会被本次替换覆盖。
- **内容只走 SFTP**,不把文件内容拼进命令行。写入使用同目录独占临时文件 + 原子替换,因此正常失败不会留下半个文件;服务端不支持原子改名时编辑**明确失败**,不退回截断重写。
- **无法安全保留即拒绝**:owner 无法复原(如普通用户编辑 root 文件)、目标为符号链接、硬链接(`nlink > 1`)、非 UTF-8、含 NUL、超过 2 MiB 都明确拒绝,不静默降级;ACL 与扩展属性不在保证范围内。
- **密码与私钥口令只经人工遮罩输入**,不进模型上下文、不写盘、不进日志;仅进程内缓存,可用 `/octssh credentials clear` 清除。这不等于物理内存擦除的保证。首版不支持 sudo 密码、验证码与多轮 keyboard-interactive 认证。
- **异步任务分两类**:远端 `screen` 任务在 Pi 退出后继续运行,重启后重新探测;进程内异步传输不承诺继续,重启后归为 `interrupted`,**不自动续传**。
- **观测不到不等于失败**:网络不通时任务只更新可达性为 `unknown`,不产生完成通知,也不标记失败。
- **通知不承诺严格 exactly-once**:正常路径按稳定事件 ID 去重;崩溃恢复窗口内可能重复一次,重复项可用同一 ID 识别。
- **取消请求不证明进程已停止**：当前控制路径可能先返回 `cancelled`，不能据此证明所有远端子进程已终止；需要重新核对远端状态。
- **跳过确认不等于跳过校验**:「始终允许」只免除人工确认,主机密钥校验、文件版本校验与能力限制仍然生效。
- **精确规则与子命令规则分开**：旧的精确规则不会自动扩展；子命令规则必须由用户显式选择。新规则含 `match` 字段，旧版读取器会拒绝；降级前撤销新规则。
- **`outcome_unknown` 可能留下同目录临时文件**(`.octssh-*`):改名可能已生效,因此既不重试也不保证清理;请自行用 `octssh_read` 核对内容,必要时手动清理残留。
- **`no_change` 不做远端确认**:当 `oldText === newText` 时工具在建连读文件之前就返回「无变更」,它不代表远端文件就是你以为的样子。
- **密钥登录是纯配置行为**:私钥只从 `~/.ssh/config` 的 `IdentityFile` 读取,**一台主机只用其中第一把存在的私钥**;插件不弹密钥选择器,也不改配置。多把密钥时,请把该主机要用的那把写在前面的 `IdentityFile` 行。
- **`~` 只展开 `~` 与 `~/...`**:`~otheruser/key` 这类写法会被当作「本地家目录下的 otheruser/key」,静默找不到密钥。请用 `~` 开头或绝对路径。
- **不补默认密钥**:没有写 `IdentityFile` 的主机不会去试 `~/.ssh/id_ed25519`、`id_ecdsa`、`id_rsa`。想用密钥就在该 `Host` 下手写一行,否则走 agent 或密码认证。
- **`IdentitiesOnly` 未解析**:该指令目前被忽略。由于每台主机只加载第一把显式指定的私钥,实际效果与 `IdentitiesOnly yes` 一致。
- **ssh-agent 只在能确定地址时启用**:Unix 用 `SSH_AUTH_SOCK`;Windows 用 OpenSSH agent 的命名管道 `\\.\pipe\openssh-ssh-agent`(存在才用)。`SSH_AGENT_PID` 与 Git Bash 的虚拟 socket 路径不会被使用。

## 设计要点

- **无独立进程**:扩展与 Pi 会话同进程,SSH 连接按需建立、空闲回收,无本地守护服务。
- **生命周期对齐**:`session_start` 创建 runtime,`session_shutdown` 幂等关闭连接池与定时器;已启动的远端 `screen` 任务在 Pi 退出后继续运行,重连后可查询。
- **取消信号**:`exec` / `upload` / `download` 全链路支持 `AbortSignal`,Pi 中断工具时关闭对应 SSH channel 而非整条连接。

## 致谢

感谢 [`aliyahzombie`](https://github.com/aliyahzombie) 的原项目 OctSSH,本项目在其基础上进行 Pi 原生适配。
