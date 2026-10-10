import { promises as fs, constants as fsConstants } from "node:fs";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ActionPayload, PipelineSpec } from "./schema.js";

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 16_000;
const MAX_FILE = 512_000;

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

export async function executeActions(actions: ActionPayload[], spec: PipelineSpec, stillRunning: () => Promise<boolean>): Promise<string[]> {
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
      const handle = await fs.open(target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600);
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
      await fs.writeFile(patchFile, action.patch!, { mode: 0o600 });
      try {
        await execFileAsync("git", ["apply", "--check", "--whitespace=nowarn", patchFile], { cwd: spec.workingDirectory, shell: false, timeout: 30_000 });
        if (!(await stillRunning())) throw new Error("Pipeline stopped before patch mutation");
        await execFileAsync("git", ["apply", "--whitespace=nowarn", patchFile], { cwd: spec.workingDirectory, shell: false, timeout: 30_000 });
      } finally { await fs.rm(patchFile, { force: true }); }
      results.push(`PATCH_FILE ${action.targetPath}: ok`);
    } else if (action.type === "RUN_TEST") {
      if (!spec.testCommand || action.command !== spec.testCommand) throw new Error("RUN_TEST must exactly match spec.testCommand");
      const parsed = await commandArgs(action.command, spec);
      try {
        const out = await execFileAsync(parsed.file, parsed.args, { cwd: spec.workingDirectory, timeout: 120_000, maxBuffer: MAX_OUTPUT * 2, shell: false, env: { PATH: process.env.PATH } });
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
