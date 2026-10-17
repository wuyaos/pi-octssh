# P2a 交接：项目身份 + 规则存储 + 裁决纯函数

Status: in progress
Round: P2a（只做数据与纯函数，不接入入口）

## 文件清单与完成情况

- [x] `src/security/project.ts` — `projectIdFromCwd` / `projectRootFromCwd` / `projectDisplayPath`：git `--show-toplevel` 优先，否则规范化 cwd；`realpathSync.native` 解 junction；只小写盘符，不整条小写
- [x] `src/util/lockfile.ts` — `withLock`：`openSync(wx)` 独占；仅「同 host 且 `process.kill(pid,0)` 抛 ESRCH」才接管；异机/不可判定等待到超时后 `LockBusyError`；`finally` 释放
- [x] `src/security/rules.ts` — `policy/projects/<projectId>.json`，zod `.strict()` + `version`；load/save/add/remove/list；`RulesUnreadableError` 与「无规则」区分；读改写经 `withLock` + `atomicWriteFileSync`
- [x] `src/security/evaluate.ts` — `evaluateOperation` 纯函数；deny>ask>allow，顺序无关；路径段边界 + `subtree`；命令全串匹配 + cwd + sudo；命中规则回传

## 假设（待主线程确认）

- 受管操作枚举取自现有真实入口：`hosts` / `hosts-refresh` / `machine-info`、
  `exec`、`exec-async`、`upload`、`upload-async`、`download`、`download-async`、
  `session-get`、`session-grep`、`session-write-stdin`、`session-cancel`，
  外加契约要求但尚未实现的 `read`、`edit`。没有凭空造操作名。
- 现有 `src/security/policy.ts` 的 `guardExecCommand` 返回
  `allow|block|needs_confirmation`；本轮不修改它，`evaluate.ts` 只做
  “项目规则层”，语义上位于内建硬禁止之后、内建需确认之前（接入在 P2b 决定）。

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
唯一失败仍是 P1a 已记录的 Windows symlink `EPERM`。

### project identity（临时探针 C:/tmp/p2a，未入库）

```
root : proj-v1:2d1fa48bcb33364b9bbcee802d6508d352f166b8300556d791d619b97af29c1c
subdir: proj-v1:2d1fa48bcb33364b9bbcee802d6508d352f166b8300556d791d619b97af29c1c
same? true
display: d:/work/project/person/pi-octssh
non-git: proj-v1:451354c17374e58363a45c76eb24eabf5adb210d91ba5feaa9b6f334bf233612
```

### evaluateOperation（纯函数）

```
subtree /app vs /app/x       -> allow | project_allow | rule: r1
subtree /app vs /application -> ask | no_rule | rule: -      ← 段边界生效
exact /app vs /app/x         -> ask | no_rule | rule: -      ← 非子树不匹配
deny vs allow (/app/secret/key) -> deny | project_deny | rule: d
order independence 1         -> deny | project_deny | rule: d  ← 与规则顺序无关
ask vs allow                 -> ask | project_ask | rule: q
deny vs ask                  -> deny | project_deny | rule: d
prefix command not granted   -> ask | no_rule | rule: -      ← `git status` 不放行 `git status; rm -rf /`
exact command granted        -> allow | project_allow | rule: r1
different user no match      -> ask | no_rule | rule: -
jump mismatch                -> ask | no_rule | rule: -
builtin block wins           -> deny | builtin:root_delete | rule: -
invalid rule denies          -> deny | invalid_rule | rule: -
```

### withLock

```
1 acquire/release: 42 | left behind: false
2 live lock: LockBusyError | waited 311 ms | owner pid 45848   ← 活锁不被抢
3 dead owner takeover: took over                               ← 同机 ESRCH 可接管
4 foreign lock: LockBusyError | waited 318 ms                  ← 异机不抢
5 corrupt lock: LockBusyError
6 released after throw: true
```

### 规则存储

```
1 empty load: {"version":1,"projectId":"proj-v1:test","rules":[]}
2 addRule id: rule-mvcu2uii-v6eolb | list: 1
3 second rule, list: deny:exec,allow:read
4 evaluate deny: deny
5 evaluate allow: allow
6 evaluate none: ask
7 remove: true | remaining: 1
8 remove missing: false
9 corrupt load: RulesUnreadableError
10 evaluateForProject on corrupt: {"decision":"deny","reason":"rules_unreadable"}
11 strict extra field: RulesUnreadableError
```

## 未做 / 待办

- 未接入任何入口（P2b）：`runtime.exec/upload/...`、`extensions/octssh.ts` 尚未调用 `evaluateOperation`。
- 未实现 `/octssh rules` 之类的人工管理命令（P2b/P2c）。
- 临时探针目录 `C:/tmp/p2a` 已随本轮结束，未入库、未留在仓库。
