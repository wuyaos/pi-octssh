# Agent Note: 会话内指定主机免确认

Status: implemented

## Problem

逐条授权不适合操作者明确接管整台主机的连续运维，但永久放开整个项目或所有主机会扩大授权范围。

## Decision

用户通过 /octssh allow-all <machine> [on|off] 开关，开启需 TUI 确认。内存授权绑定宿主项目身份和完整 SSH 身份（别名、端点、用户、跳板）。仅在 Runtime 返回 needs_confirmation 时替代人工确认，仍使用原一次性 token 和重入校验；不修改 Runtime 的 deny、硬禁止、指纹、冲突、主机信任策略，也不落盘。显式 ask 在此模式下被会话批准覆盖，deny 不覆盖。

session_start/shutdown 清空授权；待确认弹窗携带代际检查，旧会话迟到的确认不能开启新会话授权。状态栏持续显示主机，off 立即撤销后续确认，不能撤回已经执行的操作。

## Alternatives considered

- 写入永久主机 allow：更易复用，但不符合当前项目、指定主机、本会话的范围。
- 在 Runtime 裁决中直接返回 allow：可能绕过拒绝分支。本实现只接管 needs_confirmation，保留原拒绝路径。

## Consequences

此模式包含删除、覆盖、sudo 等已被允许确认的行为；不代表取消硬禁止。依然可能因为冲突反复变化或不支持操作而失败。命令不暴露为模型工具，只有用户命令入口开启。免确认不保证无法识别的 shell 行为安全。

27 项相关测试及类型检查通过，包括实际注册命令/工具的开关流程、拒绝结果保持、状态栏、关闭与 session_start 清空，以及身份/项目隔离。测试 UI 为模拟对象，尚未完成真实 Pi 交互验收。

同时补齐审查发现的 busybox/toybox/watch/setsid 等包装命令分类，默认询问；已有精确批准及会话批准仍可授权它们。与 [命令风险](2026-10-20-command-risk-and-subcommand-grants.md)部分重叠，新增会话授权而不取代其规则。
