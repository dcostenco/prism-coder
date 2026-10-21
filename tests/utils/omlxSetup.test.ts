import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, lstat, unlink, chmod, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { OmlxSetupManager, OMLX_SETUP_COMMIT, OMLX_SETUP_MODELS, runSetupCommand } from "../../src/utils/omlxSetup.js";

async function fixture(overrides: Record<string, unknown> = {}) {
    const home = await mkdtemp(join(tmpdir(), "prism-omlx-setup-"));
    const commands: { program: string; args: string[] }[] = [];
    const run = vi.fn(async (program: string, args: string[]) => {
        commands.push({ program, args });
        if (args[0] === "-c" && args[1].startsWith("import sys")) return "3.12\n";
        if (args[1] === "venv") {
            await mkdir(join(args[2], "bin"), { recursive: true });
            await writeFile(join(args[2], "bin", "omlx"), "synthetic executable marker");
        }
        if (args[0] === "download") {
            const destination = args[args.indexOf("--local-dir") + 1];
            await mkdir(destination, { recursive: true });
            await writeFile(join(destination, "config.json"), "{}");
            await writeFile(join(destination, "model.safetensors"), "synthetic unit-test weights");
        }
        return "";
    });
    const manager = new OmlxSetupManager({ home, platform: "darwin", arch: "arm64", release: "24.0.0", totalmem: 48 * 1024 ** 3,
        freeDisk: async () => 60 * 1024 ** 3, leasePort: 0, run, inspect: async () => { throw new Error("not serving"); }, ...overrides });
    return { home, manager, commands, run };
}

