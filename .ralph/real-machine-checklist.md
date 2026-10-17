# pi-octssh 真机验收清单（fixture 到手后按序执行）

本文件汇集**所有只有真环境能确认**的条目。离线已验的部分不在其中（见 `.ralph/octssh-v1.md` 的 Verification）。
前置：真 OpenSSH 服务端（ssh2 内置 Server 不足以承载 —— 它不支持 SFTP 文件操作、也不广播扩展）。

---

## 0. Fixture 准备（**需用户授权后才能执行**）

方案 ① 主用：WSL Debian 内 sshd，Windows 侧走回环（能提供 GNU `stat` / `posix-rename` 的真实 Linux 语义）

```bash
wsl -u root -- bash -lc 'apt-get update && apt-get install -y openssh-server'
wsl -u root -- bash -lc 'mkdir -p /etc/ssh-test && ssh-keygen -q -t ed25519 -N "" -f /etc/ssh-test/host_ed25519'
# 专用测试账户 + 专用高位端口（不碰 22，不改现有 sshd 服务）
wsl -u root -- bash -lc 'useradd -m -s /bin/bash octssh-test && echo "octssh-test:octssh-test-pw" | chpasswd'
wsl -u root -- bash -lc '/usr/sbin/sshd -p 2222 -h /etc/ssh-test/host_ed25519 -o UsePAM=no -o PasswordAuthentication=yes -o PubkeyAuthentication=yes -o PermitRootLogin=no'
```

方案 ② 兜底：Windows OpenSSH `sshd.exe` 以临时配置 + 高位端口启动（**启动服务需管理员**；`stat -c`/posix-rename 语义与 Linux 不同，只用于连通性）
```powershell
# 管理员终端
& "C:\Windows\System32\OpenSSH\sshd.exe" -f C:\tmp\sshd-test.conf
```

测试用 `~/.ssh/config` 条目（放在用户侧，不入库）：
```
Host octssh-fixture
  HostName 127.0.0.1
  Port 2222
  User octssh-test
```

**记录到时填**：host alias = ____________；端口 = ______；账号 = ____________。

---

## 1. 主机密钥与指纹（迭代 3 离线已验判定逻辑，未验真实握手）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 1.1 | `octssh_hosts({machine:"octssh-fixture"})` 首次连接 | 弹出指纹确认；显示的 `SHA256:...` 与 `ssh-keygen -lf` 逐字符一致 | |
| 1.2 | 确认后再次连接 | 不再弹窗 | |
| 1.3 | 改 `~/.ssh/config` 让 alias 指向另一台/另一端口 | **重新确认**（别名换指向不继承信任） | |
| 1.4 | 替换服务端 host key 后连接 | 阻止连接并提示 key 变化；**不提供「仍然继续」** | |
| 1.5 | 无 UI 模式（`pi -p` 或 rpc）连接未知主机 | 拒绝（`NO_UI`），不静默接受 | |
| 1.6 | 带 ProxyJump 的别名 | 目标机与跳板机**各自**校验一次 | |

对照命令：`ssh-keygen -lf <(ssh-keyscan -p 2222 127.0.0.1 2>/dev/null)`

## 2. 认证与凭据（迭代 4 离线已验语义，未验真实登录）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 2.1 | 仅密码账号连接 | 遮罩输入框出现，显示 `user@host:port`；输入正确密码后登录成功 | |
| 2.2 | 输入错误密码 | 明确报错；**最多 2 次**后停止，不再弹窗 | |
| 2.3 | 弹窗中取消（Esc） | 停止连接，不继续尝试其他认证方式 | |
| 2.4 | 登录后再执行一次命令 | 复用缓存，不重复弹窗 | |
| 2.5 | `/octssh credentials clear` 后再执行 | 重新弹窗 | |
| 2.6 | 检查 `~/.octssh/sessions/*.json`、日志、工具结果 | **不含密码明文**（`grep -ri <密码> ~/.octssh` 无命中） | |
| 2.7 | 加密私钥（`openssl genrsa -aes256` 生成），未给 passphrase | 弹出 passphrase 输入；输入后成功 | |
| 2.8 | 服务端只允许 keyboard-interactive | 明确报 `AUTH_UNSUPPORTED`，**不伪装成密码失败** | |
| 2.9 | 并行连接同一主机两次 | 只弹**一个**密码框（请求合并） | |
| 2.10 | 网络中断（关掉 `sshd`）后连接 | 归类为网络错误，**不是**密码错误 | |

