import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, access, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeActions } from "../../src/darkfactory/actionExecutor.js";
import { promises as fs } from "node:fs";
import { vi } from "vitest";

const makeSpec = (workingDirectory: string) => ({
  objective: "bounded cancellation probe", maxIterations: 1, workingDirectory,
  allowedWritePaths: ["created.txt"], testCommand: "node --test probe.test.cjs",
});
const exists = async (file: string) => access(file).then(() => true, () => false);

// Probe programs are fixed source text. Every path they touch is derived from
// their own directory when they run, so no test value is spliced into code.
const PROBE_TEST = "require('node:test')('probe', () => { require('node:child_process').execFileSync(process.execPath, [require('node:path').join(__dirname, 'probe.cjs')]); });\n";
const READY_THEN_LATE_MARKER = [
  "const fs = require('node:fs'); const path = require('node:path');",
  "fs.writeFileSync(path.join(__dirname, 'ready'), 'ready');",
  "setTimeout(() => fs.writeFileSync(path.join(__dirname, 'marker'), 'bad'), 250);",
].join("\n");
const child = (ignoreSigterm: boolean) => [
  "const fs = require('node:fs'); const path = require('node:path');",
  "fs.writeFileSync(path.join(__dirname, 'child-ready'), 'ready');",
  ignoreSigterm ? "process.on('SIGTERM', () => {});" : "",
  "setTimeout(() => fs.writeFileSync(path.join(__dirname, 'marker'), 'bad'), 300);",
].join("\n");
const spawnChildThenReady = (explicitlyAttached: boolean) => [
  "const cp = require('node:child_process'); const fs = require('node:fs'); const path = require('node:path');",
  explicitlyAttached
    ? "cp.spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { detached: false, stdio: 'ignore' }).unref();"
    : "cp.spawn(process.execPath, [path.join(__dirname, 'child.cjs')], { stdio: 'ignore' }).unref();",
  "const end = Date.now() + 500; while (!fs.existsSync(path.join(__dirname, 'child-ready')) && Date.now() < end) {}",
  "fs.writeFileSync(path.join(__dirname, 'ready'), 'ready');",
].join("\n");
const writeProbe = async (dir: string, probe: string, childSource?: string) => {
  await writeFile(join(dir, "probe.cjs"), probe);
  if (childSource !== undefined) await writeFile(join(dir, "child.cjs"), childSource);
  await writeFile(join(dir, "probe.test.cjs"), PROBE_TEST);
};
const waitFor = async (file: string, ms = 1000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await exists(file)) return true; await new Promise(resolve => setTimeout(resolve, 10)); }
  return false;
};

