import { splitShellWords } from "./shellwords.ts";

/** 只承认简单 argv；不尝试解释完整 shell。复杂写法仍可用完整原文授权。 */
export function simpleArgv(command: string): string[] | undefined {
  if (/[\n\r;&|<>`$\\(){}*?\[\]#]/.test(command)) return undefined;
  if (!/^(?:\s*(?:'[^']*'|"[^"]*"|[^\s'"]+))*\s*$/.test(command)) return undefined;
  const words = splitShellWords(command);
  if (!words.length || !/^[\w./-]+$/.test(words[0])) return undefined;
  return words;
}

const DOCKER_GROUPS = new Set(["container", "image", "volume", "network", "system", "compose", "builder"]);
const DOCKER_ACTIONS = new Set(["ps", "ls", "list", "logs", "inspect", "stats", "top", "version", "info", "events", "images", "port", "history", "df", "start", "stop", "restart", "kill", "rm", "rmi", "remove", "prune", "run", "exec", "create", "update", "build", "pull", "push", "up", "down", "pause", "unpause", "recreate", "cp", "tag", "rename", "attach", "config"]);
const SYSTEMCTL_ACTIONS = new Set(["status", "show", "cat", "is-active", "is-enabled", "list-units", "list-unit-files", "start", "stop", "restart", "reload", "enable", "disable", "mask", "unmask", "daemon-reload", "reset-failed"]);

export function subcommandScope(command: string): string | undefined {
  const words = simpleArgv(command);
  if (!words) return undefined;
  if (words.some((word) => /^(--context|--host|--config|--root|--machine|--user|--system)(=|$)|^-[HMc]/.test(word))) return undefined;
  if (words[0] === "docker") {
    const depth = DOCKER_GROUPS.has(words[1]) ? 3 : 2;
    if (!DOCKER_ACTIONS.has(words[depth - 1])) return undefined;
    return words.slice(0, depth).join(" ");
  }
  if (words[0] === "systemctl" && SYSTEMCTL_ACTIONS.has(words[1])) return words.slice(0, 2).join(" ");
  return undefined;
}

export function matchesSubcommand(pattern: string, command: string): boolean {
  return subcommandScope(command) === pattern && subcommandScope(pattern) === pattern;
}

export function firewallQuery(command: string): boolean {
  const words = simpleArgv(command);
  if (!words) return false;
  const [exe, ...args] = words;
  if (exe === "ufw") return /^(status( verbose| numbered)?|show (raw|added|listening|builtins|before-rules|user-rules|after-rules))$/.test(args.join(" "));
  if (exe === "nft") return args.join(" ") === "list ruleset";
  if (exe === "firewall-cmd") return args.length === 1 && ["--state", "--list-all", "--list-all-zones", "--get-active-zones", "--get-default-zone", "--get-zones"].includes(args[0]);
  if (exe === "iptables" || exe === "ip6tables") return /^(-L|-S|--list|--list-rules)( [A-Za-z0-9_-]+)?( -(n|v|nv|vn|x))*$/.test(args.join(" "));
  return false;
}

const EXECUTION_WRAPPERS = new Set([
  "sh", "bash", "dash", "zsh", "ksh", "fish", "csh", "tcsh",
  "env", "nohup", "nice", "timeout", "stdbuf", "xargs", "exec", "command",
  "busybox", "toybox", "watch", "setsid", "ionice", "taskset", "strace", "script", "chroot", "setpriv",
]);

/** 仅识别明确无本地写入、无修改请求选项的 curl；未知参数不猜测。 */
function curlQuery(args: string[]): boolean {
  const flags = new Set(["--silent", "--show-error", "--fail", "--location", "--head", "--include", "--verbose", "--insecure", "--compressed", "--ipv4", "--ipv6", "--version", "--help", "--disable"]);
  const values = new Set(["--connect-timeout", "--max-time", "--retry", "--retry-delay", "--user-agent", "--header", "--url"]);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") return args.slice(i + 1).every((url) => /^https?:\/\//i.test(url));
    if (/^https?:\/\//i.test(arg)) continue;
    if (flags.has(arg)) continue;
    if (arg.startsWith("--")) {
      const equal = arg.indexOf("=");
      const name = equal < 0 ? arg : arg.slice(0, equal);
      if (name === "--request") {
        const method = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (method !== "GET" && method !== "HEAD") return false;
      } else if (values.has(name)) {
        const value = equal < 0 ? args[++i] : arg.slice(equal + 1);
        if (!value || value.startsWith("@")) return false;
        if (name === "--url" && !/^https?:\/\//i.test(value)) return false;
      } else return false;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-") return false;
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if ("fsSLIivk46q".includes(flag)) continue;
      if (!"mAHX".includes(flag)) return false;
      const value = arg.slice(j + 1) || args[++i];
      if (!value || value.startsWith("@")) return false;
      if (flag === "X" && value !== "GET" && value !== "HEAD") return false;
      break;
    }
  }
  return true;
}

export function commandRisk(command: string, sudo: boolean): string | undefined {
  if (sudo) return "使用管理员权限";
  const words = simpleArgv(command);
  if (!words) return "复杂 shell 命令，请核对完整内容";
  const exe = words[0].split("/").pop()!;
  if (EXECUTION_WRAPPERS.has(exe)) return "包装命令可能执行其他操作，请核对。";
  if (exe === "curl" && !curlQuery(words.slice(1))) return "curl 包含写入、修改请求或未识别参数。";
  if (exe === "wget" && !(words.length === 2 && ["--help", "--version"].includes(words[1]))) return "wget 可能写入文件或发送修改请求。";
  if (["rm", "rmdir", "chmod", "chown", "chgrp", "reboot", "shutdown", "poweroff", "halt", "mount", "umount", "mkfs", "wipefs", "dd", "truncate", "kill", "killall", "pkill"].includes(exe) || exe.startsWith("mkfs.")) return "删除、修改系统状态或权限";
  if (exe === "docker") {
    if (words.some((word) => /^(--output|-o)(=|$)/.test(word))) return "命令将写入文件";
    const scope = subcommandScope(command);
    const action = scope?.split(" ").at(-1);
    if (!action || !["ps", "ls", "list", "logs", "inspect", "stats", "top", "version", "info", "events", "images", "port", "history", "df", "config"].includes(action)) return "修改容器、镜像或运行环境";
  }
  if (exe === "systemctl" && !["status", "show", "cat", "is-active", "is-enabled", "list-units", "list-unit-files"].includes(words[1])) return "修改系统服务";
  if (exe === "service" && words[2] !== "status") return "修改系统服务";
  if (["apt", "apt-get", "yum", "dnf", "apk", "pacman"].includes(exe) && !["list", "search", "show", "info", "policy"].includes(words[1])) return "修改系统软件";
  return undefined;
}
