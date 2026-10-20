export type ConnectionLease<T> = {
  value: T;
  release: () => void;
};

export type ConnectionPoolOptions = {
  maxConnections: number;
  idleTtlMs: number;
  connectTimeoutMs?: number;
};

function abortError(): Error {
  const error = new Error("Connection wait aborted");
  error.name = "AbortError";
  return error;
}

function waitForAbortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

type Entry<T> = {
  value: T;
  lastUsedAt: number;
  refCount: number;
};

export class ConnectionPool<K, T> {
  private readonly create: (key: K, signal?: AbortSignal) => Promise<T>;
  private readonly closeFn: (value: T) => Promise<void> | void;
  private readonly maxConnections: number;
  private readonly idleTtlMs: number;
  private readonly entries = new Map<K, Entry<T>>();
  private readonly inflight = new Map<K, Promise<Entry<T>>>();
  private readonly attempts = new Map<K, AbortController>();
  private readonly connectTimeoutMs: number;
  private closed = false;

  constructor(params: {
    create: (key: K, signal?: AbortSignal) => Promise<T>;
    close: (value: T) => Promise<void> | void;
    options: ConnectionPoolOptions;
  }) {
    this.create = params.create;
    this.closeFn = params.close;
    this.maxConnections = params.options.maxConnections;
    this.idleTtlMs = params.options.idleTtlMs;
    this.connectTimeoutMs = params.options.connectTimeoutMs ?? 60_000;
  }

  size() {
    return this.entries.size;
  }

  async get(key: K, signal?: AbortSignal): Promise<ConnectionLease<T>> {
    if (this.closed) throw new Error("Connection pool is closed");
    if (signal?.aborted) throw abortError();

    let entry = this.entries.get(key);
    if (!entry) {
      let pending = this.inflight.get(key);
      if (!pending) {
        // 共享创建由池控制；某个调用者取消只退出自己的等待。
        const controller = new AbortController();
        this.attempts.set(key, controller);
        pending = this.createEntry(key, controller);
        this.inflight.set(key, pending);
        const attempt = pending;
        pending.finally(() => {
          if (this.inflight.get(key) === attempt) this.inflight.delete(key);
          if (this.attempts.get(key) === controller) this.attempts.delete(key);
        }).catch(() => undefined);
      }
      entry = await waitForAbortable(pending, signal);
      if (this.closed || this.entries.get(key) !== entry) {
        throw new Error("Connection pool was cleared while connecting");
      }
    }

    entry.refCount += 1;
    entry.lastUsedAt = Date.now();
    let released = false;
    return {
      value: entry.value,
      release: () => {
        if (released) return;
        released = true;
        entry!.refCount = Math.max(0, entry!.refCount - 1);
        entry!.lastUsedAt = Date.now();
      },
    };
  }

  private async createEntry(key: K, controller: AbortController): Promise<Entry<T>> {
    const timeout = setTimeout(() => {
      const error = new Error("SSH 连接准备超时。");
      error.name = "TimeoutError";
      controller.abort(error);
    }, this.connectTimeoutMs);
    try {
      const creation = (async () => {
        await this.evictIfNeeded();
        controller.signal.throwIfAborted();
        const value = await this.create(key, controller.signal);
        // 工厂不响应取消时，迟到连接只能关闭，不能重新进入已清空的池。
        if (controller.signal.aborted || this.closed) {
          await this.closeFn(value);
          throw controller.signal.reason ?? new Error("Connection pool is closed");
        }
        const entry: Entry<T> = { value, lastUsedAt: Date.now(), refCount: 0 };
        this.entries.set(key, entry);
        return entry;
      })();
      return await waitForAbortable(creation, controller.signal);
    } finally {
      clearTimeout(timeout);
    }
  }

  async close(key: K) {
    await this.invalidate(key);
  }

  /** Remove a dead connection without accidentally closing a replacement. */
  async invalidate(key: K, expectedValue?: T): Promise<boolean> {
    const entry = this.entries.get(key);
    if (!entry || (expectedValue !== undefined && entry.value !== expectedValue)) return false;
    this.entries.delete(key);
    await this.closeFn(entry.value);
    return true;
  }

  async closeAll() {
    this.closed = true;
    this.abortAttempts();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => Promise.resolve(this.closeFn(entry.value))));
  }

  /**
   * 断开所有缓存连接，但池本身继续可用。
   *
   * 与 `closeAll()` 的区别是**不置 closed**：`closeAll()` 是关闭语义，之后
   * 任何 `get()` 都会抛错，只能用于 shutdown。用户主动「清凭据并断开连接」
   * 之后还要能继续用，因此需要这个。
   */
  async dropAll(): Promise<number> {
    this.abortAttempts();
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => Promise.resolve(this.closeFn(entry.value))));
    return entries.length;
  }

  private abortAttempts() {
    const attempts = [...this.attempts.values()];
    this.attempts.clear();
    this.inflight.clear();
    for (const controller of attempts) controller.abort(abortError());
  }

  async sweep(now = Date.now()) {
    if (this.closed) return;
    for (const [key, entry] of this.entries) {
      if (entry.refCount > 0) continue;
      if (now - entry.lastUsedAt < this.idleTtlMs) continue;
      await this.close(key);
    }
  }

  private async evictIfNeeded() {
    if (this.entries.size + this.inflight.size < this.maxConnections) return;

    let victimKey: K | null = null;
    let victimLastUsed = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.refCount > 0) continue;
      if (entry.lastUsedAt < victimLastUsed) {
        victimLastUsed = entry.lastUsedAt;
        victimKey = key;
      }
    }

    if (victimKey === null) {
      throw new Error(
        `Max connections reached (${this.maxConnections}); no idle connection available to evict.`
      );
    }
    await this.close(victimKey);
  }
}
