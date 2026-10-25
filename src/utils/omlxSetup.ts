/** Opt-in, pinned oMLX setup. This module never controls an existing daemon. */
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { appendFile, lstat, open, rename, statfs, writeFile } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { arch, homedir, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { mkdirUsable } from "./usableDirectory.js";
import { inspectOmlx } from "./omlxProvider.js";
import { OMLX_SETUP_WORKER_SOURCE } from "./omlxSetupWorker.js";

export const OMLX_SETUP_COMMIT = "883fd6d00464d0193146a1cba20a64fb7cd8e116";
export const OMLX_SETUP_MODELS = Object.freeze([
    { id: "prism-coder-9b-mlx-8bit", repo: "dcostenco/prism-coder-9b-mlx-8bit", revision: "923f646aca17cfce6b96084ab1608e1c142655a1", label: "Prism 9B classifier", approximateGB: 9 },
    { id: "Qwen3.8-27B-oQ4e-mtp", repo: "Jundot/Qwen3.8-27B-oQ4e-mtp", revision: "49c1d60367d976a730a725ea3bbed32a8e94b878", label: "Qwen3.8 27B coder", approximateGB: 16 },
]);
const GIB = 1024 ** 3, MIN_RAM = 32 * GIB;
const SETUP_LEASE_PORT = 19439, SERVER_PORT = 8001, MAX_LOG_BYTES = 2 * 1024 ** 2;
const INSTALL_TIMEOUT_MS = 45 * 60_000, DOWNLOAD_TIMEOUT_MS = 2 * 60 * 60_000;
type Job = { id: string; state: "running" | "complete" | "failed" | "interrupted"; stage: string; pid: number; startedAt: string; workerPgid?: number; workerIdentity?: string; error?: string };
type Runner = (program: string, args: string[], options: { timeoutMs: number; log?: (data: string) => void; onSpawn?: (pgid: number, identity: string) => Promise<void> }) => Promise<string>;
export interface OmlxSetupOptions {
    home?: string; platform?: string; arch?: string; release?: string; totalmem?: number;
    run?: Runner; leasePort?: number; freeDisk?: () => Promise<number>;
    inspect?: typeof inspectOmlx; serverPort?: number; startTimeoutMs?: number;
}
export class OmlxSetupError extends Error {}

/** No shell, user arguments or inherited provider credentials. All process
 * termination targets the child process group created by this invocation. */
export const runSetupCommand: Runner = (program, args, options) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
    const identity = randomUUID();
    const child = spawn(process.execPath, ["-e", OMLX_SETUP_WORKER_SOURCE, "--", identity], { env, stdio: ["ignore", "pipe", "pipe", "ipc"], detached: process.platform !== "win32" });
    let launchFailed = false;
    child.once("spawn", async () => {
        try {
            await options.onSpawn?.(child.pid!, identity);
            if (child.connected) child.send({ program, args });
        } catch { launchFailed = true; stop(); }
    });
    let output = "", settled = false, timedOut = false, interrupted: NodeJS.Signals | undefined, killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGTERM"); } catch { /* child already stopped */ }
        killTimer = setTimeout(() => { try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* stopped */ } }, 2_000);
        killTimer.unref();
    };
    const onExit = () => stop();
    process.once("exit", onExit);
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    const signalHandlers = signals.map(signal => {
        const handler = () => { if (!interrupted) { interrupted = signal; stop(); } };
        process.on(signal, handler); return handler;
    });
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const finish = (error?: Error) => {
        if (settled) return; settled = true;
        clearTimeout(timer); clearTimeout(killTimer); process.removeListener("exit", onExit);
        signals.forEach((signal, index) => process.removeListener(signal, signalHandlers[index]));
        error ? reject(error) : resolve(output);
        if (interrupted) setImmediate(() => process.kill(process.pid, interrupted!));
    };
    child.stdout!.on("data", data => { output = (output + data).slice(-4096); options.log?.(String(data)); });
    child.stderr!.on("data", data => options.log?.(String(data)));
    child.once("error", () => finish(new Error("setup_command_unavailable")));
    child.once("close", code => finish(interrupted ? new Error("setup_command_interrupted") : timedOut ? new Error("setup_command_timed_out") : !launchFailed && code === 0 ? undefined : new Error("setup_command_failed")));
});

