import type { Readable, Writable } from "node:stream";

const CALLBACK_METHODS = new Set([
  "stat", "lstat", "mkdir", "readdir", "open", "close", "read", "write",
  "unlink", "chmod", "chown", "utimes", "ext_openssh_rename",
]);

function stopped(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/** 每个 SFTP 通道独占一个作用域；取消只影响这个通道，不关闭共享 SSH 连接。 */
export function scopeSftp(raw: any, signal?: AbortSignal, timeoutMs = 15_000): any {
  let failure: Error | undefined;
  let ended = false;
  const pending = new Set<(error: Error) => void>();
  const streams = new Set<Readable | Writable>();
  const detach = () => {
    signal?.removeEventListener("abort", onAbort);
    raw.removeListener?.("close", onClose);
    raw.removeListener?.("error", onError);
  };
  const stop = (error: Error) => {
    if (failure) return;
    failure = error;
    detach();
    // 先拒绝各 IO，再关通道。rename 的拒绝会由 applyEdit 判为 outcome_unknown。
    for (const reject of [...pending]) reject(error);
    for (const stream of streams) stream.destroy(error);
    raw.on?.("error", ignoreError);
    try { raw.end?.(); } catch { /* 通道可能已断开 */ }
    try { raw.destroy?.(); } catch { /* 通道可能已断开 */ }
  };
  const ignoreError = () => {};
  const onAbort = () => stop(stopped("AbortError", "SFTP 已取消；已发送的写入结果需核对。"));
  const onClose = () => stop(stopped("ConnectionError", "SFTP 连接中断；已发送的写入结果需核对。"));
  const onError = (error: Error) => stop(error);
  raw.on?.("close", onClose);
  raw.on?.("error", onError);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();

  return new Proxy(raw, {
    get(target, key, receiver) {
      if (key === "end") return () => {
        if (ended) return;
        ended = true;
        if (pending.size || streams.size) {
          stop(stopped("AbortError", "SFTP 操作已结束。"));
        } else {
          detach();
          raw.on?.("error", ignoreError);
          raw.end?.();
        }
      };
      const value = target[key];
      if (typeof value !== "function") return value;
      if (typeof key === "string" && CALLBACK_METHODS.has(key)) return (...args: any[]) => {
        const callback = args.pop();
        if (failure || ended) {
          queueMicrotask(() => callback(failure ?? stopped("AbortError", "SFTP 操作已结束。")));
          return;
        }
        let settled = false;
        const finish = (...result: any[]) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(reject);
          callback(...result);
        };
        const reject = (error: Error) => finish(error);
        const timer = setTimeout(() => stop(stopped("TimeoutError", "SFTP IO 超时；已发送的写入结果需核对。")), timeoutMs);
        pending.add(reject);
        try { value.apply(target, [...args, finish]); }
        catch (error) { finish(error); }
      };
      if (key === "createReadStream" || key === "createWriteStream") return (...args: any[]) => {
        if (failure || ended) throw failure ?? stopped("AbortError", "SFTP 操作已结束。");
        const stream = value.apply(receiver, args);
        streams.add(stream);
        // ssh2 的 _destroy 会等待 open/close 回调；取消后通道已归关闭路径，不能再等远端。
        const destroy = stream._destroy;
        stream._destroy = function (error: Error | null, callback: (error?: Error | null) => void) {
          if (failure) {
            callback(error ?? failure);
            // ssh2 禁用 Node 自动 close，由其 closeStream 手动发出；本分支也需补齐。
            const state = this._readableState ?? this._writableState;
            if (state?.emitClose === false) queueMicrotask(() => this.emit("close"));
            return;
          }
          destroy.call(this, error, callback);
        };
        // 流的存活期不限；每次读写进展重置空闲期限，避免限制大文件总传输时长。
        let finished = false;
        let timer: ReturnType<typeof setTimeout>;
        const touch = () => {
          if (finished) return;
          clearTimeout(timer);
          timer = setTimeout(() => stop(stopped("TimeoutError", "SFTP 传输无进展，已停止等待。")), timeoutMs);
        };
        const done = () => {
          finished = true;
          clearTimeout(timer);
          streams.delete(stream);
          stream.removeListener("data", touch);
          stream.removeListener("drain", touch);
        };
        stream.on("error", ignoreError);
        stream.once("close", done);
        stream.once(key === "createReadStream" ? "end" : "finish", done);
        // 不添加 data listener：这会提前切换为 flowing 模式，丢掉调用方未接收的字节。
        if (key === "createReadStream") {
          const push = stream.push;
          stream.push = function (...chunks: any[]) { touch(); return push.apply(this, chunks); };
        } else {
          const write = stream.write;
          stream.write = function (...chunks: any[]) { touch(); return write.apply(this, chunks); };
          stream.on("drain", touch);
        }
        touch();
        return stream;
      };
      return value.bind(target);
    },
  });
}
