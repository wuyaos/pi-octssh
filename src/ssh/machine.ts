import os from "node:os";
import { loadConfig } from "../state/config.ts";
import { getOctsshDir } from "../state/paths.ts";
import { resolveHostConfig } from "./config/resolve.ts";
import { loadFirstPrivateKey } from "./connect.ts";
import type { SshClientParams } from "./connect.ts";

export type ProxyJumpSpec = {
  host: string;
  user?: string;
  port?: number;
};

export function parseProxyJump(raw: string): ProxyJumpSpec {
  // v1: single hop only. If multiple are provided, we take the first.
  const first = raw.split(",")[0]?.trim();
  if (!first) throw new Error("ProxyJump is empty");

  // Parse [user@]host[:port]
  let user: string | undefined;
  let rest = first;
  const at = rest.indexOf("@");
  if (at !== -1) {
    user = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }

  let host = rest;
  let port: number | undefined;

  // Basic support for host:port.
  const colon = rest.lastIndexOf(":");
  if (colon !== -1) {
    const maybePort = rest.slice(colon + 1);
    const n = Number(maybePort);
    if (Number.isFinite(n) && n > 0) {
      host = rest.slice(0, colon);
      port = n;
    }
  }

  return { host, user, port };
}

function defaultUsername() {
  try {
    return os.userInfo().username;
  } catch {
    return "root";
  }
}

export type MachineConnectPlan = {
  target: SshClientParams & { host: string; port: number };
  jump?: (SshClientParams & { host: string; port: number });
  warnings: string[];
};

export function planMachineConnection(machine: string) {
  const cfg = loadConfig(getOctsshDir());

  const resolved = resolveHostConfig(machine, { allowSshG: cfg.allowSshG });
  const warnings = [...resolved.warnings];

  const host = resolved.hostName ?? machine;
  const port = resolved.port ?? 22;
  const username = resolved.user ?? defaultUsername();

  // Windows 原生 OpenSSH 使用 pageant/named pipe,通常不设 SSH_AUTH_SOCK。
  // Git Bash / WSL 下仍可能有 SSH_AUTH_SOCK。
  const agent =
    process.env.SSH_AUTH_SOCK ||
    (process.platform === "win32" ? process.env.SSH_AGENT_PID : undefined);
  const privateKey = loadFirstPrivateKey(resolved.identityFiles);

  if (!agent && !privateKey) {
    warnings.push(
      process.platform === "win32"
        ? "No SSH agent (SSH_AUTH_SOCK/pageant) and no readable IdentityFile found; connection may fail."
        : "No SSH agent (SSH_AUTH_SOCK) and no readable IdentityFile found; connection may fail."
    );
  }

  const target: SshClientParams & { host: string; port: number } = {
    host,
    port,
    username,
    agent,
    privateKey,
  };

  if (!resolved.proxyJump) {
    return { target, warnings } satisfies MachineConnectPlan;
  }

  const pj = parseProxyJump(resolved.proxyJump);
  const jumpResolved = resolveHostConfig(pj.host, { allowSshG: cfg.allowSshG });
  warnings.push(...jumpResolved.warnings.map((w) => `jump: ${w}`));

  const jumpHost = jumpResolved.hostName ?? pj.host;
  const jumpPort = pj.port ?? jumpResolved.port ?? 22;
  const jumpUser = pj.user ?? jumpResolved.user ?? defaultUsername();
  const jumpKey = loadFirstPrivateKey(jumpResolved.identityFiles);

  const jump: SshClientParams & { host: string; port: number } = {
    host: jumpHost,
    port: jumpPort,
    username: jumpUser,
    agent,
    privateKey: jumpKey,
  };

  return { target, jump, warnings } satisfies MachineConnectPlan;
}