describe("opt-in managed oMLX setup", () => {
    it("refuses symlinked state rather than reading outside the managed installation", async () => {
        const f = await fixture();
        await mkdir(f.manager.root, { recursive: true });
        const outside = join(f.home, "outside.json");
        await writeFile(outside, JSON.stringify({ commit: OMLX_SETUP_COMMIT }));
        await symlink(outside, join(f.manager.root, "runtime.json"));
        await expect(f.manager.status()).rejects.toThrow();
        expect(await readFile(outside, "utf8")).toBe(JSON.stringify({ commit: OMLX_SETUP_COMMIT }));
    });
    it.each(["directory", "oversized"])("refuses %s state before parsing it", async kind => {
        const f = await fixture();
        await mkdir(f.manager.root, { recursive: true });
        const marker = join(f.manager.root, "runtime.json");
        if (kind === "directory") await mkdir(marker);
        else await writeFile(marker, " ".repeat(2 * 1024 ** 2 + 1));
        await expect(f.manager.status()).rejects.toThrow("setup_state_invalid");
    });
    it("stops an owned group after its host is killed, without relying on host signal handlers", async () => {
        const parent = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../fixtures/omlx-runner-crash.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
        let group: number | undefined, child: number | undefined;
        try {
            await new Promise<void>((resolve, reject) => {
                let text = "";
                const timer = setTimeout(() => reject(new Error("crash fixture did not start")), 4000);
                parent.once("error", reject);
                parent.stdout.on("data", data => {
                    text += data;
                    group = Number(text.match(/GROUP (\d+)/)?.[1]) || undefined;
                    child = Number(text.match(/CHILD (\d+)/)?.[1]) || undefined;
                    if (group && child) { clearTimeout(timer); resolve(); }
                });
            });
            const exited = new Promise<void>(resolve => parent.once("exit", () => resolve()));
            parent.kill("SIGKILL"); await exited;
            await new Promise(resolve => setTimeout(resolve, 2300));
            expect(() => process.kill(child!, 0)).toThrow();
            expect(() => process.kill(-group!, 0)).toThrow();
        } finally {
            if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
            if (group) { try { process.kill(-group, "SIGKILL"); } catch { /* stopped */ } }
        }
    }, 9000);
    it("stops the owned download before propagating a terminal signal", async () => {
        const parent = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../fixtures/omlx-runner-signal.mjs", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
        let childPid: number | undefined;
        try {
            childPid = await new Promise<number>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error("fixture did not start")), 4000);
                parent.once("error", reject);
                parent.stdout.once("data", data => { clearTimeout(timer); resolve(Number(String(data).trim())); });
            });
            expect(Number.isInteger(childPid) && childPid! > 0).toBe(true);
            const exited = new Promise<NodeJS.Signals | null>(resolve => parent.once("exit", (_code, signal) => resolve(signal)));
            parent.kill("SIGTERM");
            expect(await exited).toBe("SIGTERM");
            expect(() => process.kill(childPid!, 0)).toThrow();
        } finally {
            if (parent.exitCode === null && parent.signalCode === null) parent.kill("SIGKILL");
            if (childPid) { try { process.kill(childPid, "SIGKILL"); } catch { /* already stopped */ } }
        }
    }, 8000);
    it("reports timeout even when the owned child handles termination with a successful exit", async () => {
        await expect(runSetupCommand(process.execPath, ["-e", "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000)"], { timeoutMs: 500 }))
            .rejects.toThrow("setup_command_timed_out");
    });
    it("status never installs packages or downloads models", async () => {
        const f = await fixture();
        expect(await f.manager.status()).toMatchObject({ installed: false, job: null, supported: true });
        expect(f.run).not.toHaveBeenCalled();
    });
    it("recovers an interrupted job even if its stored PID belongs to a live process", async () => {
        const f = await fixture();
        await mkdir(f.manager.root, { recursive: true });
        await writeFile(join(f.manager.root, "setup.json"), JSON.stringify({ id: "old", state: "running", stage: "Downloading", pid: process.pid, startedAt: "2026-10-20T00:00:00Z" }));
        expect((await f.manager.status()).job).toMatchObject({ state: "interrupted" });
        expect(f.run).not.toHaveBeenCalled();
    });
    it("ignores a stale worker ID reused by an unrelated live process", async () => {
        const f = await fixture();
        const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
        await new Promise<void>((resolve, reject) => { worker.once("spawn", resolve); worker.once("error", reject); });
        try {
            await mkdir(f.manager.root, { recursive: true });
            await writeFile(join(f.manager.root, "setup.json"), JSON.stringify({ id: "old-worker", state: "running", stage: "Downloading", pid: process.pid, workerPgid: worker.pid, workerIdentity: "00000000-0000-4000-8000-000000000000" }));
            expect((await f.manager.status()).job).toMatchObject({ state: "interrupted" });
            await f.manager.install(); await f.manager.waitForInstall();
            expect((await f.manager.status()).job?.state).toBe("complete");
        } finally {
            const exited = new Promise<void>(resolve => worker.once("exit", () => resolve()));
            process.kill(-worker.pid!, "SIGKILL"); await exited;
        }
    });
    it("refuses a second writer when the recorded worker identity still matches", async () => {
        const f = await fixture();
        let resume!: () => void, spawned!: () => void;
        const pending = new Promise<void>(resolve => { resume = resolve; });
        const ready = new Promise<void>(resolve => { spawned = resolve; });
        const worker = runSetupCommand(process.execPath, ["-e", "process.exit(0)"], { timeoutMs: 6000,
            onSpawn: async (workerPgid, workerIdentity) => {
                await mkdir(f.manager.root, { recursive: true });
                await writeFile(join(f.manager.root, "setup.json"), JSON.stringify({ id: "active-worker", state: "running", stage: "Downloading", pid: process.pid, workerPgid, workerIdentity }));
                spawned(); await pending;
            } });
        try {
            await ready;
            expect((await f.manager.status()).job).toMatchObject({ state: "running" });
            await expect(f.manager.install()).rejects.toThrow("previous setup worker");
            await expect(f.manager.start()).rejects.toThrow("previous setup worker");
        } finally { resume(); await worker; }
    });
    it("resumes completed stages with less disk than a fresh installation requires", async () => {
        let free = 60;
        const f = await fixture({ freeDisk: async () => free * 1024 ** 3 });
        const base = f.run.getMockImplementation()!;
        let interrupt = true;
        f.run.mockImplementation(async (program, args) => {
            if (interrupt && args[0] === "download" && args[1] === OMLX_SETUP_MODELS[1].repo) throw new Error("interrupted download");
            return base(program, args);
        });
        await f.manager.install(); await f.manager.waitForInstall();
        expect((await f.manager.status()).models[0].downloaded).toBe(true);
        free = 30; interrupt = false;
        expect((await f.manager.status()).requirements.freeDiskGB).toBe(26);
        await f.manager.install(); await f.manager.waitForInstall();
        expect((await f.manager.status()).job?.state).toBe("complete");
    });
    it("keeps startup cache discovery and cluster publishing inside the managed installation", async () => {
        const f = await fixture({ serverPort: 0, startTimeoutMs: 2000 });
        await f.manager.install(); await f.manager.waitForInstall();
        const observed = join(f.home, "startup-env.json");
        const executable = join(f.manager.root, "runtime-" + OMLX_SETUP_COMMIT.slice(0, 12), "bin", "omlx");
        await writeFile(executable, "#!" + process.execPath + "\n" +
            "require('node:fs').writeFileSync(" + JSON.stringify(observed) + ",JSON.stringify({home:process.env.HOME,cache:process.env.HF_HUB_CACHE,shim:process.env.OMLX_CLUSTER_SHIM_DIRECTORY}));process.exit(1);\n");
        await chmod(executable, 0o700);
        await expect(f.manager.start()).rejects.toThrow("Managed oMLX did not start");
        expect(JSON.parse(await readFile(observed, "utf8"))).toEqual({ home: process.env.HOME,
            cache: join(f.manager.basePath, "hf-cache"), shim: join(f.manager.basePath, "bin") });
    });
    it("surfaces immediate server startup failure instead of a false starting response", async () => {
        const f = await fixture({ serverPort: 0, startTimeoutMs: 2000 });
        await f.manager.install(); await f.manager.waitForInstall();
        const executable = join(f.manager.root, "runtime-" + OMLX_SETUP_COMMIT.slice(0, 12), "bin", "omlx");
        await writeFile(executable, "#!/bin/sh\nexit 1\n"); await chmod(executable, 0o700);
        await expect(f.manager.start()).rejects.toThrow("Managed oMLX did not start");
        // Failure releases the reservation so a deliberate retry is possible.
        await expect(f.manager.start()).rejects.toThrow("Managed oMLX did not start");
    });
    it.each([{ platform: "linux" }, { arch: "x64" }, { release: "23.0.0" }, { totalmem: 16 * 1024 ** 3 }, { freeDisk: async () => 1024 }])("rejects incompatible prerequisites before installation", async constraints => {
        const f = await fixture(constraints);
        await expect(f.manager.install()).rejects.toThrow();
        expect(f.run).not.toHaveBeenCalled();
    });
    it("pins source and model revisions, configures guarded settings, and preserves an existing server", async () => {
        const f = await fixture();
        await mkdir(join(f.home, ".omlx"));
        const original = '{"owner":"existing-server"}';
        await writeFile(join(f.home, ".omlx", "settings.json"), original);
        await f.manager.install(); await f.manager.waitForInstall();
        const state = await f.manager.status();
        expect(state).toMatchObject({ installed: true, job: { state: "complete" }, server: { connected: false } });
        expect(state.models.every(model => model.downloaded)).toBe(true);
        const pip = f.commands.find(command => command.args.includes("pip"))!;
        expect(pip.args).toContain("git+https://github.com/dcostenco/omlx.git@" + OMLX_SETUP_COMMIT);
        const downloads = f.commands.filter(command => command.args[0] === "download");
        expect(downloads.map(command => command.args[1])).toEqual(OMLX_SETUP_MODELS.map(model => model.repo));
        for (let index = 0; index < downloads.length; index++) expect(downloads[index].args).toContain(OMLX_SETUP_MODELS[index].revision);
        expect(await readFile(join(f.home, ".omlx", "settings.json"), "utf8")).toBe(original);
        const settings = JSON.parse(await readFile(join(f.manager.basePath, "settings.json"), "utf8"));
        expect(settings).toMatchObject({ scheduler: { chunked_prefill: true }, server: { host: "127.0.0.1", port: 8001 }, cache: { ssd_cache_max_size: "10GB" }, huggingface: { hf_cache_enabled: false } });
        expect((await lstat(join(f.manager.basePath, "settings.json"))).mode & 0o777).toBe(0o600);
        const profiles = JSON.parse(await readFile(join(f.manager.basePath, "model_settings.json"), "utf8"));
        expect(Object.values(profiles.models)).toEqual(expect.arrayContaining([expect.objectContaining({ mtp_enabled: false, specprefill_enabled: false, is_pinned: false })]));
        const previousCalls = f.commands.length;
        await f.manager.install(); await f.manager.waitForInstall();
        expect(f.commands.slice(previousCalls).every(command => command.args[0] === "-c")).toBe(true);
    });
    it("does not claim a downloaded model is ready after its weights were removed", async () => {
        const f = await fixture(); await f.manager.install(); await f.manager.waitForInstall();
        await unlink(join(f.manager.basePath, "models", OMLX_SETUP_MODELS[0].id, "model.safetensors"));
        expect((await f.manager.status()).models[0].downloaded).toBe(false);
    });
    it("reports a failed stage without leaking the subprocess error", async () => {
        const f = await fixture();
        const base = f.run.getMockImplementation()!;
        f.run.mockImplementation(async (program, args) => {
            if (args.includes("pip")) throw new Error("synthetic-private-token");
            return base(program, args);
        });
        await f.manager.install(); await f.manager.waitForInstall();
        const state = await f.manager.status();
        expect(state.job).toMatchObject({ state: "failed", stage: "Installing pinned oMLX server" });
        expect(JSON.stringify(state)).not.toContain("synthetic-private-token");
    });
});
