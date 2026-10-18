# Agent Note: 异步任务后端抽象（screen 必装要求 → screen/nohup 双后端）

Status: accepted

## Problem

`execAsync` 此前**强制要求远端装有 `screen`**（无 screen 直接报 `Remote prerequisite missing`）。fnos 等精简系统没有 screen，异步任务整类不可用。screen 不是技术硬依赖——wrapper 已经用文件（meta.json/cmd.pid/FIFO/日志）自记录全部状态，screen 唯一的作用是「断开 SSH 后保活 wrapper」。nohup + 已有文件协议即可等价满足。

## Decision

**双后端，启动时探测，自动选择：**

1. `command -v screen` 成功 → screen 后端（现状不变）。
2. 失败 → nohup 后端：`nohup sh "$run/wrapper.sh" "$command" >/dev/null 2>&1 &` 保活。wrapper 的状态机（stdout/stderr/meta.json/cmd.pid/stdin FIFO）**原样复用**，getSession/grepSession/writeStdin 零改动。
3. 差异点收敛在三处，全部按 `rec.backend` 分支：
   - cancel：screen 后端才跑 `screen -X quit`；nohup 后端只 `kill cmdPid`（wrapper 随之正常写 done meta）。
   - 清理 run 目录：同上条件。
   - `getSession` 返回：nohup 会话 `screenName: null` + `backend: "nohup"`。
4. schema：`screenName` 改 optional，新增 `backend: "screen"|"nohup"` 可选字段；**缺失即视为 "screen"**（旧记录零迁移）。

## Alternatives considered

1. **tmux 替代**：同样是「要求装包」，只是换个名字，不解决问题。
2. **systemd-run**：依赖 systemd 与特权，NAS 不一定有，复杂度更高。
3. **把 nohup 设为唯一后端**：会丢掉 screen 已验证的取消与保活语义，且老主机行为回退——不做。
4. **用户配置强制选后端**：探测已足够可靠（`command -v`），多一个配置项多一种错法——不做。

## 已知代价与边界

- nohup 后端**没有 screen 的整组会话管理**：`screen -ls` 式诊断不可用；启动失败诊断只看 run 目录文件（wrapper 已把诊断写在那里，够用）。
- cmd pid 复用风险两后端等同（screen 方案同样只记 pid），靠 run 目录归属判断，不在本改动扩大。
- writeStdin 的 FIFO 在 nohup 下照常工作（无 tty 需求）。
- sudo 语义不变（wrapper 内 `sudo -n`）。

## Acceptance

- fnos（无 screen）真机：启动 → running → cancel → 终态 cancelled；自然结束 → done + 正确退出码；重启 Pi 后 getSession 仍可探活。
- 有 screen 的主机行为与旧版完全一致（回归）。
- 旧 session 记录（无 backend 字段）可读、按 screen 处理。
