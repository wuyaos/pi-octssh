import type { Client } from "ssh2";
import { runCommand } from "../ssh/runCommand.ts";
import { wrapSh } from "../ssh/shell.ts";
import { splitShellWords } from "./shellwords.ts";
import { commandRisk, firewallQuery, simpleArgv } from "./commandShape.ts";

export type SecurityConfig = {
  denyRegex: string[];
  denyExecutables: string[];
  requireConfirmRegex: string[];
};

const BUILTIN_DENY_REGEX: string[] = [
  // Firewall / lockout risk
  "\\bufw\\s+disable\\b",
  "\\bsystemctl\\s+(stop|disable)\\s+(ufw|firewalld)\\b",
  "\\biptables\\b.*\\b(-P\\s+INPUT\\s+ACCEPT|-P\\s+INPUT\\s+DROP|-F\\b|-X\\b)\\b",
  "\\bnft\\s+flush\\s+ruleset\\b",
  // Common 'open everything' patterns
  "\\bfirewall-cmd\\b.*--add-port\\s*=?\\s*1-65535/(tcp|udp)\\b",
  // Device wipe / formatting
  "\\bdd\\b.*\\bof=/dev/(sd[a-z]|nvme\\d+n\\d+)\\b",
  "\\bmkfs\\.[a-z0-9]+\\s+/dev/",
  // Fork bomb
  ":\\(\\)\\s*\\{\\s*:\\s*\\|\\s*:\\s*&\\s*\\}\\s*;\\s*:\\s*",
];

const BUILTIN_DENY_EXECUTABLES: string[] = [
  // Broad deny list for tools commonly used to lock yourself out.
  "iptables",
  "ufw",
  "nft",
  "firewall-cmd",
];

const BUILTIN_CONFIRM_REGEX: string[] = [
  // (Fallback) Any rm with -r/-R in the flag cluster.
  "\\brm\\b\\s+-\\S*[rR]\\S*",
  // Any rm --recursive
  "\\brm\\b\\s+--recursive\\b",
];

const homeCache = new WeakMap<object, string>();

async function getRemoteHome(client: Client, signal?: AbortSignal) {
  const cached = homeCache.get(client as any);
  if (cached) return cached;
  const res = await runCommand(client, wrapSh('printf %s "$HOME"'), {
    maxStdoutBytes: 4096,
    maxStderrBytes: 4096,
    signal,
    timeoutMs: 10_000,
  });
  const home = res.stdout.trim();
  if (!home.startsWith('/')) throw new Error(`Failed to resolve remote $HOME (got: ${home})`);
  homeCache.set(client as any, home);
  return home;
}

export function buildEffectiveSecurityConfig(user: SecurityConfig) {
  return {
    denyRegex: [...BUILTIN_DENY_REGEX, ...(user.denyRegex ?? [])],
    denyExecutables: [...BUILTIN_DENY_EXECUTABLES, ...(user.denyExecutables ?? [])],
    requireConfirmRegex: [...BUILTIN_CONFIRM_REGEX, ...(user.requireConfirmRegex ?? [])],
  } satisfies SecurityConfig;
}

function tryRegex(pattern: string) {
  try {
    return new RegExp(pattern, "i");
  } catch {
    return null;
  }
}

function matchesAnyRegex(command: string, patterns: string[]) {
  for (const p of patterns) {
    const re = tryRegex(p);
    if (!re) continue;
    if (re.test(command)) return p;
  }
  return null;
}

