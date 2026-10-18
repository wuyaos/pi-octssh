# Agent Note: 密钥登录的范围界定与 ssh-agent 地址修正

Status: accepted

## Problem

插件通过 `~/.ssh/config` 的 `IdentityFile` 支持密钥登录，但实现只覆盖了 OpenSSH 语义的一小部分，且有一处会把可用配置弄坏：

1. `loadFirstPrivateKey` 只取**第一把存在的**私钥，其余在配置里写了也从不尝试（已被静默忽略，用户无从得知）。
2. 从不尝试 OpenSSH 的默认密钥位置（`~/.ssh/id_ed25519` 等），因此「没写 `IdentityFile`、但 key 放在默认位置」的主机走不到公钥认证。
3. `IdentitiesOnly` 完全没有解析。
4. `agent` 的取值是 `SSH_AUTH_SOCK || (win32 ? SSH_AGENT_PID : undefined)`，而 ssh2 的 `agent` 要的是**地址**（Unix socket 路径 / Windows 命名管道 / 字面量 `"pageant"`），`SSH_AGENT_PID` 是数字 PID。该变量一旦存在，agent 认证必然失败，可能连带把原本可用的密钥登录弄坏。

## Decision

**密钥登录保持「纯配置」语义：插件只读配置，不弹选择器、不改配置、不做连接测试。**

- 多把 `IdentityFile`：**只用第一把存在的**，行为写入 README「限制与保证边界」。需要换 key 就在配置里调整顺序或删掉不用的那行。不做交互式选择器——它需要新增「这台主机选过哪把 key」的持久化、与遮罩口令框协调、无 UI 时的确定性退化，而当前所有主机都是单 key 配置，属于零收益的复杂度。
- **不补默认密钥**：理由是收益窄而代价真实——默认位置要试 3 把，每把都是一次认证尝试（部分服务器失败多次会临时封源 IP）；加密的默认 key 会在用户没预期的机器上弹口令框；失败信息会从「没有可用凭据」变成「试过 3 把都不行」，更难定位。替代做法是把错误信息写清楚（让用户知道该加 `IdentityFile`）。若将来确需，做成**默认关闭的配置开关**，而不是改默认行为。
- **`IdentitiesOnly` 保持忽略**，但写入文档。当前无害：每台主机只加载第一把显式私钥，效果与 `IdentitiesOnly yes` 相同。
- **修正 agent 地址解析**：Windows 只用 OpenSSH agent 的命名管道 `\\.\pipe\openssh-ssh-agent`（存在才用）；其它平台用 `SSH_AUTH_SOCK`；都不满足则视为无 agent。**不做 Pageant 自动探测**：探测不到就传 `"pageant"` 会让未安装 Pageant 的机器认证失败。需要 Pageant 时应显式配置（后续若要，加 `OCTSSH_SSH_AGENT` 之类显式开关）。
- **连接测试是独立功能**，不并入本次范围（用户明确区分）。

## Alternatives considered

1. **多 key 自动逐个尝试**：更贴近 OpenSSH 行为，但会成倍增加认证尝试（封禁风险），且在无 UI 时无法让用户干预；用户已选择「手动配置」，不做。
2. **交互式密钥选择器**：见上，成本高于当前收益。
3. **补默认密钥并默认开启**：最贴近 OpenSSH，但改变现有失败模式，且会引入未预期的口令弹窗。
4. **无条件传 `"pageant"`**：未安装 Pageant 的机器会认证失败，不可接受。
5. **把 agent 探测交给用户环境变量**：可作为将来的显式开关，本次不做。

## Risks

- 只试第一把 key 的规则仍然可能让用户困惑（「我配了两把，为什么不用第二把」）——文档已写明；如果这种配置真出现，再考虑加一条「检测到多把时提示只用第一把」。
- Windows agent 修好后，Pageant 用户会从「agent 认证失败」变成「不使用 agent」——两者都不工作，但现在的失败更明确（不会把 PID 当地址）。
- 该修正无法在无 agent 的机器上做真机验证，只能靠纯函数测试（已新增 `test/agent-address.test.js`）。
