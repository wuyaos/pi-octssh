import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import fg from "fast-glob";

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}
import { getSshConfigPath } from "./paths.ts";

function stripComments(line: string) {
  const idx = line.indexOf("#");
  if (idx === -1) return line;
  return line.slice(0, idx);
}

function isConcreteHostAlias(token: string) {
  // v1: only list concrete aliases. Anything with glob syntax or negation is treated as pattern.
  // OpenSSH patterns include: '*', '?', and negation '!' prefixes.
  if (!token) return false;
  if (token.includes("*") || token.includes("?") || token.startsWith("!")) return false;
  return true;
}

function expandIncludePattern(pattern: string, baseDir: string) {
  // OpenSSH's Include supports globs. We intentionally do not implement full ssh_config semantics,
  // but we do expand globs to discover host aliases.
  const p = pattern.startsWith("~")
    ? path.join(homeDir(), pattern.slice(1))
    : pattern;
  const abs = path.isAbsolute(p) ? p : path.join(baseDir, p);
  return fg.sync(abs, { dot: true, onlyFiles: true, unique: true });
}

function readFileLines(filePath: string) {
  const raw = fs.readFileSync(filePath, "utf8");
  return raw.split(/\r?\n/);
}

export type HostDiscoveryOptions = {
  configPath?: string;
};

export function discoverHostAliases(options: HostDiscoveryOptions = {}) {
  const entry = options.configPath ?? getSshConfigPath();
  const visited = new Set<string>();
  const aliases = new Set<string>();

  const queue: string[] = [entry];
  while (queue.length) {
    const p = queue.shift()!;
    if (visited.has(p)) continue;
    visited.add(p);

    if (!fs.existsSync(p)) continue;
    const baseDir = path.dirname(p);

    for (const rawLine of readFileLines(p)) {
      const line = stripComments(rawLine).trim();
      if (!line) continue;

      const parts = line.split(/\s+/);
      const key = parts[0]?.toLowerCase();

      if (key === "include") {
        // Support multiple patterns on one line.
        for (const inc of parts.slice(1)) {
          for (const incPath of expandIncludePattern(inc, baseDir)) {
            queue.push(incPath);
          }
        }
      }

      if (key === "host") {
        for (const token of parts.slice(1)) {
          if (isConcreteHostAlias(token)) aliases.add(token);
        }
      }
    }
  }

  return Array.from(aliases).sort((a, b) => a.localeCompare(b));
}