function matchesExecutable(command: string, exe: string) {
  const escaped = exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|[\\s;&|()])(?:sudo\\s+)?(?:\\S*/)?${escaped}\\b`, "i");
  return re.test(command);
}

export type CommandGuardResult =
  | { action: "allow" }
  | { action: "block"; reason: string; message: string }
  | {
      action: "needs_confirmation";
      message: string;
      preview: { type: string; total: number; truncated: boolean; sample: string[] };
    };

function isSudoInvocation(command: string) {
  // Conservative: if the command contains `sudo` as a word, treat as sudo usage.
  return /(^|[\s;&|()])sudo(\s|$)/i.test(command);
}

function extractRmTargets(command: string) {
  const words = splitShellWords(command);
  if (words.length === 0) return null;

  // Only handle simple "rm ..." in the first command segment.
  // If the user is chaining commands, we still want to block/confirm, but
  // preview is only supported for the rm targets we can parse.
  const rmIndex = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
  if (rmIndex === -1) return null;

  const after = words.slice(rmIndex + 1);
  const targets: string[] = [];
  for (const w of after) {
    if (w === "--") continue;
    if (w.startsWith("-")) continue;
    targets.push(w);
  }
  return targets.length ? targets : null;
}

function isRecursiveRm(command: string) {
  const words = splitShellWords(command);
  const rmIndex = words.findIndex((w) => w === "rm" || w.endsWith("/rm"));
  if (rmIndex === -1) return false;

  for (const w of words.slice(rmIndex + 1)) {
    if (w === "--") break;
    if (w === "--recursive") return true;
    if (!w.startsWith("-")) break;
    // flags like -rf, -r, -R
    if (w.includes("r") || w.includes("R")) return true;
  }
  return false;
}

function isClearlyDangerousRootDelete(targets: string[]) {
  // Hard block obvious catastrophic cases.
  for (const t of targets) {
    if (t === "/" || t === "/*" || t.startsWith("/ --")) return true;
    if (t.startsWith("/etc") || t.startsWith("/bin") || t.startsWith("/usr")) {
      // still allow preview+confirm (not hard-block) unless it's exactly root.
      continue;
    }
  }
  return false;
}

async function previewDeletePaths(client: Client, targets: string[], signal?: AbortSignal) {
  // Bounded preview: collect up to 10001 paths total, then truncate.
  // This avoids remote CPU/disk meltdown on huge trees.
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const home = await getRemoteHome(client, signal);
  const normalized = targets.map((t) => {
    const raw = t.trim();
    // Expand common home-variable forms so previews work for commands like:
    // rm -rf "$HOME/\$HOME" (delete literal "$HOME" dir inside home)
    if (raw === "$HOME" || raw === "${HOME}") return home;
    if (raw.startsWith("$HOME/")) return `${home}/${raw.slice("$HOME/".length)}`;
    if (raw.startsWith("${HOME}/")) return `${home}/${raw.slice("${HOME}/".length)}`;
    if (raw === "~") return home;
    if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
    return raw;
  });
  const args = normalized.map((t) => q(t)).join(" ");

  const script = [
    "set -eu",
    "limit=10001",
    // Print up to 10 sample lines, plus bounded total and truncated markers.
    "(for p in \"$@\"; do if [ -e \"$p\" ]; then find \"$p\" -print 2>/dev/null; fi; done)" +
      " | head -n $limit" +
      " | awk -v limit=$limit 'NR<=10{print} END{print \"__OCTSSH_TOTAL__:\" NR; print \"__OCTSSH_TRUNCATED__:\" (NR>=limit?\"true\":\"false\")}'",
  ].join("; ");

  const cmd = `sh -lc ${q(script)} sh ${args}`;
  const res = await runCommand(client, cmd, {
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 8 * 1024,
    signal,
  });
  const lines = res.stdout.split(/\r?\n/).filter(Boolean);
  const sample: string[] = [];
  let total = 0;
  let truncated = false;
  for (const l of lines) {
    if (l.startsWith("__OCTSSH_TOTAL__:")) {
      total = Number(l.split(":")[1] ?? 0) || 0;
      continue;
    }
    if (l.startsWith("__OCTSSH_TRUNCATED__:")) {
      truncated = (l.split(":")[1] ?? "").trim() === "true";
      continue;
    }
    sample.push(l);
  }
  return { type: "rm-preview", total, truncated, sample };
}

export async function guardExecCommand(params: {
  client: Client;
  machine: string;
  command: string;
  allowSudo: boolean;
  security: SecurityConfig;
  authorized?: boolean;
  signal?: AbortSignal;
}) : Promise<CommandGuardResult> {
  const effective = buildEffectiveSecurityConfig(params.security);

  if (!params.allowSudo && isSudoInvocation(params.command)) {
    return {
      action: "block",
      reason: "sudo_not_allowed",
      message:
        "This tool does not allow sudo. Use `sudo-exec` / `exec-async-sudo` instead (passwordless sudo only).",
    };
  }

  const query = firewallQuery(params.command);
  for (const exe of effective.denyExecutables) {
    if (matchesExecutable(params.command, exe) && !(query && BUILTIN_DENY_EXECUTABLES.includes(exe) && !params.security.denyExecutables.includes(exe))) {
      return {
        action: "block",
        reason: "blocked_executable",
        message: `Blocked high-risk executable: ${exe}`,
      };
    }
  }

  const deny = matchesAnyRegex(params.command, effective.denyRegex);
  if (deny) {
    return {
      action: "block",
      reason: "blocked_pattern",
      message: `Blocked by security policy pattern: ${deny}`,
    };
  }

  const targets = extractRmTargets(params.command) ?? [];
  // 硬禁止必须先于一次性授权；授权不能绕过根目录保护。
  if (isRecursiveRm(params.command) && isClearlyDangerousRootDelete(targets)) {
    return { action: "block", reason: "root_delete_blocked", message: "禁止删除根文件系统。" };
  }
  const risk = commandRisk(params.command, params.allowSudo);
  const configured = matchesAnyRegex(params.command, effective.requireConfirmRegex);
  if (!risk && !configured) return { action: "allow" };
  if (params.authorized) return { action: "allow" };
  if (!isRecursiveRm(params.command) || !simpleArgv(params.command) || targets.length === 0) {
    return { action: "needs_confirmation", message: risk ?? "配置要求确认。",
      preview: { type: "command-risk", total: 1, truncated: false, sample: [params.command] } };
  }
  const preview = await previewDeletePaths(params.client, targets, params.signal);

  const msg = `递归删除将影响 ${preview.total}${preview.truncated ? "+" : ""} 个路径，请核对。`;
  return { action: "needs_confirmation", message: msg, preview };
}
