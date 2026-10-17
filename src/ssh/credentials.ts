/**
 * 凭据请求与进程内缓存。
 *
 * 刻意不依赖 TUI：遮罩输入由外部注入的 prompt 提供，因此这里可以在离线
 * 探针里用假 prompt 完整验证排队与合并语义。
 *
 * 三条不变量：
 * 1. 同一 (kind, key) 的并发请求合并成一次弹窗，共享同一个 in-flight promise。
 * 2. 全局串行：不同 key 的弹窗按请求顺序排队，任意时刻最多一个 prompt 在跑。
 * 3. 凭据值只出现在返回值里；错误与日志一律不带它。
 */

export type CredentialKind = "password" | "key-passphrase";

export type CredentialRequest = {
  kind: CredentialKind;
  key: string;
  /** 展示给用户的对象描述，例如 user@host:port。 */
  label: string;
};

export type CredentialPrompt = (request: CredentialRequest) => Promise<string | undefined>;

export type CredentialResult = {
  value: string;
  source: "cache" | "prompt";
};

export class CredentialPromptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialPromptError";
  }
}

const cache = new Map<string, string>();
const inflight = new Map<string, Promise<CredentialResult | undefined>>();

function cacheKey(kind: CredentialKind, key: string) {
  return `${kind}\0${key}`;
}

/** 全局串行队列：只有队首的 prompt 在跑。 */
let queueTail: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queueTail.then(task, task);
  // 队列本身不因单个任务失败而中断。
  queueTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function requestCredential(
  kind: CredentialKind,
  key: string,
  label: string,
  prompt: CredentialPrompt,
): Promise<CredentialResult | undefined> {
  const id = cacheKey(kind, key);

  const cached = cache.get(id);
  if (cached !== undefined) return { value: cached, source: "cache" };

  const pending = inflight.get(id);
  if (pending) return pending;

  const attempt = enqueue(async (): Promise<CredentialResult | undefined> => {
    // 排队期间可能已被其他请求填充或被 invalidate 清掉，进队列后再看一次。
    const nowCached = cache.get(id);
    if (nowCached !== undefined) return { value: nowCached, source: "cache" };

    let value: string | undefined;
    try {
      value = await prompt({ kind, key, label });
    } catch (error) {
      // prompt 是外部注入的实现，其异常消息不可控。只保留可分类的部分，
      // 绝不把消息原样带出——否则一次失败的弹窗就可能把凭据写进日志。
      const name = error instanceof Error ? error.name : "Error";
      throw new CredentialPromptError(`${name} while requesting ${kind} for ${label}`);
    }
    if (value === undefined) return undefined;
    cache.set(id, value);
    return { value, source: "prompt" };
  }).finally(() => {
    inflight.delete(id);
  });

  inflight.set(id, attempt);
  return attempt;
}

/** 认证失败后调用：下次请求重新弹窗。 */
export function invalidateCredential(kind: CredentialKind, key: string): void {
  cache.delete(cacheKey(kind, key));
}

/** 清除全部缓存，返回清除条数。in-flight 请求不受影响。 */
export function clearAllCredentials(): number {
  const count = cache.size;
  cache.clear();
  return count;
}

/** 只用于测试与诊断：返回缓存条目数，不含任何值。 */
export function credentialCacheSize(): number {
  return cache.size;
}
