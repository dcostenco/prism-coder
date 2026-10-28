import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
const transport = vi.hoisted(() => ({ identity: "", listeners: "", failPs: false, busy: false, released: vi.fn(),
    exec: undefined as undefined | ((program: string, args: string[]) => string | Error), spawn: undefined as undefined | (() => any) }));
vi.mock("node:child_process", async original => {
    const actual = await original<typeof import("node:child_process")>();
    return { ...actual, execFile: (program: string, args: string[], _options: unknown, callback: Function) => {
        const value = transport.exec ? transport.exec(program, args) : transport.failPs && program === "/bin/ps" ? Object.assign(new Error("ps failed"), { code: "EIO" }) : program === "/bin/ps" ? transport.identity : transport.listeners;
        queueMicrotask(() => callback(value instanceof Error ? value : null, value instanceof Error ? "" : value));
    }, spawn: (...args: Parameters<typeof actual.spawn>) => transport.spawn ? transport.spawn() : actual.spawn(...args) };
});
vi.mock("../../src/utils/omlxProvider.js", async original => ({ ...await original<object>(), acquireOmlxLease: async () => {
    if (transport.busy) throw new Error("device_busy");
    return transport.released;
} }));
import { OMLX_SETUP_COMMIT, OmlxSetupManager } from "../../src/utils/omlxSetup.js";
import { checkLocalAiMaintenance, managedMaintenancePath } from "../../src/utils/localAiMaintenance.js";
const PID = 92345, PORT = 8127, BIRTH = "Tue Oct 27 12:00:00 2026";
async function fixture(activity: Record<string, unknown> = { active_requests: 0, waiting_requests: 0, models_loading: 0 }) {
    const home = await mkdtemp(join(tmpdir(), "omlx-ownership-"));
    const manager = new OmlxSetupManager({ home, platform: "darwin", arch: "arm64", release: "24", leasePort: 0,
        freeDisk: async () => 50 * 1024 ** 3, inspect: async () => ({ advertised_models: [], status: activity }) as any });
    const runtime = join(manager.root, "runtime-" + OMLX_SETUP_COMMIT.slice(0, 12));
    await mkdir(join(runtime, "bin"), { recursive: true });
    await writeFile(join(runtime, "bin", "omlx"), "fixture");
    await writeFile(join(manager.root, "runtime.json"), JSON.stringify({ commit: OMLX_SETUP_COMMIT }));
    await mkdir(manager.basePath, { recursive: true });
    await writeFile(join(manager.basePath, "settings.json"), JSON.stringify({ server: { host: "127.0.0.1", port: PORT }, auth: { api_key: randomUUID(), skip_api_key_verification: false } }), { mode: 0o600 });
    const record = { pid: PID, pgid: PID, uid: process.getuid!(), startIdentity: BIRTH, runtime, commit: OMLX_SETUP_COMMIT, port: PORT };
    await writeFile(join(manager.root, "server.json"), JSON.stringify(record), { mode: 0o600 });
    transport.identity = `${PID} ${PID} ${process.getuid!()} ${BIRTH} ${runtime}/bin/python ${runtime}/bin/omlx serve --base-path ${manager.basePath}\n`;
    transport.listeners = `p${PID}\nn127.0.0.1:${PORT}\n`;
    return { home, manager, record };
}
afterEach(() => { vi.restoreAllMocks(); transport.busy = false; transport.failPs = false; transport.exec = undefined; transport.spawn = undefined; transport.released.mockClear(); });
describe("managed server identity and quiescence", () => {
    it("retains maintenance and refuses rollback when a replacement orphan survives before its record was saved", async () => {
        const { home, manager } = await fixture();
        const oldIdentity = transport.identity, replacement = 99001;
        let oldAlive = true, spawns = 0;
        const child = Object.assign(new EventEmitter(), { pid: replacement, exitCode: null as number | null, signalCode: null, unref: vi.fn() });
        transport.spawn = () => { spawns++; queueMicrotask(() => child.emit("spawn")); return child; };
        transport.exec = (program, args) => {
            if (program.endsWith('lsof')) return oldAlive ? `p${PID}\nn127.0.0.1:${PORT}\n` : '';
            if (args.includes('-axo')) return oldAlive ? `${PID}\n` : `${replacement}\n`;
            if (args.includes(String(PID))) return oldAlive ? oldIdentity : Object.assign(new Error('old absent'), { code: 1 });
            return Object.assign(new Error('replacement birth lookup failed'), { code: 'EIO' });
        };
        vi.spyOn(process, "kill").mockImplementation(pid => {
            if (pid === PID) oldAlive = false;
            if (pid === -replacement) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); }
            return true;
        });
        await expect(manager.restart()).rejects.toThrow('operator recovery');
        expect(spawns).toBe(1);
        await expect(access(managedMaintenancePath(home))).resolves.toBeUndefined();
        await expect(checkLocalAiMaintenance(home)).rejects.toThrow('operator recovery');
    }, 12_000);
    it("recognizes a matching empty-inventory server on its persisted port", async () => {
        const { manager } = await fixture();
        expect((await manager.status()).server).toMatchObject({ owned: true, connected: true, port: PORT, models: [] });
        expect((await manager.status()).runtime.runningCommit).toBe(OMLX_SETUP_COMMIT);
        expect(await manager.start()).toMatchObject({ alreadyRunning: true });
    });
    it.each(["birth", "uid", "runtime", "listener", "wildcard", "lookup_error"])("refuses foreign/reused identity: %s", async fault => {
        const { manager } = await fixture();
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        if (fault === "birth") transport.identity = transport.identity.replace("12:00:00", "12:00:01");
        if (fault === "uid") transport.identity = transport.identity.replace(`${PID} ${PID} ${process.getuid!()}`, `${PID} ${PID} ${process.getuid!() + 1}`);
        if (fault === "runtime") transport.identity += " --foreign";
        if (fault === "listener") transport.listeners = `p${PID + 1}\nn127.0.0.1:${PORT}\n`;
        if (fault === "wildcard") transport.listeners = `p${PID}\nn*:${PORT}\n`;
        if (fault === "lookup_error") transport.failPs = true;
        expect((await manager.status()).server.owned).toBe(false);
        expect((await manager.status()).runtime.runningCommit).toBeUndefined();
        await expect(manager.start()).rejects.toThrow("ownership");
        await expect(manager.restart()).rejects.toThrow("ownership");
        expect(kill).not.toHaveBeenCalled();
    });
    it.each([
        { active_requests: 1, waiting_requests: 0, models_loading: 0 },
        { active_requests: 0, waiting_requests: 1, models_loading: 0 },
        { active_requests: 0, waiting_requests: 0, models_loading: 1 },
        { active_requests: 0, models_loading: 0 },
    ])("reaches activity refusal after positive ownership: %j", async activity => {
        const { home, manager } = await fixture(activity);
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        expect((await manager.status()).server.owned).toBe(true);
        await expect(manager.restart()).rejects.toThrow("active or unknown work");
        expect(kill).not.toHaveBeenCalled();
        expect(transport.released).toHaveBeenCalledOnce();
        await expect(access(managedMaintenancePath(home))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(checkLocalAiMaintenance(home)).resolves.toBeUndefined();
    });
    it("does not signal if device ownership is busy", async () => {
        const { manager } = await fixture(); transport.busy = true;
        const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
        await expect(manager.restart()).rejects.toThrow("device_busy");
        expect(kill).not.toHaveBeenCalled();
    });
});
