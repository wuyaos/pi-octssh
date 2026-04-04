import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { splitShellWords } from "./shellwords.js";
import { createPending, deletePending, loadPending } from "../state/pending.js";
import { getOctsshDir } from "../state/paths.js";

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

const BUILTIN_DENY_EXECUTABLES: string[] = ["iptables", "ufw", "nft", "firewall-cmd"];

const BUILTIN_CONFIRM_REGEX: string[] = [
  // (Fallback) Any rm with -r/-R in the flag cluster.
  "\\brm\\b\\s+-\\S*[rR]\\S*",
  // Any rm --recursive
  "\\brm\\b\\s+--recursive\\b",
];

export type CommandGuardResult =
  | { action: "allow" }
  | { action: "block"; reason: string; message: string }
  | {
      action: "confirm";
      confirm_code: string;
      message: string;
      preview: { type: string; total: number; truncated: boolean; sample: string[] };
    };

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

function isSudoInvocation(command: string) {
  return /(^|[\s;&|()])sudo(\s|$)/i.test(command);
}

function extractRmTargets(command: string) {
  const words = splitShellWords(command);
  if (words.length === 0) return null;
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
    if (w.includes("r") || w.includes("R")) return true;
  }
  return false;
}

function isClearlyDangerousRootDelete(targets: string[]) {
  for (const t of targets) {
    if (t === "/" || t === "/*" || t.startsWith("/ --")) return true;
  }
  return false;
}

async function previewDeletePathsLocal(targets: string[]) {
  const home = os.homedir();
  const normalized = targets.map((t) => {
    const raw = t.trim();
    if (raw === "$HOME" || raw === "${HOME}") return home;
    if (raw.startsWith("$HOME/")) return `${home}/${raw.slice("$HOME/".length)}`;
    if (raw.startsWith("${HOME}/")) return `${home}/${raw.slice("${HOME}/".length)}`;
    if (raw === "~") return home;
    if (raw.startsWith("~/")) return `${home}/${raw.slice(2)}`;
    return raw;
  });

  const limit = 10001;
  const sampleLimit = 10;
  const sample: string[] = [];
  let total = 0;
  let truncated = false;

  const push = (p: string) => {
    total += 1;
    if (sample.length < sampleLimit) sample.push(p);
    if (total >= limit) truncated = true;
  };

  const walk = (root: string) => {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const p = stack.pop();
      if (!p) continue;
      if (truncated) return;

      push(p);

      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }

      if (st.isSymbolicLink()) continue;
      if (!st.isDirectory()) continue;

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(p, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const ent of entries) {
        if (truncated) return;
        const child = path.join(p, ent.name);
        stack.push(child);
      }
    }
  };

  for (const p of normalized) {
    if (truncated) break;
    try {
      if (!fs.existsSync(p)) continue;
    } catch {
      continue;
    }
    walk(p);
  }

  return { type: "rm-preview", total, truncated, sample };
}

export async function guardLocalCommand(params: {
  machine: string;
  command: string;
  allowSudo: boolean;
  confirm_code?: string;
  security: SecurityConfig;
}): Promise<CommandGuardResult> {
  const effective = buildEffectiveSecurityConfig(params.security);

  if (!params.allowSudo && isSudoInvocation(params.command)) {
    return {
      action: "block",
      reason: "sudo_not_allowed",
      message:
        "This tool does not allow sudo. Use `sudo-exec` / `exec-async-sudo` instead (passwordless sudo only).",
    };
  }

  for (const exe of effective.denyExecutables) {
    if (matchesExecutable(params.command, exe)) {
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

  const needConfirm = isRecursiveRm(params.command) || !!matchesAnyRegex(params.command, effective.requireConfirmRegex);
  if (!needConfirm) return { action: "allow" };

  if (params.confirm_code) {
    const rec = loadPending(params.confirm_code, getOctsshDir());
    if (!rec || rec.kind !== "exec") {
      return {
        action: "block",
        reason: "invalid_confirm_code",
        message: "Invalid confirm code. Re-run the command without confirm_code to get a new preview.",
      };
    }
    if (rec.machine !== params.machine || rec.command !== params.command) {
      return {
        action: "block",
        reason: "confirm_mismatch",
        message: "Confirm code does not match this command/machine. Re-run without confirm_code to preview again.",
      };
    }
    deletePending(params.confirm_code, getOctsshDir());
    return { action: "allow" };
  }

  const targets = extractRmTargets(params.command) ?? [];
  if (targets.length === 0) {
    return {
      action: "block",
      reason: "requires_confirm_no_preview",
      message:
        "Destructive command requires confirmation but preview is not available for this syntax. Rewrite the command into an explicit `rm -r <path>` form.",
    };
  }
  if (isClearlyDangerousRootDelete(targets)) {
    return {
      action: "block",
      reason: "root_delete_blocked",
      message: "Refusing to run: this appears to delete root filesystem.",
    };
  }

  const preview = await previewDeletePathsLocal(targets);
  const code = createPending(
    {
      kind: "exec",
      createdAt: new Date().toISOString(),
      machine: params.machine,
      command: params.command,
      preview,
    },
    getOctsshDir()
  );

  const msg =
    "DANGEROUS OPERATION DETECTED.\n" +
    "This command can permanently delete files. OctSSH is running in VIRTUAL MODE and refused to execute it.\n" +
    `Previewed ${preview.total}${preview.truncated ? "+" : ""} affected paths.\n` +
    "If you are 100% sure, re-run the SAME command with confirm_code.\n" +
    "Before confirming: enumerate the listed paths and explain WHY each is safe to delete.";

  return { action: "confirm", confirm_code: code, message: msg, preview };
}
