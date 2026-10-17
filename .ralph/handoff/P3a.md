# P3a 交接：指纹 + 编辑规划 + SFTP 原语 seam

Status: in progress
Round: P3a（纯函数与原语，不接 runtime、不注册工具、不连远端）

## 文件变更

- [x] `src/remote/fingerprint.ts`（新）— 强/弱 token（`v1i`/`v1w`）；`buildStatCommand`（GNU `-c %i|%h`、BSD `-f %i|%l`，路径只经 `quoteForSh`）；`parseStatOutput` 区分 `template_not_applicable` 与 `unparsable_field`；`assertWritableFingerprint` 拒绝弱 token；`nextTemplateToTry` 供能力缓存
- [x] `src/remote/editPlan.ts`（新）— `planEdit` 纯函数：2 MiB / NUL / 严格 UTF-8（线性扫描给非法偏移）/ 空 oldText / 0 次 / 多次 / token 不匹配全部显式拒绝；BOM 保留且不计入正文坐标；逐字节替换 + 无损往返自检；有界 diff（60 行 / 8 KiB）
- [x] `src/ssh/sftp.ts` — 纯追加：`sftpLstat`、`sftpWriteExclusive`（`wx`，32 KiB 分块）、`posixRename`（不支持时 `code=POSIX_RENAME_UNSUPPORTED`）、`setTimes`、`sftpChmod`、`sftpChown`。现有函数一行未动（`git diff` 无删除行）

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

### planEdit 与 token（C:/tmp/p3a 临时探针，未入库）

```
① CRLF out: "alpha\r\nBETA\r\ngamma\r\n" | CRLF count: 3 | lone LF: 0
② BOM: true | starts with BOM: true | body: "hello 世界!\n" | firstChanged: 6
③ emoji: "前🎉后\n"
③ CJK  : "前前🙂后\n" | offsets: 0 6
④ invalid utf8: {"reason":"invalid_utf8","at":2}
    80 -> {"reason":"invalid_utf8","at":0}
    e4b8 -> {"reason":"invalid_utf8","at":0}
    c080 -> {"reason":"invalid_utf8","at":0}
    eda080 -> {"reason":"invalid_utf8","at":0}
⑤ zero : {"reason":"no_match"}
⑤ twice: {"reason":"ambiguous_match","count":2}
⑥ too big: {"reason":"too_large","size":2097153,"limit":2097152}
⑦ decoded: {"version":"v1i","strength":"strong","fields":{"mode":33188,"uid":1000,"gid":1000,"size":40,"mtime":1700000000,"inode":"12345","nlink":"1"}}
⑦ tamper (field, differs, decodedValue):
    mode  true  33189
    uid   true  1001
    gid   true  1001
    size  true  41
    mtime true  1700000001
    inode true  "12346"
    nlink true  "2"
⑦ weak token rejected for edit: {"reason":"weak_version","version":"v1w"}
⑧ diff lines: 8 | totalLines: 8 | truncated: false | diff bytes: 240 | out size: 308867 | firstChanged: 153890
```

补充（同一探针）：

```
worst-case diff lines: 5 | totalLines: 5 | truncated: false | bytes: 203
long-line diff lines: 3 | truncated: true | bytes: 140      ← 单行超长时按字节上限截断

 stat cmd gnu: stat -c '%i|%h' -- '/data/it'\''s here.txt'
 stat cmd bsd: stat -f '%i|%l' -- '-weird-name'
 parse gnu ok: {"ok":true,"inode":"12345","nlink":"1"}
 parse bsd ok: {"ok":true,"inode":"98765","nlink":"2"}
 parse bsd-on-gnu: {"ok":false,"reason":"template_not_applicable","detail":"stat bsd template is not supported by this host"}
 parse garbage: {"ok":false,"reason":"unparsable_field","detail":"non-numeric inode/nlink"}
 next template: gnu tried -> bsd | both tried -> null
 weak decode: {"version":"v1w","strength":"weak","fields":{"mode":1,"uid":2,"gid":3,"size":4,"mtime":5}}
 bad token: null null
 strong without inode throws: strong fingerprint requires inode and nlink
```

### SFTP 原语（假 client，无远端）

```
lstat: {"mode":33188,"uid":1,"gid":1,"size":3,"atime":1,"mtime":2} | calls: [["lstat","/f"]]
exclusive write chunks: [ 32768, 32768, 6144 ] | open flags: wx mode: 644 | closed: true
exclusive EEXIST: 11 | message: exists
posixRename: [["posixRename","/a.tmp","/a"]]
posixRename unsupported: POSIX_RENAME_UNSUPPORTED
posixRename missing: POSIX_RENAME_UNSUPPORTED
metadata calls: [["utimes","/f",100,200],["chmod","/f",384],["chown","/f",1000,1000]]
```

## 只能真机验证的清单（本轮不跑）

1. **stat 模板实际选择**：真实 GNU 主机上 `stat -c '%i|%h' -- <path>` 输出的 inode/nlink 与
   `ls -i` / `ls -l` 的链接数一致；BSD/macOS 主机上 `-f` 模板可用而 `-c` 报 illegal option
   （本轮只用构造输出验证了两种失败分支）。
2. **inode/nlink 的真实稳定性**：硬链接变化、文件被 `mv` 替换 inode、`rsync` 就地重写等
   情况下 token 是否按预期变化（这决定 edit 的并发保护是否真的有效）。
3. **`posixRename@openssh.com` 真支持性**：OpenSSH 与 dropbear/非 OpenSSH 服务器上的
   支持差异、以及不支持时的 `ssh2` 错误码是否真的是 8
   （本轮只验证了我们自己的映射与「方法不存在」分支）。
4. **`wx` 独占创建在真实服务器上的语义**：attr 是否被服务器改动、并发创建时是否返回
   SSH_FX_FAILURE(4) 而不是 11（当前 `sftpWriteExclusive` 把非 0 错误原样抛出，
   需要真机确认错误码以便上层区分「已存在」与「权限不足」）。
5. **`setTimes` 精度**：SFTP v3 的 mtime 只有秒级，真实服务器上 `utimes` 是否保留秒以外的
   精度（决定 edit 后 mtime 比较是否会误判）。
6. **`sftpChown` 权限边界**：非 root 用户 chown 到他人时的真实错误。
7. **CRLF/BOM 往返**：在真实远端文件上（含 UTF-8 BOM 的配置文件）确认 edit 后除目标字节
   外完全不变——本地探针覆盖了字节层，但没有覆盖「服务器是否在写入时做换行转换」。
8. **2 MiB 上限下的整文件往返耗时**：真实链路上 read-modify-write 的时延是否可接受。
