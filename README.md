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

高危操作(递归删除、文件覆盖、远端编辑)通过 Pi 弹窗由用户人工确认,可选四种处理:

- **仅本次允许 / 本次拒绝**:只影响当前这一次操作。
- **此项目始终允许 / 此项目始终禁止**:写入用户侧规则文件,按「项目 + 主机 + 用户 + 操作 + 路径或完整命令」精确匹配,跨会话生效,用 `/octssh permissions` 查看与撤销。

约束:

- 模型**无法**自行提交确认码或修改权限规则(旧版 MCP 的 `confirm_code` 机制已移除);
- 命中项目禁止即拒绝,且**不建立连接**;命令规则按**完整原串 + 远端 cwd + sudo 条件**匹配,不做前缀授权;
- 命令规则的匹配对象是**本次调用的完整原串**（外加远端 cwd 与 sudo 条件）：同一命令换个写法——尾随 `/`、加引号、插入空格——**不会**命中该规则。项目规则是精确匹配，不是模式或通配；不要用它来「挡住某类命令」。
- 规则按**操作族**匹配:一条 `exec` 规则同时约束 `exec-async`(同理 `upload`/`upload-async`、`download`/`download-async`),避免换个工具名就绕开禁止;
- 规则写 `ask` 时,即使该操作本来不需要确认也会请求确认;作用在 `read`/`edit`/`exec`/`exec-async`/`upload`/`upload-async`/`download`/`download-async`/`session-cancel`/`session-write-stdin` 上。`session-get`/`session-grep` 是纯读取、不改变远端状态,不插入确认步骤,这两项的 `ask` 只作记录用途;
- 内建硬禁止(如 `iptables -F`)无法被「始终允许」覆盖;
- 无 UI 时(如 `-p` 程序化模式)默认拒绝,fail closed;已有规则仍然生效;
- 下载不会覆盖本地已存在文件;上传冲突超过 10 个文件时不提供「始终允许」(范围无法完整预览就不授权);
- **项目权限不是沙箱**:文件规则只约束插件的文件操作,不构成任意 shell 的文件访问隔离。允许执行命令即代表信任该命令及其引用的脚本。

## `/octssh` 命令

在 Pi 中输入 `/octssh` 查看 runtime 状态:运行时长、活跃异步任务数。

子命令:

| 命令 | 作用 |
|---|---|
| `/octssh trust [forget <host:port>]` | 查看或删除已信任的主机密钥 |
| `/octssh permissions [remove <id>]` | 查看或删除当前项目的持久权限规则 |
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
- **取消不等于已取消**:发出取消请求后进入 `cancelling`,只有确认停止才算 `cancelled`;与自然完成竞争时以实际结果为准。
- **跳过确认不等于跳过校验**:「始终允许」只免除人工确认,主机密钥校验、文件版本校验与能力限制仍然生效。
- **命令规则是精确匹配**:`rm -rf /data` 的禁止规则挡不住 `rm -rf /data/`、`rm -rf "/data"` 或尾随空格。它约束的是「这一次调用」,不是那类操作。
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
