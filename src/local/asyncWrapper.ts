import fs from "node:fs";
import { selectLocalShell, spawnShell, type LocalShellSpec } from "./shell.js";

type WrapperParams = {
  sessionId: string;
  command: string;
  sudo: boolean;
  runDir: string;
  stdoutPath: string;
  stderrPath: string;
  metaPath: string;
  pidPath: string;
  stdinPath: string;
};

function isoNow() {
  return new Date().toISOString();
}

function writeMeta(metaPath: string, meta: any) {
  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta) + "\n");
  } catch {
    void 0;
  }
}

async function sleepMs(ms: number) {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function pumpStdinFromFile(params: {
  stdinPath: string;
  childStdin: NodeJS.WritableStream | null | undefined;
  isDone: () => boolean;
}) {
  if (!params.childStdin) return;

  let offset = 0;
  while (!params.isDone()) {
    try {
      const st = fs.statSync(params.stdinPath);
      const size = st.size;
      if (size > offset) {
        const fd = fs.openSync(params.stdinPath, "r");
        try {
          while (offset < size && !params.isDone()) {
            const want = Math.min(64 * 1024, size - offset);
            const buf = Buffer.allocUnsafe(want);
            const n = fs.readSync(fd, buf, 0, want, offset);
            if (!Number.isFinite(n) || n <= 0) break;
            offset += n;
            const chunk = n === buf.length ? buf : buf.subarray(0, n);
            const ok = params.childStdin.write(chunk);
            if (!ok) {
              await new Promise<void>((resolve) => params.childStdin!.once("drain", resolve));
            }
          }
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      void 0;
    }

    await sleepMs(25);
  }
}

async function main() {
  const paramsPath = process.argv[2];
  if (!paramsPath) process.exit(2);

  let p: WrapperParams;
  try {
    p = JSON.parse(fs.readFileSync(paramsPath, "utf8"));
  } catch {
    process.exit(2);
    return;
  }

  try {
    fs.mkdirSync(p.runDir, { recursive: true });
  } catch {
    void 0;
  }

  const startedAt = isoNow();
  writeMeta(p.metaPath, { status: "running", startedAt });

  const shell: LocalShellSpec = selectLocalShell();
  if (p.sudo && shell.kind !== "sh") {
    writeMeta(p.metaPath, { status: "done", exitCode: 126, endedAt: isoNow() });
    return;
  }

  const outFd = fs.openSync(p.stdoutPath, "a");
  const errFd = fs.openSync(p.stderrPath, "a");

  const child = p.sudo
    ? spawnShell({
        shell: { kind: "sh", exe: "sudo", argsPrefix: ["-n", "--", "sh", "-lc"] },
        command: p.command,
        options: { stdio: ["pipe", outFd, errFd], windowsHide: true },
      })
    : spawnShell({
        shell,
        command: p.command,
        options: { stdio: ["pipe", outFd, errFd], windowsHide: true },
      });

  try {
    fs.writeFileSync(p.pidPath, String(child.pid ?? "") + "\n");
  } catch {
    void 0;
  }

  let done = false;
  const stdinPump = pumpStdinFromFile({
    stdinPath: p.stdinPath,
    childStdin: child.stdin,
    isDone: () => done,
  });

  const exitCode: number = await new Promise((resolve) => {
    child.on("error", () => resolve(127));
    child.on("close", (code) => resolve(Number.isFinite(code) ? (code as number) : 1));
  });

  done = true;
  try {
    child.stdin?.end();
  } catch {
    void 0;
  }
  try {
    await stdinPump;
  } catch {
    void 0;
  }

  writeMeta(p.metaPath, { status: "done", exitCode, endedAt: isoNow() });
}

main()
  .catch(() => undefined)
  .finally(() => {
    process.exit(0);
  });
