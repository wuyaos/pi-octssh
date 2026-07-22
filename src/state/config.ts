import path from "node:path";
import { z } from "zod";
import { atomicWriteFileSync, readJsonIfExistsSync } from "./fs.ts";
import { getOctsshDir } from "./paths.ts";

export const configSchema = z
  .object({
    retentionDays: z.number().int().min(1).max(365).default(7),
    maxConcurrentInit: z.number().int().min(1).max(50).default(5),
    promptThresholdHosts: z.number().int().min(1).max(10_000).default(20),
    idleTtlSeconds: z.number().int().min(1).max(3600).default(300),
    maxConnections: z.number().int().min(1).max(500).default(10),
    allowSshG: z.boolean().default(false),

    // Streamable HTTP MCP server mode (octssh serve)
    httpServer: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65535).default(8787),
        // If set, this key is used for header auth. Otherwise, `octssh serve`
        // generates a random per-start key.
        authKey: z.string().min(1).optional(),
      })
      .strict()
      .default({} as any),

    // Safety policy for command execution.
    // This is intentionally conservative: it blocks a small set of known
    // high-risk firewall/lockout commands outright and requires confirmation
    // for destructive file removals.
    security: z
      .object({
        // If `exec`/`exec-async` command matches any deny rule, it is refused.
        // Items are treated as case-insensitive regex strings.
        denyRegex: z.array(z.string()).default([]),

        // If command matches any of these executables (word boundary), it is refused.
        // Examples: ["iptables", "ufw"]
        denyExecutables: z.array(z.string()).default([]),

        // Additional patterns requiring virtual confirmation (destructive).
        // Defaults include rm -rf like operations.
        requireConfirmRegex: z.array(z.string()).default([])
      })
      .strict()
      // Allow omitting `security` entirely in config.json.
      // Missing keys will still get per-field defaults.
      .default({} as any)
  })
  .strict();

export type OctsshConfig = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: OctsshConfig = configSchema.parse({});

export function getConfigPath(baseDir?: string) {
  const root = baseDir ?? getOctsshDir();
  return path.join(root, "config.json");
}

export function loadConfig(baseDir?: string): OctsshConfig {
  const configPath = getConfigPath(baseDir);
  const json = readJsonIfExistsSync<unknown>(configPath);
  if (!json) return DEFAULT_CONFIG;

  // Merge defaults so new fields get populated.
  return configSchema.parse({ ...DEFAULT_CONFIG, ...(json as any) });
}

export function saveConfig(config: OctsshConfig, baseDir?: string) {
  const configPath = getConfigPath(baseDir);
  const normalized = configSchema.parse(config);
  atomicWriteFileSync(configPath, JSON.stringify(normalized, null, 2) + "\n");
}
