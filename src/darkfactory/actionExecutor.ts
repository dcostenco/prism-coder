import { promises as fs, constants as fsConstants } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execFile, spawn } from "node:child_process";
import type { ActionPayload, PipelineSpec } from "./schema.js";

const MAX_OUTPUT = 16_000;
const MAX_FILE = 512_000;
const COMMAND_LIVENESS_POLL_MS = 100;
const COMMAND_STATUS_POLL_MS = 1_000;
const COMMAND_LIVENESS_TIMEOUT_MS = 5_000;
const COMMAND_STOPPED = "Pipeline stopped during command execution";
const COMMAND_LIVENESS_UNAVAILABLE = "Pipeline command liveness check timed out";
const COMMAND_TIMED_OUT = "Pipeline command timed out";
const COMMAND_OUTPUT_EXCEEDED = "Pipeline command output exceeded its limit";
const WRITE_STAGE_PREFIX = '.prism-write-';
const WRITE_STAGE_FILE = 'content';

async function assertCommandLive(stillRunning: () => Promise<boolean>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const live = await Promise.race([
      stillRunning(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(COMMAND_LIVENESS_UNAVAILABLE)), COMMAND_LIVENESS_TIMEOUT_MS);
      }),
    ]);
    if (!live) throw new Error(COMMAND_STOPPED);
  } finally { if (timer) clearTimeout(timer); }
}

/** Execute only while the caller retains authority; reap inherited descendants too. */
async function runGuardedCommand(file: string, args: string[], cwd: string | undefined, timeout: number, stillRunning: () => Promise<boolean>, stillOwned = stillRunning): Promise<{ stdout: string; stderr: string }> {
  await assertCommandLive(stillRunning);
  return new Promise((resolveCommand, rejectCommand) => {
    let finished = false;
    let checking = false;
    let checkingStatus = false;
    let stopReason: Error | undefined;
    let cleanup: Promise<void> | undefined;
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    const child = spawn(file, args, {
      cwd, shell: false, detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH },
    });
    child.once('error', error => { stopReason ??= error; });
    child.once('close', (code, signal) => {
      finished = true;
      clearInterval(monitor);
      clearInterval(statusMonitor);
      clearTimeout(deadline);
      void (async () => {
        await terminateTree();
        if (stopReason) throw stopReason;
        if (code !== 0) throw Object.assign(new Error(`Command exited with ${signal || code}`), { stdout, stderr });
        await assertCommandLive(stillRunning);
        resolveCommand({ stdout, stderr });
      })().catch(rejectCommand);
    });
    function terminateTree(): Promise<void> {
      if (cleanup) return cleanup;
      const pid = child.pid;
      cleanup = !pid ? Promise.resolve() : new Promise<void>((resolveCleanup, rejectCleanup) => {
        if (process.platform === 'win32') {
          execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { shell: false, timeout: COMMAND_LIVENESS_TIMEOUT_MS }, error => {
            if (error && child.exitCode === null && child.signalCode === null) rejectCleanup(error);
            else resolveCleanup();
          });
        } else {
          try { process.kill(-pid, 'SIGKILL'); resolveCleanup(); }
          catch (error: any) { if (error.code === 'ESRCH') resolveCleanup(); else rejectCleanup(error); }
        }
      });
      return cleanup;
    }
    function stop(error: Error) {
      stopReason ??= error;
      void terminateTree().catch(cleanupError => { stopReason = new Error(`${error.message}; process cleanup failed: ${String(cleanupError)}`); });
    }
    const collect = (chunk: string, stream: 'stdout' | 'stderr') => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > MAX_OUTPUT * 2) { stop(new Error(COMMAND_OUTPUT_EXCEEDED)); return; }
      if (stream === 'stdout') stdout += chunk; else stderr += chunk;
    };
    child.stdout!.setEncoding('utf8').on('data', chunk => collect(chunk, 'stdout'));
    child.stderr!.setEncoding('utf8').on('data', chunk => collect(chunk, 'stderr'));
    // Reap inherited descendants on parent exit as well as on cancellation.
    // Their output pipes must close before this command can settle.
    child.once('exit', () => { void terminateTree().catch(error => { stopReason ??= error; }); });
    const deadline = setTimeout(() => stop(new Error(COMMAND_TIMED_OUT)), timeout);
    const monitor = setInterval(() => {
      if (finished || checking) return;
      checking = true;
      void assertCommandLive(stillOwned).catch(error => {
        if (finished) return;
        stop(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => { checking = false; });
    }, COMMAND_LIVENESS_POLL_MS);
    // Local leases can be checked frequently without turning a repository
    // command into hundreds of authenticated Portal reads per minute.
    const statusMonitor = setInterval(() => {
      if (finished || checkingStatus || stillOwned === stillRunning) return;
      checkingStatus = true;
      void assertCommandLive(stillRunning).catch(error => {
        if (!finished) stop(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => { checkingStatus = false; });
    }, COMMAND_STATUS_POLL_MS);
    monitor.unref();
    statusMonitor.unref();
  });
}

function contained(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(".." + "/") && !rel.startsWith(".." + "\\") && !isAbsolute(rel));
}

