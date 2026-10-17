import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * 项目身份。
 *
 * 规则文件按项目隔离，因此 projectId 必须只由宿主在本地推导：模型永远只能
 * 选「在哪台主机做什么」，不能提供项目标识——否则一个被污染的 prompt 就能
 * 把操作落到别的项目的规则集里。
 *
 * 同仓库不同子目录必须归到同一个 projectId，所以优先取 git 工作树根。
 */

function tryRealpath(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

/**
 * 规范化：先 realpath（消解 Windows junction / symlink），再统一分隔符与
 * 盘符大小写。**不对整条路径小写**——Linux 远端与 Windows 大小写敏感性不同，
 * 整条小写会把 `/App` 与 `/app` 混为一谈。
 */
export function normalizeProjectPath(target: string): string {
  const absolute = path.resolve(target);
  const real = tryRealpath(absolute) ?? absolute;
  const withForwardSlashes = real.replace(/\\/g, "/");
  // 只规范化 Windows 盘符（C:/ -> c:/），其余保持原样。
  const normalizedDrive = /^[A-Za-z]:\//.test(withForwardSlashes)
    ? withForwardSlashes[0].toLowerCase() + withForwardSlashes.slice(1)
    : withForwardSlashes;
  const withoutTrailingSlash = normalizedDrive.replace(/\/+$/, "");
  return withoutTrailingSlash === "" ? "/" : withoutTrailingSlash;
}

function gitToplevel(cwd: string): string | null {
  try {
    const out = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    }).trim();
    return out ? out : null;
  } catch {
    // 不是 git 仓库、没装 git、或 cwd 不存在：回退到 cwd 本身。
    return null;
  }
}

/** 项目根：git 工作树根，否则规范化后的 cwd。 */
export function projectRootFromCwd(cwd: string): string {
  const top = gitToplevel(cwd);
  return normalizeProjectPath(top ?? cwd);
}

export function projectIdFromCwd(cwd: string): string {
  const root = projectRootFromCwd(cwd);
  const digest = crypto.createHash("sha256").update(root, "utf8").digest("hex");
  return `proj-v1:${digest}`;
}

/** 供 UI 展示的可读路径（projectId 本身是不可逆摘要）。 */
export function projectDisplayPath(cwd: string): string {
  return projectRootFromCwd(cwd);
}
