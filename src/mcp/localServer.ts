import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { loadConfig } from "../state/config.js";
import { getOctsshDir } from "../state/paths.js";
import { guardLocalCommand } from "../security/localPolicy.js";
import { runLocalCommand } from "../local/runLocalCommand.js";
import { startLocalAsync } from "../local/asyncProcess.js";
import { loadSession, saveSession } from "../state/sessions.js";
import { findExpiredSessions, deleteSessionFile } from "../state/cleanup.js";

type ToolResult = {
  ok: boolean;
  tool: string;
  error?: string;
  data?: unknown;
};

function respond(result: ToolResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function isoNow() {
  return new Date().toISOString();
}

function tailLocalFile(filePath: string, lines: number) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parts = raw.split(/\r?\n/);
    const tail = parts.slice(Math.max(0, parts.length - lines)).filter(Boolean);
    return tail.join("\n");
  } catch {
    return "";
  }
}

function normalizeToolPrefix(raw: string | undefined) {
  const v = (raw ?? "").trim();
  if (!v) return "";
  return v.endsWith("_") ? v : `${v}_`;
}

function sleepMs(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

let localCleanupStarted = false;

function ensureLocalCleanupStarted() {
  if (localCleanupStarted) return;
  localCleanupStarted = true;

  // TTL cleanup for local async sessions.
  // Keep it best-effort and lightweight; this runs in a long-lived serve process.
  setInterval(() => {
    try {
      const currentCfg = loadConfig(getOctsshDir());
      const expired = findExpiredSessions({
        baseDir: getOctsshDir(),
        retentionDays: currentCfg.retentionDays,
      });
      for (const rec of expired) {
        if ((rec as any).kind === "local") {
          const runDir = (rec as any).runDir as string | undefined;
          if (runDir) {
            try {
              fs.rmSync(runDir, { recursive: true, force: true });
            } catch {
              // ignore
            }
          }
          deleteSessionFile(rec.session_id, getOctsshDir());
          continue;
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }, 60 * 60 * 1000).unref();
}

export function createOctsshLocalServer() {
  const cfg = loadConfig(getOctsshDir());
  const server = new McpServer({ name: "octssh", version: "0.0.0" });

  const toolPrefix = normalizeToolPrefix(process.env.OCTSSH_TOOL_PREFIX);
  const toolName = (name: string) => `${toolPrefix}${name}`;

  ensureLocalCleanupStarted();

  server.registerTool(
    toolName("list"),
    {
      title: "List Targets",
      description: "List targets for this OctSSH instance (serve mode targets this host implicitly).",
      inputSchema: z.object({ target: z.array(z.string()).optional() }).optional(),
    },
    async () => {
      return respond({ ok: true, tool: "list", data: { hosts: ["self"] } });
    }
  );

  server.registerTool(
    toolName("info"),
    {
      title: "Local Machine Info",
      description: "Get local machine info (serve mode).",
      // No machine selection in serve mode: the server host is the target.
      inputSchema: z.object({}).optional(),
    },
    async () => {
      const data = {
        name: "self",
        platform: os.platform(),
        arch: os.arch(),
        release: os.release(),
        cpus: os.cpus().length,
        totalMem: os.totalmem(),
        freeMem: os.freemem(),
        uptimeSeconds: os.uptime(),
        hostname: os.hostname(),
      };
      return respond({ ok: true, tool: "info", data });
    }
  );

  server.registerTool(
    toolName("exec"),
    {
      title: "Execute Local Command",
      description: "Execute a command on THIS machine (no ssh).",
      inputSchema: z.object({ command: z.string().min(1), confirm_code: z.string().optional() }),
    },
    async ({ command, confirm_code }) => {
      const machine = "local";
      const decision = await guardLocalCommand({
        machine,
        command,
        allowSudo: false,
        confirm_code,
        security: cfg.security,
      });
      if (decision.action === "block") return respond({ ok: false, tool: "exec", error: decision.message });
      if (decision.action === "confirm") {
        return respond({
          ok: false,
          tool: "exec",
          error: decision.message,
          data: {
            confirm_code: decision.confirm_code,
            preview: {
              total: decision.preview.total,
              truncated: decision.preview.truncated,
              sample: decision.preview.sample.slice(0, 10),
            },
          },
        });
      }

      const res = await runLocalCommand({ command, sudo: false });
      return respond({
        ok: res.exitCode === 0,
        tool: "exec",
        data: { machine, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated },
      });
    }
  );

  server.registerTool(
    toolName("sudo-exec"),
    {
      title: "Execute Local Command (sudo)",
      description: "Execute a command on THIS machine with passwordless sudo (sudo -n).",
      inputSchema: z.object({ command: z.string().min(1), confirm_code: z.string().optional() }),
    },
    async ({ command, confirm_code }) => {
      const machine = "local";
      const decision = await guardLocalCommand({
        machine,
        command,
        allowSudo: true,
        confirm_code,
        security: cfg.security,
      });
      if (decision.action === "block") return respond({ ok: false, tool: "sudo-exec", error: decision.message });
      if (decision.action === "confirm") {
        return respond({
          ok: false,
          tool: "sudo-exec",
          error: decision.message,
          data: {
            confirm_code: decision.confirm_code,
            preview: {
              total: decision.preview.total,
              truncated: decision.preview.truncated,
              sample: decision.preview.sample.slice(0, 10),
            },
          },
        });
      }

      const res = await runLocalCommand({ command, sudo: true });
      return respond({
        ok: res.exitCode === 0,
        tool: "sudo-exec",
        data: { machine, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, truncated: res.truncated },
      });
    }
  );

  server.registerTool(
    toolName("exec-async"),
    {
      title: "Execute Async (local)",
      description: "Execute a long-running command in background on THIS machine.",
      inputSchema: z.object({ command: z.string().min(1), confirm_code: z.string().optional() }),
    },
    async ({ command, confirm_code }) => {
      const machine = "local";
      const decision = await guardLocalCommand({
        machine,
        command,
        allowSudo: false,
        confirm_code,
        security: cfg.security,
      });
      if (decision.action === "block") return respond({ ok: false, tool: "exec-async", error: decision.message });
      if (decision.action === "confirm") {
        return respond({
          ok: false,
          tool: "exec-async",
          error: decision.message,
          data: {
            confirm_code: decision.confirm_code,
            preview: {
              total: decision.preview.total,
              truncated: decision.preview.truncated,
              sample: decision.preview.sample.slice(0, 10),
            },
          },
        });
      }

      const started = await startLocalAsync({ machine, command, sudo: false });
      return respond({ ok: true, tool: "exec-async", data: started });
    }
  );

  server.registerTool(
    toolName("exec-async-sudo"),
    {
      title: "Execute Async (sudo, local)",
      description: "Execute a long-running sudo command in background on THIS machine.",
      inputSchema: z.object({ command: z.string().min(1), confirm_code: z.string().optional() }),
    },
    async ({ command, confirm_code }) => {
      const machine = "local";
      const decision = await guardLocalCommand({
        machine,
        command,
        allowSudo: true,
        confirm_code,
        security: cfg.security,
      });
      if (decision.action === "block") return respond({ ok: false, tool: "exec-async-sudo", error: decision.message });
      if (decision.action === "confirm") {
        return respond({
          ok: false,
          tool: "exec-async-sudo",
          error: decision.message,
          data: {
            confirm_code: decision.confirm_code,
            preview: {
              total: decision.preview.total,
              truncated: decision.preview.truncated,
              sample: decision.preview.sample.slice(0, 10),
            },
          },
        });
      }

      const started = await startLocalAsync({ machine, command, sudo: true });
      return respond({ ok: true, tool: "exec-async-sudo", data: started });
    }
  );

  server.registerTool(
    toolName("write-stdin"),
    {
      title: "Write to Async stdin (local)",
      description: "Write data to a running local async session stdin.",
      inputSchema: z.object({
        session_id: z.string().min(1),
        data: z.string(),
        append_newline: z.boolean().optional(),
      }),
    },
    async ({ session_id, data, append_newline }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) return respond({ ok: false, tool: "write-stdin", error: "session not found" });
      if (!("kind" in rec) || rec.kind !== "local") {
        return respond({ ok: false, tool: "write-stdin", error: "session is not a local async session" });
      }

      const baseDir = getOctsshDir();
      const expectedRunDir = path.join(baseDir, "runs", rec.session_id);
      if (path.resolve(rec.runDir) !== path.resolve(expectedRunDir)) {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "invalid session runDir",
        });
      }

      const stdinPath = rec.stdinPath;
      const stdinLogPath = rec.stdinLogPath;
      const metaPath = rec.metaPath;

      if (!stdinPath || !stdinLogPath) {
        return respond({
          ok: false,
          tool: "write-stdin",
          error:
            "stdin is not available for this session (created by older OctSSH version?). Start a new exec-async session.",
        });
      }

      const expectedStdinPath = path.join(expectedRunDir, "stdin.in");
      const expectedStdinLogPath = path.join(expectedRunDir, "stdin.log");
      if (path.resolve(stdinPath) !== path.resolve(expectedStdinPath)) {
        return respond({ ok: false, tool: "write-stdin", error: "invalid stdinPath" });
      }
      if (path.resolve(stdinLogPath) !== path.resolve(expectedStdinLogPath)) {
        return respond({ ok: false, tool: "write-stdin", error: "invalid stdinLogPath" });
      }

      try {
        const st = fs.lstatSync(stdinPath);
        if (st.isSymbolicLink()) {
          return respond({ ok: false, tool: "write-stdin", error: "stdinPath must not be a symlink" });
        }
      } catch (err: any) {
        return respond({ ok: false, tool: "write-stdin", error: String(err?.message ?? err) });
      }

      try {
        const stLog = fs.lstatSync(stdinLogPath);
        if (stLog.isSymbolicLink()) {
          return respond({ ok: false, tool: "write-stdin", error: "stdinLogPath must not be a symlink" });
        }
      } catch (err: any) {
        if (String(err?.code ?? "") !== "ENOENT") {
          return respond({ ok: false, tool: "write-stdin", error: String(err?.message ?? err) });
        }
      }

      let meta: any = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = null;
      }

      let status = rec.status;
      let exitCode = rec.exitCode ?? null;
      if (meta && typeof meta.status === "string") {
        if (meta.status === "running") status = "running";
        if (meta.status === "done") {
          status = meta.exitCode === 0 ? "done" : "failed";
          if (typeof meta.exitCode === "number") exitCode = meta.exitCode;
        }
      }
      const prevExitCode = typeof rec.exitCode === "number" ? rec.exitCode : null;
      if (status !== rec.status || exitCode !== prevExitCode) {
        saveSession(
          { ...rec, status, exitCode: exitCode === null ? undefined : exitCode, updatedAt: isoNow() },
          getOctsshDir()
        );
      }
      if (status !== "running") {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "session is not running",
          data: { status, exitCode },
        });
      }

      const wantNewline = append_newline ?? true;
      const payload = wantNewline ? `${data}\n` : data;
      const buf = Buffer.from(payload, "utf8");
      if (buf.byteLength > 64 * 1024) {
        return respond({
          ok: false,
          tool: "write-stdin",
          error: "payload too large (max 64KiB per call)",
          data: { bytes: buf.byteLength },
        });
      }

      try {
        fs.appendFileSync(stdinLogPath, buf);
      } catch (err: any) {
        return respond({ ok: false, tool: "write-stdin", error: String(err?.message ?? err) });
      }

      try {
        fs.appendFileSync(stdinPath, buf);
      } catch (err: any) {
        return respond({ ok: false, tool: "write-stdin", error: String(err?.message ?? err) });
      }

      return respond({
        ok: true,
        tool: "write-stdin",
        data: { session_id, machine: rec.machine, bytes: buf.byteLength, append_newline: wantNewline },
      });
    }
  );

  server.registerTool(
    toolName("get-result"),
    {
      title: "Get Async Result (local)",
      description: "Get local async status; optionally tail last N lines from logs.",
      inputSchema: z.object({ session_id: z.string().min(1), lines: z.number().int().positive().max(2000).optional() }),
    },
    async ({ session_id, lines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) return respond({ ok: false, tool: "get-result", error: "session not found" });
      if ((rec as any).kind !== "local") {
        return respond({ ok: false, tool: "get-result", error: "session is not a local async session" });
      }

      const metaPath = (rec as any).metaPath as string;
      let meta: any = null;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
      } catch {
        meta = null;
      }

      let status = rec.status;
      let exitCode = (rec as any).exitCode ?? null;
      if (meta && typeof meta.status === "string") {
        if (meta.status === "running") status = "running";
        if (meta.status === "done") {
          status = meta.exitCode === 0 ? "done" : "failed";
          if (typeof meta.exitCode === "number") exitCode = meta.exitCode;
        }
      }

      if (status !== rec.status || exitCode !== (rec as any).exitCode) {
        saveSession({ ...(rec as any), status, exitCode: exitCode === null ? undefined : exitCode, updatedAt: isoNow() }, getOctsshDir());
      }

      let tails: any = null;
      if (lines) {
        const n = Math.max(1, Math.min(2000, Math.floor(lines)));
        tails = {
          stdout: tailLocalFile((rec as any).stdoutPath, n),
          stderr: tailLocalFile((rec as any).stderrPath, n),
        };
      }

      return respond({
        ok: true,
        tool: "get-result",
        data: { session_id, machine: rec.machine, status, exitCode, cmdPid: (rec as any).cmdPid ?? null, tails },
      });
    }
  );

  server.registerTool(
    toolName("grep-result"),
    {
      title: "Search Async Logs (local)",
      description: "Search local async stdout/stderr logs by regex pattern.",
      inputSchema: z.object({ session_id: z.string().min(1), pattern: z.string().min(1), maxMatches: z.number().int().positive().max(500).optional(), contextLines: z.number().int().min(0).max(50).optional() }),
    },
    async ({ session_id, pattern, maxMatches, contextLines }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) return respond({ ok: false, tool: "grep-result", error: "session not found" });
      if ((rec as any).kind !== "local") {
        return respond({ ok: false, tool: "grep-result", error: "session is not a local async session" });
      }

      const m = Math.max(1, Math.min(500, Math.floor(maxMatches ?? 50)));
      const c = Math.max(0, Math.min(50, Math.floor(contextLines ?? 2)));
      const re = new RegExp(pattern, "i");

      const grepFile = (filePath: string) => {
        try {
          const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
          const out: string[] = [];
          for (let i = 0; i < lines.length; i++) {
            if (!re.test(lines[i] ?? "")) continue;
            const from = Math.max(0, i - c);
            const to = Math.min(lines.length, i + c + 1);
            for (let j = from; j < to; j++) {
              out.push(`${j + 1}:${lines[j]}`);
            }
            out.push("--");
            if (out.length >= m * (c * 2 + 3)) break;
          }
          return out.slice(0, 10_000).join("\n");
        } catch {
          return "";
        }
      };

      return respond({
        ok: true,
        tool: "grep-result",
        data: {
          session_id,
          machine: rec.machine,
          pattern,
          maxMatches: m,
          contextLines: c,
          matches: { stdout: grepFile((rec as any).stdoutPath), stderr: grepFile((rec as any).stderrPath) },
        },
      });
    }
  );

  server.registerTool(
    toolName("cancel"),
    {
      title: "Cancel Async Session (local)",
      description: "Terminate a running local async session by session_id.",
      inputSchema: z.object({ session_id: z.string().min(1), signal: z.string().optional() }),
    },
    async ({ session_id, signal }) => {
      const rec = loadSession(session_id, getOctsshDir());
      if (!rec) return respond({ ok: false, tool: "cancel", error: "session not found" });
      if ((rec as any).kind !== "local") {
        return respond({ ok: false, tool: "cancel", error: "session is not a local async session" });
      }
      if (rec.status !== "running") {
        return respond({ ok: true, tool: "cancel", data: { session_id, status: rec.status, note: "session is not running" } });
      }

      const sig = (signal ?? "TERM").toUpperCase();
      const safeSig = /^[A-Z0-9]+$/.test(sig) ? sig : "TERM";
      const normalizedSig = safeSig.startsWith("SIG") ? safeSig : `SIG${safeSig}`;
      const pid = (rec as any).cmdPid as number | undefined;
      if (pid) {
        try {
          process.kill(pid, normalizedSig as NodeJS.Signals);
        } catch {
          // ignore
        }
      }

      saveSession({ ...(rec as any), status: "cancelled", updatedAt: isoNow() }, getOctsshDir());
      return respond({ ok: true, tool: "cancel", data: { session_id, status: "cancelled", signal: safeSig } });
    }
  );

  server.registerTool(
    toolName("sleep"),
    {
      title: "Sleep",
      description: "Sleep for a duration (ms).",
      inputSchema: z.object({ time: z.number().int().min(0).max(60_000) }),
    },
    async ({ time }) => {
      await new Promise((r) => setTimeout(r, time));
      return respond({ ok: true, tool: "sleep", data: { sleptMs: time } });
    }
  );

  return server;
}
