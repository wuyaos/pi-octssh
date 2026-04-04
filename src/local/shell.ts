import { spawnSync, type SpawnOptions, spawn, type ChildProcess } from "node:child_process";

export type LocalShellKind = "sh" | "pwsh" | "powershell" | "cmd";

export type LocalShellSpec = {
  kind: LocalShellKind;
  exe: string;
  argsPrefix: string[];
};

function normalizeShellEnv(raw: string | undefined): LocalShellKind | null {
  const v = (raw ?? "").trim().toLowerCase();
  if (!v) return null;
  if (v === "sh") return "sh";
  if (v === "pwsh") return "pwsh";
  if (v === "powershell" || v === "powershell.exe") return "powershell";
  if (v === "cmd" || v === "cmd.exe") return "cmd";
  return null;
}

function canSpawn(exe: string, args: string[]) {
  const res = spawnSync(exe, args, { stdio: "ignore" });
  return !res.error;
}

function hasSh() {
  return canSpawn("sh", ["-lc", "true"]);
}

function hasPwsh() {
  return canSpawn("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "1"]);
}

function hasWindowsPowerShell() {
  return canSpawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", "1"]);
}

export function selectLocalShell(): LocalShellSpec {
  const isWin = process.platform === "win32";

  const want = normalizeShellEnv(process.env.OCTSSH_SHELL);
  if (want) {
    if (want === "sh" && hasSh()) return { kind: "sh", exe: "sh", argsPrefix: ["-lc"] };
    if (want === "pwsh" && hasPwsh()) {
      return {
        kind: "pwsh",
        exe: "pwsh",
        argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      };
    }
    if (want === "powershell" && hasWindowsPowerShell()) {
      return {
        kind: "powershell",
        exe: "powershell",
        argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
      };
    }
    if (want === "cmd") {
      return { kind: "cmd", exe: "cmd.exe", argsPrefix: ["/d", "/s", "/c"] };
    }
  }

  if (!isWin) return { kind: "sh", exe: "sh", argsPrefix: ["-lc"] };

  if (hasSh()) return { kind: "sh", exe: "sh", argsPrefix: ["-lc"] };
  if (hasPwsh()) {
    return {
      kind: "pwsh",
      exe: "pwsh",
      argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  if (hasWindowsPowerShell()) {
    return {
      kind: "powershell",
      exe: "powershell",
      argsPrefix: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"],
    };
  }
  return { kind: "cmd", exe: "cmd.exe", argsPrefix: ["/d", "/s", "/c"] };
}

export function buildShellArgv(params: {
  shell: LocalShellSpec;
  command: string;
  shellArgs?: string[];
}): { exe: string; args: string[] } {
  const extra = params.shellArgs ?? [];

  if (extra.length > 0 && params.shell.kind !== "sh") {
    throw new Error(`shellArgs is only supported for sh (got ${params.shell.kind})`);
  }

  return {
    exe: params.shell.exe,
    args: [...params.shell.argsPrefix, params.command, ...extra],
  };
}

export function spawnShell(params: {
  shell: LocalShellSpec;
  command: string;
  shellArgs?: string[];
  options?: SpawnOptions;
}): ChildProcess {
  const { exe, args } = buildShellArgv({ shell: params.shell, command: params.command, shellArgs: params.shellArgs });
  return spawn(exe, args, params.options);
}