async function readJson(path: string): Promise<any> {
    try {
        const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = await file.stat();
            if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw new Error("setup_state_invalid");
            // Validate and read the same inode, with a hard bound even if an
            // existing writer grows it after stat. Never reopen the pathname.
            const buffer = Buffer.alloc(MAX_LOG_BYTES + 1);
            let size = 0;
            while (size < buffer.length) {
                const part = await file.read(buffer, size, buffer.length - size, size);
                if (!part.bytesRead) break;
                size += part.bytesRead;
            }
            if (size > MAX_LOG_BYTES) throw new Error("setup_state_invalid");
            return JSON.parse(buffer.toString("utf8", 0, size));
        } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function exists(path: string): Promise<boolean> {
    try { return (await lstat(path)).isFile(); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
}
async function modelFilesPresent(directory: string): Promise<boolean> {
    if (!await exists(join(directory, "config.json"))) return false;
    const index = await readJson(join(directory, "model.safetensors.index.json"));
    const files = index?.weight_map ? [...new Set(Object.values(index.weight_map))] : ["model.safetensors"];
    if (!files.length || files.length > 1024) return false;
    for (const name of files) {
        if (typeof name !== "string" || !/^[A-Za-z0-9._-]+\.safetensors$/.test(name)) return false;
        try { const entry = await lstat(join(directory, name)); if (!entry.isFile() || entry.isSymbolicLink() || entry.size === 0) return false; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    }
    return true;
}
async function workerActive(job: Job | undefined): Promise<boolean> {
    if (!Number.isInteger(job?.workerPgid) || job!.workerPgid! <= 0 || !/^[a-f0-9-]{36}$/.test(job?.workerIdentity ?? "")) return false;
    // A persisted group ID can be reused after a crash/reboot. Match this
    // invocation's identity before calling it active; never signal that ID.
    return new Promise<boolean>((resolve, reject) => {
        execFile("/bin/ps", ["-ww", "-p", String(job!.workerPgid), "-o", "command="], { timeout: 2000, maxBuffer: 64 * 1024 }, (error, stdout) => {
            if (error) {
                if (error.code === 1) resolve(false);
                else reject(new Error("setup_worker_identity_unavailable"));
            } else resolve(stdout.trim().endsWith(" " + job!.workerIdentity));
        });
    });
}
export class OmlxSetupManager {
    readonly root: string;
    readonly basePath: string;
    private readonly runtime: string;
    private readonly run: Runner;
    private running: Promise<void> | undefined;
    private leaseHeld = false;
    private logBytes = 0;
    private logTail = Promise.resolve();
    constructor(private readonly options: OmlxSetupOptions = {}) {
        this.root = join(options.home ?? homedir(), ".prism-mcp", "omlx");
        this.basePath = join(this.root, "server");
        this.runtime = join(this.root, "runtime-" + OMLX_SETUP_COMMIT.slice(0, 12));
        this.run = options.run ?? runSetupCommand;
    }
    private async privateDirectory(path: string) {
        await mkdirUsable(path);
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0) throw new Error("setup_directory_unsafe");
    }
    private async saveJob(job: Job) {
        const temporary = join(this.root, "job-" + job.id + ".tmp");
        await writeFile(temporary, JSON.stringify(job), { mode: 0o600 });
        await rename(temporary, join(this.root, "setup.json"));
    }
    private log = (text: string) => {
        if (this.logBytes >= MAX_LOG_BYTES) return;
        const part = text.slice(0, MAX_LOG_BYTES - this.logBytes); this.logBytes += Buffer.byteLength(part);
        this.logTail = this.logTail.then(() => appendFile(join(this.root, "setup.log"), part, { mode: 0o600 })).catch(() => {});
    };
    async status() {
        const supported = (this.options.platform ?? platform()) === "darwin" && (this.options.arch ?? arch()) === "arm64"
            && Number((this.options.release ?? release()).split(".")[0]) >= 24;
        const memory = this.options.totalmem ?? totalmem();
        const disk = await (this.options.freeDisk?.() ?? statfs(this.options.home ?? homedir()).then(stat => stat.bavail * stat.bsize));
        const marker = await readJson(join(this.root, "runtime.json"));
        const installed = marker?.commit === OMLX_SETUP_COMMIT && await exists(join(this.runtime, "bin", "omlx"));
        const models = await Promise.all(OMLX_SETUP_MODELS.map(async model => {
            const record = await readJson(join(this.root, model.id + ".json"));
            const ready = record?.revision === model.revision && await modelFilesPresent(join(this.basePath, "models", model.id));
            return { ...model, downloaded: Boolean(ready) };
        }));
        let job: Job | undefined = await readJson(join(this.root, "setup.json"));
        if (job?.state === "running" && !await this.setupActive()) job = await workerActive(job)
            ? { ...job, error: "A previous setup worker is still stopping. Wait before retrying." }
            : { ...job, state: "interrupted", error: "Setup was interrupted. Retry to resume the downloads." };
        let server: { connected: boolean; models: string[] } = { connected: false, models: [] };
        if (await exists(join(this.basePath, "settings.json"))) {
            try {
                const inspection = await (this.options.inspect ?? inspectOmlx)({ home: this.options.home, basePath: this.basePath, env: {} });
                server = { connected: true, models: inspection.advertised_models };
            } catch { /* Availability is separate from installation. */ }
        }
        return { supported, memoryGB: Math.floor(memory / GIB), freeDiskGB: Math.floor(disk / GIB),
            requirements: { memoryGB: MIN_RAM / GIB, freeDiskGB: installed && models.every(model => model.downloaded) ? 0 :
                10 + (installed ? 0 : 5) + models.filter(model => !model.downloaded).reduce((sum, model) => sum + model.approximateGB, 0) }, installed, models, job: job ?? null, server };
    }
    private async acquire() {
        const lease = createServer(socket => socket.destroy());
        await new Promise<void>((resolve, reject) => {
            lease.once("error", () => reject(new OmlxSetupError("Another oMLX setup is running. Wait for it to finish.")));
            lease.listen({ host: "127.0.0.1", port: this.options.leasePort ?? SETUP_LEASE_PORT, exclusive: true }, resolve);
        });
        this.leaseHeld = true;
        return () => new Promise<void>(resolve => lease.close(() => { this.leaseHeld = false; resolve(); }));
    }
    private async setupActive(): Promise<boolean> {
        if (this.leaseHeld) return true;
        if (this.options.leasePort === 0) return false; // Isolated test instance.
        return new Promise<boolean>((resolve, reject) => {
            const socket = createConnection({ host: "127.0.0.1", port: this.options.leasePort ?? SETUP_LEASE_PORT });
            socket.once("connect", () => { socket.destroy(); resolve(true); });
            socket.once("error", error => (error as NodeJS.ErrnoException).code === "ECONNREFUSED" ? resolve(false) : reject(error));
            socket.setTimeout(1000, () => { socket.destroy(); reject(new Error("setup_lease_state_unavailable")); });
        });
    }
    async install() {
        if (this.running) throw new OmlxSetupError("oMLX setup is already running.");
        const releaseLease = await this.acquire();
        try {
            const state = await this.status();
            if (await workerActive(state.job ?? undefined)) throw new OmlxSetupError("A previous setup worker is still running. Wait before retrying.");
            if (!state.supported) throw new OmlxSetupError("oMLX setup requires Apple Silicon and macOS 15 or later.");
            if (state.memoryGB < MIN_RAM / GIB) throw new OmlxSetupError("The recommended model pack requires at least 32 GiB of unified memory.");
            if (state.freeDiskGB < state.requirements.freeDiskGB)
                throw new OmlxSetupError("Free at least " + state.requirements.freeDiskGB + " GiB of disk space to install the remaining stages.");
            let python: string | undefined;
            for (const candidate of ["python3.13", "python3.12", "python3.11", "python3"]) {
                try {
                    const version = await this.run(candidate, ["-c", "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')"], { timeoutMs: 5_000 });
                    if (/^3\.(11|12|13)$/.test(version.trim())) { python = candidate; break; }
                } catch { /* Try the next supported interpreter. */ }
            }
            if (!python) throw new OmlxSetupError("Install Python 3.11–3.13, then retry. Existing Python environments are preserved.");
            await this.privateDirectory(this.root);
            const job: Job = { id: randomUUID(), state: "running", stage: "Preparing oMLX", pid: process.pid, startedAt: new Date().toISOString() };
            await this.saveJob(job);
            this.logBytes = 0;
            await writeFile(join(this.root, "setup.log"), "", { mode: 0o600 });
            this.running = this.performInstall(python, state, job).catch(async () => {
                await this.saveJob({ ...job, state: "failed", error: "Setup failed during " + job.stage + ". Retry to resume. Details are in ~/.prism-mcp/omlx/setup.log." });
            }).finally(async () => { await this.logTail; this.running = undefined; await releaseLease(); });
            void this.running.catch(() => console.error("[omlx setup] Unable to persist setup status."));
            return { id: job.id, state: "running" };
        } catch (error) { await releaseLease(); throw error; }
    }
    private async performInstall(python: string, state: Awaited<ReturnType<OmlxSetupManager["status"]>>, job: Job) {
        const stage = async (label: string) => { job.stage = label; await this.saveJob(job); };
        const command: Runner = async (program, args, options) => {
            try { return await this.run(program, args, { ...options, onSpawn: async (pgid, identity) => { job.workerPgid = pgid; job.workerIdentity = identity; await this.saveJob(job); } }); }
            finally { delete job.workerPgid; delete job.workerIdentity; await this.saveJob(job); }
        };
        if (!state.installed) {
            await stage("Installing isolated Python runtime");
            await command(python, ["-m", "venv", this.runtime], { timeoutMs: 60_000, log: this.log });
            await stage("Installing pinned oMLX server");
            await command(join(this.runtime, "bin", "python"), ["-m", "pip", "install", "git+https://github.com/dcostenco/omlx.git@" + OMLX_SETUP_COMMIT], { timeoutMs: INSTALL_TIMEOUT_MS, log: this.log });
            await command(join(this.runtime, "bin", "python"), ["-c", "import omlx.api.prism_control_routes; import huggingface_hub"], { timeoutMs: 30_000, log: this.log });
            await writeFile(join(this.root, "runtime.json"), JSON.stringify({ commit: OMLX_SETUP_COMMIT }), { mode: 0o600 });
        }
        await this.privateDirectory(this.basePath);
        for (const model of state.models) {
            if (model.downloaded) continue;
            await stage("Downloading " + model.label);
            const destination = join(this.basePath, "models", model.id);
            await command(join(this.runtime, "bin", "hf"), ["download", model.repo, "--revision", model.revision, "--local-dir", destination], { timeoutMs: DOWNLOAD_TIMEOUT_MS, log: this.log });
            if (!await modelFilesPresent(destination)) throw new Error("model_download_incomplete");
            await writeFile(join(this.root, model.id + ".json"), JSON.stringify({ revision: model.revision }), { mode: 0o600 });
        }
        await stage("Configuring the managed server");
        const settings = { server: { host: "127.0.0.1", port: SERVER_PORT },
            model: { model_dirs: [join(this.basePath, "models")] }, scheduler: { chunked_prefill: true },
            huggingface: { hf_cache_enabled: false },
            auth: { api_key: randomBytes(32).toString("hex"), skip_api_key_verification: false },
            sampling: { max_context_window: 32768, max_tokens: 4096 },
            cache: { ssd_cache_max_size: "10GB", hot_cache_max_size: "0" },
            idle_timeout: { idle_timeout_seconds: 300 },
            memory: { prefill_memory_guard: true, memory_guard_tier: "balanced" } };
        const profiles = Object.fromEntries(OMLX_SETUP_MODELS.map((model, index) => [model.id, {
            max_context_window: 32768, max_tokens: 4096, is_default: index === 1, is_pinned: false,
            enable_thinking: index === 1, thinking_budget_enabled: index === 1, thinking_budget_tokens: 2048,
            mtp_enabled: false, vlm_mtp_enabled: false, dflash_enabled: false, specprefill_enabled: false,
        }]));
        for (const [name, document] of [["settings.json", settings], ["model_settings.json", { version: 1, models: profiles }]] as const) {
            try { await writeFile(join(this.basePath, name), JSON.stringify(document, null, 2), { flag: "wx", mode: 0o600 }); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        }
        await this.saveJob({ ...job, state: "complete", stage: "Server and recommended models installed" });
    }
    async waitForInstall() { await this.running; }
    async start() {
        const releaseLease = await this.acquire();
        try {
            const state = await this.status();
            if (await workerActive(state.job ?? undefined)) throw new OmlxSetupError("A previous setup worker is still running. Wait before starting the server.");
            if (state.server.connected) return { running: true, alreadyRunning: true };
            if (!state.supported || !state.installed || state.models.some(model => !model.downloaded))
                throw new OmlxSetupError("Install oMLX and both recommended models before starting the managed server.");
            const probe = createServer();
            await new Promise<void>((resolve, reject) => {
                probe.once("error", () => reject(new OmlxSetupError("Port 8001 is already in use. The existing process was left running.")));
                probe.listen({ host: "127.0.0.1", port: this.options.serverPort ?? SERVER_PORT, exclusive: true }, resolve);
            });
            await new Promise<void>(resolve => probe.close(() => resolve()));
            const log = await open(join(this.root, "server.log"), "a", 0o600);
            const env = Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : []));
            // The managed runtime must neither discover shared cached weights
            // nor replace the interpreter advertised by another installation.
            env.HF_HUB_CACHE = join(this.basePath, "hf-cache");
            env.OMLX_CLUSTER_SHIM_DIRECTORY = join(this.basePath, "bin");
            let child;
            try {
                child = spawn(join(this.runtime, "bin", "omlx"), ["serve", "--base-path", this.basePath],
                    { env, detached: true, stdio: ["ignore", log.fd, log.fd] });
                await new Promise<void>((resolve, reject) => { child!.once("spawn", resolve); child!.once("error", () => reject(new Error("Unable to start the managed oMLX server."))); });
                child.unref();
            } finally { await log.close(); }
            // Keep the setup lease through startup. A second dashboard or CLI
            // cannot spawn a duplicate while this process has not yet bound.
            const deadline = Date.now() + (this.options.startTimeoutMs ?? 90_000);
            let interrupted: NodeJS.Signals | undefined;
            const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
            const handlers = signals.map(signal => { const handler = () => { interrupted = signal; }; process.on(signal, handler); return handler; });
            const onExit = () => { try { process.kill(-child.pid!, "SIGTERM"); } catch { /* stopped */ } };
            process.once("exit", onExit);
            try {
                while (Date.now() < deadline) {
                    if (interrupted) throw new Error("server_start_interrupted");
                    if (child.exitCode !== null || child.signalCode !== null) throw new Error("server_exited");
                    const state = await this.status();
                    if (state.server.connected) return { running: true, alreadyRunning: false, pid: child.pid };
                    await new Promise(resolve => setTimeout(resolve, 500));
                }
                throw new Error("server_start_timeout");
            } catch {
                // Only this invocation's still-starting child is terminated.
                if (child.exitCode === null && child.signalCode === null) {
                    const closed = new Promise<void>(resolve => child.once("close", () => resolve()));
                    try { process.kill(-child.pid!, "SIGTERM"); } catch { /* exited */ }
                    const killTimer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* exited */ } }, 2_000);
                    await closed; clearTimeout(killTimer);
                }
                throw new OmlxSetupError("Managed oMLX did not start. Check ~/.prism-mcp/omlx/server.log, then retry. Existing servers were left running.");
            } finally {
                process.removeListener("exit", onExit);
                signals.forEach((signal, index) => process.removeListener(signal, handlers[index]));
                if (interrupted) setImmediate(() => process.kill(process.pid, interrupted!));
            }
        } finally { await releaseLease(); }
    }
}

export const omlxSetup = new OmlxSetupManager();
