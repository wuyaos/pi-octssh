import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 跨进程排他锁。
 *
 * `fs.openSync(..., "wx")` 是唯一在 Windows 与 POSIX 上都真正原子的创建方式。
 * 接管策略刻意保守：只有「同机、owner pid 确实不存在」才允许接管。单纯
 * 超时不构成接管理由——对方可能只是在跑一条慢命令，抢锁会直接导致规则文件
 * 被两个进程同时改写。
 */

/** 本进程在本机上的标识；只有同 instanceId 的锁才能靠 pid 判活。 */
const instanceId = `${os.hostname()}#${process.pid}`;

export type LockOwner = {
  pid: number;
  instanceId: string;
  startedAt: string;
};

export class LockBusyError extends Error {
  readonly owner: LockOwner | null;

  constructor(message: string, owner: LockOwner | null) {
    super(message);
    this.name = "LockBusyError";
    this.owner = owner;
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<LockOwner>;
    if (typeof parsed.pid !== "number" || typeof parsed.instanceId !== "string" || typeof parsed.startedAt !== "string") {
      return null;
    }
    return { pid: parsed.pid, instanceId: parsed.instanceId, startedAt: parsed.startedAt };
  } catch {
    // 文件存在但读不出来（正在写、或已损坏）：视为无法判定 owner。
    return null;
  }
}

/** `ESRCH` 才代表进程不存在；`EPERM` 说明进程在但无权发信号。 */
function pidMissing(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** instanceId 形如 `host#pid`；取主机部分判断锁是否来自本机。 */
function hostOf(owner: LockOwner): string {
  const hash = owner.instanceId.lastIndexOf("#");
  return hash === -1 ? owner.instanceId : owner.instanceId.slice(0, hash);
}

/**
 * owner 是否确实已经不在：同机 + pid 不存在。
 *
 * 必须是「同机」判定，不能要求 instanceId 完全相同——崩掉的持有者 pid 必然
 * 与当前进程不同，用整串比较等于永远无法接管死锁。异机与不可判定都返回 false。
 */
function ownerIsGone(owner: LockOwner): boolean {
  if (hostOf(owner) !== os.hostname()) return false;
  return pidMissing(owner.pid);
}

/** 同步调用者不能在 Pi 主线程轮询；锁忙立即失败，由上层决定下一轮重试。 */
export function withLock<T>(lockPath: string, fn: () => T): T {
  let recoveryAttempted = false;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  let fd: number | undefined;

  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const owner = readOwner(lockPath);

      if (!recoveryAttempted && owner && ownerIsGone(owner)) {
        recoveryAttempted = true;
        // 同机且 pid 已消失：上一持有者崩在临界区里，接管。
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* 已被别人清掉，回到重试 */
        }
        continue;
      }

      throw new LockBusyError("状态正在被另一操作使用，请稍后重试。", owner);
    }
  }

  try {
    const owner: LockOwner = { pid: process.pid, instanceId, startedAt: new Date().toISOString() };
    fs.writeFileSync(fd, JSON.stringify(owner), "utf8");
    fs.fsyncSync(fd);
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  }
}
