# P1b 交接：凭据与遮罩输入

Status: in progress
Round: P1b（密码 / 私钥口令 / 遮罩输入）

## 已完成

- [x] 读取契约第 2、3 组与现有 `src/security/identity.ts`、`src/ssh/connect.ts`、`src/core/runtime.ts`。

## 待办骨架

- [x] `src/tui/secretPrompt.ts` — 遮罩组件（Component & Focusable，仅掩码回显，CURSOR_MARKER 焦点）
- [x] `src/ssh/credentials.ts` — 进程内缓存 + 同 key 合并 + 全局串行队列 + invalidate/clearAll
- [x] `src/ssh/connect.ts` — `passphrase`/`password` 参数；`auth` 注入式认证回调（none→publickey→agent→password）；`parseKey` 判定加密私钥；`AUTH_UNSUPPORTED`（仅 keyboard-interactive）与 `AUTH_REQUIRES_UI`；密码 2 次上限 + `onAuthFailure` 失效；网络错误不归类为凭据错误
- [x] `src/core/runtime.ts` — `buildAuthOptions()`：`identityKey` 作密码缓存键，私钥材料 sha256 作口令缓存键；`credentialPrompt` 注入点
- [x] `extensions/octssh.ts` — `credentialPrompt()` 用 `ctx.ui.custom(..., {overlay:true})` 包 `SecretPrompt`（仅 TUI+hasUI）；`/octssh credentials clear`
- [x] 离线探针验证 ①–⑥（输出见下）
- [ ] 真机验证（本轮不跑）

## 验证输出原文

离线探针由**主线程**补跑（coder 在接入扩展层时触顶超时，本轮未自行验证）：

- `npm run typecheck` → 退出码 0；`npm test` → `tests 22 / pass 21 / fail 1`（唯一失败仍是 symlink `EPERM`，环境限制）
- 探针 `C:/tmp/octssh-fp/cred-probe.cjs`（未入库）原文：
  - `[1] promptCalls=1 same=true sources=prompt/prompt value=S3cr3t-PROBE-9182`（同 key 并发 → 一次弹窗）
  - `[3] beforeInvalidate=1 afterInvalidate=2`（invalidate 后重弹）
  - `[4] cacheSize=4 cleared=4 sizeAfter=1 reprompted=true`（clearAll 返回条数）
  - `[5] cancelledResult=undefined promptCalls=2`（取消不缓存）
  - `[6] errorMessage=CredentialPromptError: Error while requesting password for e@h:22` / `[6] secretLeaked=false`（明文不进错误信息）
- 探针 `C:/tmp/octssh-fp/serial-probe.cjs`（未入库）原文，全局串行是真测量而非断言：
  - `maxActive=1 (期望 1)`
  - `a:start(active=1) | a:end(active=0) | b:start(active=1) | b:end(active=0) | c:start(active=1) | c:end(active=0)`
- 已知缺口（未修，留给 P5 打磨）：`SecretPrompt` 忽略多字符输入，因此**粘贴密码无效**（密码管理器粘贴是常见路径）；需支持 bracketed paste（`\u001b[200~` … `\u001b[201~`）

## 真机验证待办（本轮不跑）

1. 真实密码登录（只开 `PasswordAuthentication yes`）成功。
2. 加密私钥 + passphrase 成功；错误口令 → `AUTH_FAILED` 且不再弹窗。
3. 仅 `keyboard-interactive` 的服务器 → `AUTH_UNSUPPORTED`，不当作密码失败。
4. 密码错误两次后停止，第三次不再弹窗。
5. 凭据不出现在 `session json` / 传输日志 / 工具结果 / 终端输出。
