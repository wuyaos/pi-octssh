export type ConnectionLease<T> = {
  value: T;
  release: () => void;
};

export type ConnectionPoolOptions = {
  maxConnections: number;
  idleTtlMs: number;
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
    const onAbort = () => reject(abortError());
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
        // A connection is shared by every waiter for this key. In particular,
        // do not pass the first caller's AbortSignal into create(): cancelling
        // one tool invocation must only stop that invocation's wait, not tear
        // down the connection other callers are about to use.
        pending = this.createEntry(key);
        this.inflight.set(key, pending);
        pending.finally(() => this.inflight.delete(key)).catch(() => undefined);
      }
      entry = await waitForAbortable(pending, signal);
      if (this.closed) {
        if (this.entries.get(key) === entry) this.entries.delete(key);
        await this.closeFn(entry.value);
        throw new Error("Connection pool was closed while connecting");
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

  private async createEntry(key: K): Promise<Entry<T>> {
    await this.evictIfNeeded();
    const value = await this.create(key);
    const entry: Entry<T> = { value, lastUsedAt: Date.now(), refCount: 0 };
    const raced = this.entries.get(key);
    if (raced) {
      await this.closeFn(value);
      return raced;
    }
    this.entries.set(key, entry);
    return entry;
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
    await Promise.allSettled([...this.inflight.values()]);
    const entries = [...this.entries.values()];
    this.entries.clear();
    await Promise.allSettled(entries.map((entry) => Promise.resolve(this.closeFn(entry.value))));
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
