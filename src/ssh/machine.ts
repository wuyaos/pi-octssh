import os from "node:os";
import fs from "node:fs";
import { loadConfig } from "../state/config.ts";
import { getOctsshDir } from "../state/paths.ts";
import { resolveHostConfig } from "./config/resolve.ts";
import { loadFirstPrivateKey } from "./connect.ts";
import type { SshClientParams } from "./connect.ts";
import type { SshIdentity } from "../security/identity.ts";

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


/** Windows 上 OpenSSH agent 的唯一可靠地址（命名管道）。 */
export const WINDOWS_OPENSSH_AGENT_PIPE = "\\\\.\\pipe\\openssh-ssh-agent";

/**
 * 解析 ssh-agent 地址。
 *
 * ssh2 的 `agent` 要的是**地址**（Unix socket 路径，或 Windows 上的命名管道 /
 * 字面量 `"pageant"`），不是 PID。此前把 `SSH_AGENT_PID` 直接传进去，等于让
 * ssh2 去连一个叫 "12345" 的 socket——只要该变量存在，agent 认证必然失败。
 *
 * 因此这里只认可用的地址：
 * - Windows：OpenSSH agent 的命名管道（存在才用）。Git Bash/MSYS 的
 *   `SSH_AUTH_SOCK` 是虚拟路径，Node 连不上，忽略；Pageant 需要显式配置，
 *   不做自动探测（探测不到就传 `"pageant"` 会让不装 Pageant 的机器认证失败）。
 * - 其它平台：`SSH_AUTH_SOCK`。
 */
export function resolveAgentAddress(params: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
} = {}): string | undefined {
  const platform = params.platform ?? process.platform;
  const env = params.env ?? process.env;
  const exists = params.exists ?? ((p: string) => { try { return fs.existsSync(p); } catch { return false; } });
  if (platform === "win32") {
    return exists(WINDOWS_OPENSSH_AGENT_PIPE) ? WINDOWS_OPENSSH_AGENT_PIPE : undefined;
  }
  const sock = env.SSH_AUTH_SOCK;
  return sock ? sock : undefined;
}
export function planMachineConnection(machine: string) {
  const cfg = loadConfig(getOctsshDir());

  const resolved = resolveHostConfig(machine, { allowSshG: cfg.allowSshG });
  const warnings = [...resolved.warnings];

  const host = resolved.hostName ?? machine;
  const port = resolved.port ?? 22;
  const username = resolved.user ?? defaultUsername();

  const agent = resolveAgentAddress();
  const privateKey = loadFirstPrivateKey(resolved.identityFiles);

  if (!agent && !privateKey) {
    // 纯密码主机（例如只配了 User/HostName 的条目）会命中这里，但它并不代表
    // 连接会失败——密码认证照样能用。措辞必须中性，否则用户会以为出错了。
    warnings.push(
      process.platform === "win32"
        ? "No SSH agent (SSH_AUTH_SOCK/pageant) or readable IdentityFile; will use password or key passphrase if the host offers it."
        : "No SSH agent (SSH_AUTH_SOCK) or readable IdentityFile; will use password or key passphrase if the host offers it.",
    );
  }

  const target: SshClientParams & { host: string; port: number } = {
    host,
    port,
    username,
    agent,
    privateKey,
    ...(resolved.serverAliveInterval !== undefined ? { keepaliveIntervalMs: resolved.serverAliveInterval * 1000 } : {}),
    ...(resolved.serverAliveCountMax !== undefined ? { keepaliveCountMax: resolved.serverAliveCountMax } : {}),
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
    ...(jumpResolved.serverAliveInterval !== undefined ? { keepaliveIntervalMs: jumpResolved.serverAliveInterval * 1000 } : {}),
    ...(jumpResolved.serverAliveCountMax !== undefined ? { keepaliveCountMax: jumpResolved.serverAliveCountMax } : {}),
  };

  return { target, jump, warnings } satisfies MachineConnectPlan;
}

/**
 * 从连接计划推导身份，不建立任何连接。
 *
 * 复用 `planMachineConnection` 的解析结果（含 ssh_config 的 HostName/User/Port
 * 与跳板推导），但只返回纯数据，供信任表与授权摘要使用。
 */
export function resolveIdentity(machine: string): SshIdentity {
  const plan = planMachineConnection(machine);
  const identity: SshIdentity = {
    alias: machine,
    host: plan.target.host,
    port: plan.target.port,
    user: plan.target.username,
  };
  if (plan.jump) {
    identity.jump = { host: plan.jump.host, port: plan.jump.port, user: plan.jump.username };
  }
  return identity;
}