## 3. SFTP 原语与 `stat` 模板（迭代 7 静态已证，**全部未验真机**）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 3.1 | `octssh_read` 一个普通 UTF-8 文件 | 返回 `v1i` 强 token | |
| 3.2 | 同上，但主机 `stat` 不支持所用模板（如 BusyBox） | 返回 `v1w` 弱 token + 警告；edit 用该 token 被拒 | |
| 3.3 | `octssh_edit` 正常改写 | `success`；内容正确；**mode 保留**；**mtime 更新**；owner 不变 | |
| 3.4 | 编辑期间在另一个终端改动同一文件 | `conflict`，且目标文件**未变** | |
| 3.5 | 编辑一个 root 所有、当前用户不可写的文件 | `unsupported(chown_not_restorable)` 或权限拒绝；**不得**只保 mode 静默通过 | |
| 3.6 | 编辑符号链接 | `unsupported(symlink)` | |
| 3.7 | 编辑硬链接文件的其中一个名字 | `unsupported(hard_linked)` | |
| 3.8 | 文件 > 2 MiB | `rejected/too_large` | |
| 3.9 | 编辑过程中 kill Pi（在 rename 前） | 目标文件**不出现半写**；残留 temp 可定位（同目录 `.octssh-*`） | |
| 3.10 | 服务端不支持 `posix-rename@openssh.com`（老 sshd/vendor 实现） | `unsupported(posix_rename_unsupported)`，目标未动 | |
| 3.11 | 同长 + mtime 还原的外部改写（`touch -r`） | **已知盲区**：指纹察觉不到，编辑可照常执行 —— 确认文档与用户提示确实写明了这一点 | |
| 3.12 | 中文/emoji/CRLF 文件编辑后 diff | 其余字节逐字节不变，无换行被隐式转换 | |

## 4. 项目权限在真实路径上生效（迭代 5/6 离线已验纯函数，未验端到端）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 4.1 | 选「此项目始终允许」编辑某文件，重启 Pi 后再编辑同一文件 | 不再询问 | |
| 4.2 | 选「此项目始终禁止」后同一操作 | 拒绝，且**不建立连接** | |
| 4.3 | `/octssh permissions` | 列出规则与命中范围；`remove <id>` 后规则消失 | |
| 4.4 | 同一命令换到另一台主机（或改 ssh_config 的 User） | 规则**不命中**，重新询问 | |
| 4.5 | 内建硬禁止命令（如 `iptables -F`）在「始终允许」规则存在时 | **仍然阻止**（allow 不得覆盖内建禁止） | |
| 4.6 | 上传 > 10 个冲突文件 | 确认弹窗**不提供**「始终允许」 | |
| 4.7 | 非 git 目录从**子目录**启动 Pi | **已知边缘**：projectId 与父目录不同，已批准规则不生效 —— 确认是否接受 | |

## 5. 异步任务与通知（迭代 10–13 离线/静态已验，未验真 Pi）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 5.1 | `octssh_exec({mode:"async"})` 起一个 10 秒任务，等它结束 | Pi 空闲时收到一次通知并**开启新回合**；含主机/任务 id/状态/退出码/耗时 | |
| 5.2 | 任务结束时 Pi 正在跑（忙碌） | **不打断**；空闲后补发（或进入待投递） | |
| 5.3 | `/octssh tasks wake off` 后重复 5.1 | **不开启新回合**；面板里仍有记录 | |
| 5.4 | `/octssh tasks` | 按需打开，默认当前项目；可切全部；能看详情 | |
| 5.5 | 面板里对运行中任务点「取消任务」 | 走 runtime 裁决；成功取消；**失败的任务不被误报为已取消** | |
| 5.6 | 任务运行中关掉 Pi，重新启动 | 恢复后重新探测；完成通知补报一次 | |
| 5.7 | 运行中任务断网（关 sshd） | 状态为 `unknown`，**不是 failed**；不产生完成通知 | |
| 5.8 | 同时完成两个任务 | 通知合并或分别可达，**不重复** | |
| 5.9 | 两个 Pi 进程看同一任务 | 只有一个投递（另一个 `duplicate`/`lease_held`） | |
| 5.10 | 异步传输任务运行中 kill Pi 再启动 | 归为 `interrupted`，**不自动续传** | |
| 5.11 | 检查 `/octssh tasks` 与通知正文 | **不含**完整命令与 stdout/stderr | |

## 6. 跨进程与并发（迭代 11 离线已验文件层，未验多 Pi）

| # | 动作 | 期望 | 结果 |
|---|---|---|---|
| 6.1 | 两个 Pi 进程并发写同一项目规则 | 无互相覆盖；锁按 pid 判活 | |
| 6.2 | 手工把 `~/.octssh/tasks/index.json` 写坏 | 一次提示；原文件被改名为 `*.corrupt-*`；面板不崩 | |

---

## 执行约定

- 表中每条都必须填「结果」，允许写 `失败`/`阻塞`/`不适用`，**不允许留空**。
- 未执行的条目在最终报告里标 **未验（blocked）**，不计入完成。
- 涉及远端写入的条目只在专用测试账户的临时目录上执行，不碰任何现有远端与生产路径。
- Windows 端 Word/面板类交互在真实 Pi TUI 内完成；RPC 模式覆盖 1.5、2.5 的无 UI 分支。
