# P2b 交接：裁决接入 + 四选项确认 + permissions 入口

Status: in progress
Round: P2b

## 文件变更

- [x] `src/core/runtime.ts` — 所有受管入口加可选 `projectId`；deny 在 `pool.get()` 之前判定（不建连接）；`guardExecCommand` 的 block 优先于项目 allow；`ask` 即使本来不需确认也弹；`AuthorizationRequest` 增加可选 `scope`/`allowPermanent`（向后兼容）；`MAX_PERMANENT_SCOPE=10`
- [x] `extensions/octssh.ts` — `ctx.ui.select` 四选项（仅本次/始终允许/始终禁止/本次拒绝）；永久项先 `addRule` 落盘再继续；`allowPermanent=false` 或超 10 个文件时不提供「始终」；标题展示完整范围（命令全文不截断）；新增 `/octssh permissions [remove <id>]`；`projectId()` 只从 `ctx.cwd` 推导并缓存
- [x] `src/security/authorize.ts`（新）— `OperationScope`、`execRequest`/`fileRequest`、`execRule`/`fileRule`/`scopeRule`、`builtinBlockFromGuard`（只做 block→deny 映射，不重抄清单）、`describeScope`（全文不截断）

## 验证输出

### typecheck

```
> pi-octssh@0.1.0 typecheck
> tsc --noEmit
```
退出码 0。

### npm test（不回归）

```
ℹ tests 22
ℹ pass 21
ℹ fail 1
✖ walkLocal rejects symlinks instead of following directory loops
```

### ③ 规则回放（命令含空格 / 引号 / 中文，临时探针 C:/tmp/p2b）

```
"git status"                               -> allow | mutated+extra: ask
"echo \"hello world\" | grep 'x y'"        -> allow | mutated+extra: ask
"mkdir -p /data/项目 目录 && ls -l"            -> allow | mutated+extra: ask
"printf '%s\\n' \"a\\\"b'c\""              -> allow | mutated+extra: ask
"uname -a; df -h"                          -> allow | mutated+extra: ask
```
每条由请求造出的规则都能原样命中同一请求；追加一个 token 后不再命中（不做前缀授权）。

### ① 文件范围（默认精确，子树需显式）

```
exact hit   : allow
sibling miss: ask
subtree hit : allow
boundary    : ask     ← /srv/logs 不匹配 /srv/logs2
```

### ② 内建硬禁止 vs 项目 allow

```
with block   : {"decision":"deny","reason":"builtin:blocked_pattern"}
without block: "allow"
```

### ① ask 规则 + sudo 条件

```
ask hit     : "ask"
sudo mismatch: ask    ← sudo 条件不同，规则不命中，落到默认 ask
```

### describeScope 不截断

```
操作: exec
主机: web → deploy@10.0.0.5:22
跳板: ops@bastion:22
远端 cwd: /srv
sudo: 是
命令全文:
echo xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx…(305)   ← 305 字符仍完整输出
```

### runtime 层：deny 不建连接（无服务器，2 ms 返回）

```
identity: {"alias":"probe-nonexistent-host","host":"probe-nonexistent-host","port":22,"user":"wff19"}
deny exec  : {"kind":"blocked","reason":"project_deny","message":"Blocked by project rule rule-mvcv0svd-prwj0c (deny, exec)."} in 2 ms
no-rule exec: SshConnectError/NETWORK in 1298 ms  (=> reached connection layer)
deny dl    : {"kind":"blocked","reason":"project_deny","message":"Blocked by project rule rule-mvcv0tvs-4iqsgh (deny, download)."}
```

### 端到端：app 内 ssh2 Server 夹具 + 真 runtime 路径

```
identity: {"alias":"fixture","host":"127.0.0.1","port":12426,"user":"tester"} port= 12426
1 no rule   : needs_confirmation | reason: -
2 allow rule: success | exit: 0 | execSeen: ["uname -s 2>/dev/null || ver","sh -lc 'uname -a'"]
3 ask rule  : needs_confirmation | reason: - | scope op: exec
4 deny rule : blocked | reason: project_deny | command executed: false
5 builtin   : blocked | reason: blocked_executable
```
1/3 未命中 allow 时仍弹确认；2 命中 allow 直接执行（服务器端确实收到 `sh -lc 'uname -a'`）；4 deny 后服务器**没有**收到该命令；5 即使存在 allow 规则，内建可执行名单仍然阻止。

### ④ 模型拿不到规则入口

```
hostsSchema      keys: machine,refresh,target | banned: (none)
execSchema       keys: machine,command,mode,sudo | banned: (none)
transferSchema   keys: machine,direction,localPath,remotePath,async | banned: (none)
sessionSchema    keys: action,sessionId,lines,pattern,maxMatches,contextLines,data,appendNewline,signal | banned: (none)
registered commands: octssh
```
四个工具参数里没有任何 project/rule/permission/effect 字段；`addRule`/`removeRule` 只被
`withConfirmation` 与 `/octssh permissions`（人触发的 command）调用。

## 待办 / 已知差距

- 「涉及超过 10 个文件时不提供始终允许」目前只覆盖 upload 冲突路径（`conflicts.length > MAX_PERMANENT_SCOPE`）。edit/read 尚未实现，接入时须沿用 `allowPermanent`。
- 下载路径目前只做 deny 判定，不弹确认（现状本就不确认），未产生 `scope`，因此不能落永久规则。
- 未连真实远端；`session-*` 的 deny 判定只验证了代码路径（trivial），未做夹具端到端。
- 真机待办沿用 P1b.md 清单（密码/口令/keyboard-interactive/两次上限/凭据不外泄）。