async function safePath(spec: PipelineSpec, targetPath: string, write: boolean): Promise<string> {
  if (!spec.workingDirectory || !targetPath || isAbsolute(targetPath)) throw new Error("Action path must be relative to workingDirectory");
  const root = await fs.realpath(spec.workingDirectory);
  const candidate = resolve(root, targetPath);
  const parent = await fs.realpath(dirname(candidate));
  const target = resolve(parent, candidate.slice(candidate.lastIndexOf("/") + 1));
  if (!contained(root, target)) throw new Error("Action path escapes workingDirectory");
  try { const final = await fs.realpath(target); if (!contained(root, final)) throw new Error("Action path escapes workingDirectory"); } catch (error: any) { if (error.code !== "ENOENT") throw error; }
  if (write && (!spec.allowedWritePaths || !spec.allowedWritePaths.some(p => resolve(root, p) === target))) {
    throw new Error("Action path is outside allowedWritePaths");
  }
  return target;
}

async function commandArgs(command: string, spec: PipelineSpec): Promise<{ file: string; args: string[] }> {
  const parts = command.trim().split(/\s+/);
  if (parts.length < 2 || parts.some(part => /[;&|`$<>]/.test(part))) throw new Error("RUN_TEST command is not allowed");
  const checkPath = async (value: string) => {
    if (!value || value.startsWith('-') || isAbsolute(value) || value.split(/[\\/]/).includes('..')) throw new Error("RUN_TEST path must stay within workingDirectory");
    await safePath(spec, value, false);
  };
  if (parts[0] === "node" && parts[1] === "--test" && parts.length > 2) {
    for (const value of parts.slice(2)) await checkPath(value);
    return { file: "node", args: parts.slice(1) };
  }
  if (parts.length === 2 && parts[0] === "npm" && parts[1] === "test") return { file: "npm", args: parts.slice(1) };
  if (parts[0] === "pytest") {
    for (const value of parts.slice(1)) await checkPath(value.split('::')[0]);
    return { file: "pytest", args: parts.slice(1) };
  }
  if (parts[0] === "go" && parts[1] === "test" && parts.length > 2) {
    for (const value of parts.slice(2)) {
      if (!value.startsWith('./')) throw new Error("RUN_TEST Go packages must be workspace relative");
      await checkPath(value.endsWith('/...') ? value.slice(0, -4) || '.' : value);
    }
    return { file: "go", args: parts.slice(1) };
  }
  if (parts[0] === "cargo" && parts[1] === "test" && parts.slice(2).every(value => /^[A-Za-z0-9_]+$/.test(value))) return { file: "cargo", args: parts.slice(1) };
  throw new Error("RUN_TEST must use node --test, npm test, pytest, go test, or cargo test");
}

export async function executeActions(actions: ActionPayload[], spec: PipelineSpec, stillRunning: () => Promise<boolean>, stillOwned = stillRunning): Promise<string[]> {
  for (const action of actions) {
    if (!action || !["READ_FILE", "WRITE_FILE", "PATCH_FILE", "RUN_TEST"].includes(action.type) || !action.targetPath) throw new Error("Invalid action payload");
    if (action.type === "WRITE_FILE" && typeof action.content !== "string") throw new Error("WRITE_FILE content is required");
    if (action.type === "PATCH_FILE" && typeof action.patch !== "string") throw new Error("PATCH_FILE patch is required");
    if (action.type === "RUN_TEST" && typeof action.command !== "string") throw new Error("RUN_TEST command is required");
  }
  for (const action of actions) {
    await safePath(spec, action.targetPath, action.type === "WRITE_FILE" || action.type === "PATCH_FILE");
    if (action.type === "RUN_TEST") {
      if (!spec.testCommand || action.command !== spec.testCommand) throw new Error("RUN_TEST must exactly match spec.testCommand");
      await commandArgs(action.command!, spec);
    }
  }
  const results: string[] = [];
  for (const action of actions) {
    if (!(await stillRunning())) throw new Error("Pipeline stopped before action execution");
    const write = action.type === "WRITE_FILE" || action.type === "PATCH_FILE";
    const target = await safePath(spec, action.targetPath, write);
    if (action.type === "READ_FILE") {
      const content = await fs.readFile(target, "utf8");
      results.push(`READ_FILE ${action.targetPath}: ${content.slice(0, MAX_OUTPUT)}`);
    } else if (action.type === "WRITE_FILE") {
      if (typeof action.content !== "string" || action.content.length > MAX_FILE) throw new Error("WRITE_FILE content is invalid or too large");
      if (!(await stillRunning())) throw new Error("Pipeline stopped before file mutation");
      const flags = fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW;
      let handle;
      try { handle = await fs.open(target, flags); }
      catch (error: any) {
        if (error.code !== 'ENOENT') throw error;
        if (!(await stillRunning())) throw new Error("Pipeline stopped before file mutation");
        // Stage on the same filesystem, then publish a complete inode without
        // replacing an existing pathname. Cancellation never unlinks target.
        const stageDir = await fs.mkdtemp(resolve(dirname(target), WRITE_STAGE_PREFIX));
        const staged = resolve(stageDir, WRITE_STAGE_FILE);
        try {
          const stagedHandle = await fs.open(staged, flags | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
          try {
            if (!(await stillRunning())) throw new Error("Pipeline stopped before file mutation");
            await stagedHandle.writeFile(action.content, "utf8");
            if (!(await stillRunning())) throw new Error("Pipeline stopped before file mutation");
            await fs.link(staged, target);
          } finally { await stagedHandle.close(); }
        } finally {
          await fs.unlink(staged).catch((cleanupError: any) => { if (cleanupError.code !== 'ENOENT') throw cleanupError; });
          await fs.rmdir(stageDir);
        }
        results.push(`WRITE_FILE ${action.targetPath}: ok`);
        continue;
      }
      try {
        if (!(await stillRunning())) throw new Error("Pipeline stopped before file mutation");
        await handle.truncate(0);
        await handle.writeFile(action.content, "utf8");
      }
      finally { await handle.close(); }
      results.push(`WRITE_FILE ${action.targetPath}: ok`);
    } else if (action.type === "PATCH_FILE") {
      const header = action.patch!.match(/^diff --git a\/([^\n]+) b\/([^\n]+)\n(?:index [^\n]+\n)?--- a\/([^\n]+)\n\+\+\+ b\/([^\n]+)\n/);
      if (!header || header[1] !== action.targetPath || header[2] !== action.targetPath || header[3] !== action.targetPath || header[4] !== action.targetPath || action.patch!.includes("rename from") || action.patch!.includes("new file mode") || action.patch!.includes("old mode") || (action.patch!.match(/^diff --git /gm) || []).length !== 1) throw new Error("PATCH_FILE must be a single-file content patch");
      const patchFile = resolve(spec.workingDirectory!, `.prism-patch-${process.pid}-${Date.now()}.diff`);
      if (!(await stillRunning())) throw new Error("Pipeline stopped before patch mutation");
      await fs.writeFile(patchFile, action.patch!, { mode: 0o600 });
      try {
        await runGuardedCommand("git", ["apply", "--check", "--whitespace=nowarn", patchFile], spec.workingDirectory, 30_000, stillRunning, stillOwned);
        if (!(await stillRunning())) throw new Error("Pipeline stopped before patch mutation");
        await runGuardedCommand("git", ["apply", "--whitespace=nowarn", patchFile], spec.workingDirectory, 30_000, stillRunning, stillOwned);
      } finally { await fs.rm(patchFile, { force: true }); }
      results.push(`PATCH_FILE ${action.targetPath}: ok`);
    } else if (action.type === "RUN_TEST") {
      if (!spec.testCommand || action.command !== spec.testCommand) throw new Error("RUN_TEST must exactly match spec.testCommand");
      const parsed = await commandArgs(action.command, spec);
      try {
        const out = await runGuardedCommand(parsed.file, parsed.args, spec.workingDirectory, 120_000, stillRunning, stillOwned);
        if (!(await stillRunning())) throw new Error("Pipeline stopped during test execution");
        results.push(`RUN_TEST ${action.command}: passed\n${String(out.stdout).slice(0, MAX_OUTPUT)}`);
      } catch (error: any) {
        throw new Error(`RUN_TEST failed: ${String(error?.stdout || error?.stderr || error).slice(0, MAX_OUTPUT)}`);
      }
    }
  }
  return results;
}

export async function readContextFiles(spec: PipelineSpec): Promise<string> {
  if (!spec.contextFiles?.length) return "";
  if (spec.contextFiles.length > 20) throw new Error("contextFiles exceeds limit");
  const chunks: string[] = [];
  for (const file of spec.contextFiles) {
    const target = await safePath(spec, file, false);
    const content = await fs.readFile(target, "utf8");
    chunks.push(`=== ${file} ===\n${content.slice(0, 20_000)}`);
  }
  return chunks.join("\n");
}
