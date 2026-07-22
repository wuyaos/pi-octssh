import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import fg from "fast-glob";
import { getSshConfigPath } from "./paths.ts";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export type ResolvedSshHostConfig = {
  alias: string;
  hostName?: string;
  user?: string;
  port?: number;
  identityFiles: string[];
  proxyJump?: string;
  serverAliveInterval?: number;
  serverAliveCountMax?: number;
  warnings: string[];
};

function stripComments(line: string) {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

function globToRegExp(glob: string) {
  // Very small glob subset compatible with ssh_config Host patterns.
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

function hostMatchesPatterns(host: string, patterns: string[]) {
  const positives: string[] = [];
  const negatives: string[] = [];
  for (const p of patterns) {
    if (p.startsWith("!")) negatives.push(p.slice(1));
    else positives.push(p);
  }

  const pos = positives.length
    ? positives.some((p) => globToRegExp(p).test(host))
    : false;
  if (!pos) return false;

  const neg = negatives.some((p) => globToRegExp(p).test(host));
  return !neg;
}

function expandIncludePattern(pattern: string, baseDir: string) {
  const p = pattern.startsWith("~")
    ? path.join(homeDir(), pattern.slice(1))
    : pattern;
  const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);

  const matches = fg.sync(abs, { dot: true, onlyFiles: true, unique: true });
  matches.sort();
  return matches;
}

function readConfigLinesWithInclude(configPath: string, visited = new Set<string>()) {
  const out: string[] = [];
  if (visited.has(configPath)) return out;
  visited.add(configPath);

  if (!fs.existsSync(configPath)) return out;
  const baseDir = path.dirname(configPath);
  const raw = fs.readFileSync(configPath, "utf8");
  const lines = raw.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = stripComments(rawLine).trim();
    if (!line) continue;

    const parts = line.split(/\s+/);
    const key = parts[0]?.toLowerCase();
    if (key === "include") {
      for (const inc of parts.slice(1)) {
        for (const incPath of expandIncludePattern(inc, baseDir)) {
          out.push(...readConfigLinesWithInclude(incPath, visited));
        }
      }
      continue;
    }

    out.push(line);
  }

  return out;
}

function resolveStatically(alias: string, configPath: string): ResolvedSshHostConfig {
  const warnings: string[] = [];
  const out: ResolvedSshHostConfig = {
    alias,
    identityFiles: [],
    warnings,
  };

  // OpenSSH processes files top-to-bottom. For most options, the first value wins.
  // We implement a small subset.
  let activePatterns: string[] = ["*"]; // global section

  const lines = readConfigLinesWithInclude(configPath);
  for (const line of lines) {
    const parts = line.split(/\s+/);
    const key = parts[0]?.toLowerCase();
    const value = parts.slice(1).join(" ").trim();
    if (!key) continue;

    if (key === "host") {
      activePatterns = parts.slice(1);
      continue;
    }

    if (!hostMatchesPatterns(alias, activePatterns)) continue;

    switch (key) {
      case "hostname":
        if (!out.hostName && value) out.hostName = value;
        break;
      case "user":
        if (!out.user && value) out.user = value;
        break;
      case "port":
        if (!out.port && value) {
          const n = Number(value);
          if (Number.isFinite(n) && n > 0) out.port = n;
        }
        break;
      case "identityfile":
        // OpenSSH allows multiple IdentityFile entries; preserve order.
        if (value) out.identityFiles.push(value);
        break;
      case "proxyjump":
        if (!out.proxyJump && value) out.proxyJump = value;
        break;
      case "serveraliveinterval":
        if (!out.serverAliveInterval && value) {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) out.serverAliveInterval = n;
        }
        break;
      case "serveralivecountmax":
        if (!out.serverAliveCountMax && value) {
          const n = Number(value);
          if (Number.isFinite(n) && n >= 0) out.serverAliveCountMax = n;
        }
        break;

      case "proxycommand":
        warnings.push(
          "ProxyCommand is not supported by OctSSH (ProxyJump only)."
        );
        break;

      case "localcommand":
        warnings.push("LocalCommand is ignored by OctSSH.");
        break;
    }
  }

  return out;
}

function resolveWithSshG(alias: string): ResolvedSshHostConfig {
  // WARNING: OpenSSH may evaluate dynamic config (e.g. Match exec) when computing -G.
  const warnings: string[] = [
    "Resolved using `ssh -G`. This may execute dynamic ssh_config directives (e.g. Match exec).",
  ];

  const out: ResolvedSshHostConfig = {
    alias,
    identityFiles: [],
    warnings,
  };

  const text = execFileSync("ssh", ["-G", alias], { encoding: "utf8" });
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const sp = line.split(/\s+/);
    const key = sp[0]?.toLowerCase();
    const value = sp.slice(1).join(" ");
    if (!key) continue;

    switch (key) {
      case "hostname":
        out.hostName = value;
        break;
      case "user":
        out.user = value;
        break;
      case "port": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) out.port = n;
        break;
      }
      case "identityfile":
        if (value) out.identityFiles.push(value);
        break;
      case "proxyjump":
        out.proxyJump = value;
        break;
      case "serveraliveinterval": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) out.serverAliveInterval = n;
        break;
      }
      case "serveralivecountmax": {
        const n = Number(value);
        if (Number.isFinite(n) && n >= 0) out.serverAliveCountMax = n;
        break;
      }
    }
  }

  return out;
}

export type ResolveOptions = {
  configPath?: string;
  allowSshG?: boolean;
};

export function resolveHostConfig(alias: string, options: ResolveOptions = {}) {
  const configPath = options.configPath ?? getSshConfigPath();
  if (options.allowSshG) {
    try {
      return resolveWithSshG(alias);
    } catch (err: any) {
      // Fall back to static parsing on failure (ssh binary missing, etc).
      const out = resolveStatically(alias, configPath);
      out.warnings.push(
        `Failed to run ssh -G (${String(err?.message ?? err)}); used static resolution instead.`
      );
      return out;
    }
  }

  return resolveStatically(alias, configPath);
}
