import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { beginLocalAiMaintenance, checkLocalAiMaintenance, managedMaintenancePath } from "../../src/utils/localAiMaintenance.js";
describe("durable restart safety", () => {
    it("blocks after an interrupted owner and clears only the exact completion record", async () => {
        const home = await mkdtemp(join(tmpdir(), "maintenance-")), path = managedMaintenancePath(home);
        await mkdir(dirname(path), { recursive: true });
        await expect(checkLocalAiMaintenance(home)).resolves.toBeUndefined();
        const clear = await beginLocalAiMaintenance(home, 'test-operation');
        await expect(checkLocalAiMaintenance(home)).rejects.toThrow('operator recovery');
        await expect(beginLocalAiMaintenance(home, 'second')).rejects.toMatchObject({ code: 'EEXIST' });
        await clear();
        await expect(checkLocalAiMaintenance(home)).resolves.toBeUndefined();
    });
    it("keeps a changed marker blocked instead of clearing somebody else's state", async () => {
        const home = await mkdtemp(join(tmpdir(), "maintenance-")), path = managedMaintenancePath(home);
        await mkdir(dirname(path), { recursive: true });
        const clear = await beginLocalAiMaintenance(home, 'first');
        await writeFile(path, '{"id":"other"}');
        await expect(clear()).rejects.toThrow('maintenance_identity_changed');
        expect(await readFile(path, 'utf8')).toBe('{"id":"other"}');
        await expect(checkLocalAiMaintenance(home)).rejects.toThrow('operator recovery');
    });
});
