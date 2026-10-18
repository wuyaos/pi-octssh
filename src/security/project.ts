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
 *
 * 非 git 目录没有天然的仓库边界，因此支持一个显式标记文件：从启动 cwd 向上
 * 查找 `.pi/octssh.json`，找到就以其所在目录为项目根。没有标记时退回启动目录
 * ——这意味著在非 git 项目里从不同子目录启动会被当成不同项目，用户的已批规则
 * 会静默失效；放一个标记文件即可固定身份。
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

/** 非 git 项目的标记文件名（只查存在性，不解析内容）。 */
export const PROJECT_MARKER_RELATIVE = path.join(".pi", "octssh.json");

/**
 * 从 cwd 向上查找 `.pi/octssh.json`，返回其所在目录；到盘根为止。
 *
 * 只判断存在性：内容是给人看的说明，不是配置契约。
 */
export function findProjectMarkerRoot(cwd: string): string | null {
  let current = path.resolve(cwd);
  for (;;) {
    const marker = path.join(current, PROJECT_MARKER_RELATIVE);
    try {
      if (fs.statSync(marker).isFile()) return current;
    } catch {
      // 不存在或不可访问：继续向上。
    }
    const parent = path.dirname(current);
    if (parent === current) return null; // 已到盘根/根目录
    current = parent;
  }
}

/**
 * 项目根：git 工作树根 → `.pi/octssh.json` 所在目录 → 规范化后的 cwd。
 *
 * git 优先是刻意的：仓库边界比标记文件更权威，仓库子目录里即使放了标记
 * 也不应把项目切碎。
 */
export function projectRootFromCwd(cwd: string): string {
  const top = gitToplevel(cwd);
  if (top) return normalizeProjectPath(top);
  const markerRoot = findProjectMarkerRoot(cwd);
  return normalizeProjectPath(markerRoot ?? cwd);
}

export function projectIdFromCwd(cwd: string): string {
  const root = projectRootFromCwd(cwd);
  const digest = crypto.createHash("sha256").update(root, "utf8").digest("hex");
  return `proj-v1:${digest}`;
}

/**
 * 供 UI 展示的可读路径（projectId 本身是不可逆摘要）。
 *
 * 与 id 用的规范化形式刻意分开：id 要跨平台稳定（分隔符统一、盘符小写），
 * 展示则应回到本机习惯的样子——Windows 上显示 `C:\Users\...` 而不是
 * `c:/Users/...`。realpath 顺带把盘符大小写还原成真实值。
 */
export function projectDisplayPath(cwd: string): string {
  const root = projectRootFromCwd(cwd);
  return tryRealpath(root) ?? path.normalize(root);
}
