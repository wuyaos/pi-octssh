# post-v1 交接：项目身份标记 + 遮罩输入粘贴

Status: in progress

## 文件变更

- [x] `src/security/project.ts` — `projectRootFromCwd` 改为三级：git 工作树根 → 向上查找 `.pi/octssh.json` 所在目录 → 启动 cwd；新增导出 `findProjectMarkerRoot()` 与 `PROJECT_MARKER_RELATIVE`；只查存在性（`statSync().isFile()`），到盘根止步
- [x] `src/tui/secretPrompt.ts` — `handleInput` 新增 `consumePaste()`：支持 bracketed paste（`\x1b[200~`…`\x1b[201~`，含跨 chunk 拆分），无序列的多字符 chunk 也全部追加；粘贴内容只进 `value`，渲染仍是掩码
- [x] `AGENTS.md` — 规范段补项目身份推导规则

## 验证输出

### typecheck / test

```
> pi-octssh@0.1.0 typecheck
> tsc --noEmit
TC=0

ℹ tests 22
ℹ pass 21
ℹ fail 1
✖ walkLocal rejects symlinks instead of following directory loops
```

### 修 A（C:/tmp/postv1，真实临时目录，未入库）

```
① marker: inner==deeper: true | outer differs: true
① display(deeper): c:/Users/wff19/AppData/Local/Temp/postv1-5NJcNT/outer/inner | expected inner: c:/Users/wff19/AppData/Local/Temp/postv1-5NJcNT/outer/inner
② git dir present -> root is inner (git root): true
③ no marker -> root is cwd: true
③ subdir differs from parent: true
```

第一个探针里的 ② 用的是空 `.git` 目录；空目录对 `git rev-parse` 无效，因此补了真实 `git init` 的对照：

```
② git repo at repo, marker at repo/sub
   root(sub) == repo (git wins): true
   id(sub) == id(repo): true
```

### 修 B（同一个临时目录，直接驱动组件）

```
④ paste value: "S3cr3t-PROBE-9182" | length: 17
④ mask only (no plaintext in render): true | render: "Password for root@host:22
› •••••••••••••••••
Enter 确认 · Esc 取消 · 输入不回显"
⑤ multi-char value: "abcde"
⑥ single char: "x"
⑥ esc -> undefined: true
⑥ backspace: "a"
④ split paste: "secret-tail"
```

④ 的 render 断言是关键：17 个字符全部进缓冲，而界面只有 17 个 `•`，明文不出现在渲染输出里。
`split paste` 那条验证跨 chunk 的粘贴（终端把一次粘贴拆成两个 `handleInput` 调用）也能正确拼接。