describe("Dark Factory action cancellation", () => {
  it("does not create a file when authority is lost before opening it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-write-"));
    try {
      let checks = 0;
      await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "written" }], makeSpec(dir), async () => ++checks < 2)).rejects.toThrow(/stopped/);
      expect(await exists(join(dir, "created.txt"))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("leaves no new file after revocation during missing-target write", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-window-"));
    try {
      let checks = 0;
      await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "written" }], makeSpec(dir), async () => ++checks < 3)).rejects.toThrow(/stopped/);
      expect(await exists(join(dir, "created.txt"))).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("preserves an existing file when authority is lost after open", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-existing-")); const target = join(dir, "created.txt");
    try {
      await writeFile(target, "original"); let checks = 0;
      await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "replacement" }], makeSpec(dir), async () => ++checks < 3)).rejects.toThrow(/stopped/);
      expect(await readFile(target, "utf8")).toBe("original");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("cancels after the real O_CREAT open, without leaving the new inode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-open-spy-")); let opened = false;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args); if (String(args[0]).includes(".prism-write-")) opened = true; return handle;
    });
    try {
      await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "written" }], makeSpec(dir), async () => !opened)).rejects.toThrow(/stopped/);
      expect(opened).toBe(true); expect(await exists(join(dir, "created.txt"))).toBe(false);
    } finally { openSpy.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it("does not remove a replacement target after post-open revocation", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-replace-")); const target = join(dir, "created.txt"); const other = join(dir, "other.txt");
    let replaced = false;
    const originalOpen = fs.open;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => {
      const handle = await originalOpen(...args);
      if (String(args[0]).includes(".prism-write-") && !replaced) {
        await writeFile(other, "safe"); await symlink("other.txt", target); replaced = true;
      }
      return handle;
    });
    try {
      const run = executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "replacement" }], makeSpec(dir), async () => {
        return !replaced;
      });
      await expect(run).rejects.toThrow(); expect(replaced).toBe(true); expect(await readFile(other, "utf8")).toBe("safe"); expect((await fs.lstat(target)).isSymbolicLink()).toBe(true);
    } finally { openSpy.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it("publishes a successful new-file write without leaving staging files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-publish-"));
    try {
      await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "complete" }], makeSpec(dir), async () => true)).resolves.toEqual([expect.stringContaining("WRITE_FILE")]);
      expect(await readFile(join(dir, "created.txt"), "utf8")).toBe("complete");
      expect((await (await import("node:fs/promises")).readdir(dir)).some(name => name.includes(".prism-write-") || name.includes(".prism-stage-") )).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("preserves a competing final target when publication loses an EEXIST race", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-eexist-")); const target = join(dir, "created.txt"); let staged = false;
    const originalOpen = fs.open; const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof originalOpen>) => { const handle = await originalOpen(...args); if (String(args[0]).includes(".prism-write-") && !staged) { await writeFile(target, "competitor"); staged = true; } return handle; });
    try { await expect(executeActions([{ type: "WRITE_FILE", targetPath: "created.txt", content: "factory" }], makeSpec(dir), async () => true)).rejects.toThrow(); expect(await readFile(target, "utf8")).toBe("competitor"); } finally { openSpy.mockRestore(); await rm(dir, { recursive: true, force: true }); }
  });

  it("cancels a ready RUN_TEST before its delayed marker is written", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-test-")); const ready = join(dir, "ready"); const marker = join(dir, "marker");
    await writeProbe(dir, READY_THEN_LATE_MARKER);
    try {
      const result = executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => !(await exists(ready)));
      await expect(result).rejects.toThrow(/stopped|failed/); expect(await exists(ready)).toBe(true); expect(await waitFor(marker, 500)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("kills an inherited process-group descendant that ignores SIGTERM", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-descendant-")); const ready = join(dir, "ready"); const marker = join(dir, "marker");
    const childReady = join(dir, "child-ready");
    await writeProbe(dir, spawnChildThenReady(true), child(true));
    try {
      await expect(executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => !(await exists(ready)))).rejects.toThrow(/stopped|failed/);
      expect(await exists(childReady)).toBe(true); expect(await waitFor(marker, 600)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("kills a descendant after its parent exits normally", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-orphan-")); const ready = join(dir, "ready"); const marker = join(dir, "marker"); const childReady = join(dir, "child-ready");
    await writeProbe(dir, spawnChildThenReady(false), child(false));
    try {
      await expect(executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => true)).resolves.toEqual([expect.stringContaining("passed")]);
      expect(await exists(childReady)).toBe(true); expect(await exists(ready)).toBe(true); expect(await waitFor(marker, 600)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("fails closed when the liveness callback rejects", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-reject-"));
    try {
      const ready = join(dir, "ready"); const marker = join(dir, "marker");
      await writeProbe(dir, READY_THEN_LATE_MARKER);
      await expect(executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => { if (await exists(ready)) throw new Error("revocation lookup failed"); return true; })).rejects.toThrow(/revocation lookup failed/);
      expect(await exists(ready)).toBe(true); expect(await waitFor(marker, 500)).toBe(false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("keeps ordinary passing and failing test outcomes intact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "factory-cancel-outcomes-"));
    try {
      await (await import("node:fs/promises")).writeFile(join(dir, "probe.test.cjs"), "require('node:test')('pass',()=>{});\n");
      await expect(executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => true)).resolves.toEqual([expect.stringContaining("passed")]);
      await (await import("node:fs/promises")).writeFile(join(dir, "probe.test.cjs"), "require('node:test')('fail',()=>{throw Error('expected');});\n");
      await expect(executeActions([{ type: "RUN_TEST", targetPath: ".", command: "node --test probe.test.cjs" }], { ...makeSpec(dir), allowedWritePaths: [] }, async () => true)).rejects.toThrow(/RUN_TEST failed/);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
