import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverOwnedJob } from "../../src/utils/omlxJobControl.js";

// The owned-job marker is read with one open and no stat before it, so nothing
// can change between a check and the read. These pin what that open must
// refuse: a symlink (O_NOFOLLOW), a FIFO without blocking (O_NONBLOCK), a
// directory, and an oversize file; a missing marker is simply no marker.
const PROVIDER = "http://127.0.0.1:8000/v1";
const markerName = createHash("sha256").update(PROVIDER).digest("hex") + ".json";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function stateDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "prism-owned-marker-test-")); // created 0700
    dirs.push(dir);
    return dir;
}
function marker(active: boolean) {
    return { version: 2, provider_hash: createHash("sha256").update(PROVIDER).digest("hex"), job_id: randomUUID(),
        operation_id: null, provider_request_id: null, provider_started: false, active };
}
const idle = () => vi.fn(async () => ({ idle_verified: true }));

describe("the owned-job marker reader", () => {
    it("treats a missing marker as no marker", async () => {
        const observe = idle();
        await expect(recoverOwnedJob({ providerId: PROVIDER, stateDirectory: await stateDir(), observe })).resolves.toBeUndefined();
        expect(observe).not.toHaveBeenCalled();
    });

    it("never follows a symlink, even to a valid active marker", async () => {
        const dir = await stateDir(), elsewhere = await stateDir();
        await writeFile(join(elsewhere, "real.json"), JSON.stringify(marker(true)));
        await symlink(join(elsewhere, "real.json"), join(dir, markerName));
        const observe = idle();
        await expect(recoverOwnedJob({ providerId: PROVIDER, stateDirectory: dir, observe })).rejects.toThrow("owned_job_marker_invalid");
        expect(observe).not.toHaveBeenCalled();
    });

    it("refuses a FIFO without blocking on it", async () => {
        const dir = await stateDir();
        execFileSync("mkfifo", [join(dir, markerName)]);
        await expect(recoverOwnedJob({ providerId: PROVIDER, stateDirectory: dir, observe: idle() })).rejects.toThrow("owned_job_marker_invalid");
    }, 3000);

    it("refuses a directory and an oversize file", async () => {
        const dir = await stateDir();
        await mkdir(join(dir, markerName));
        await expect(recoverOwnedJob({ providerId: PROVIDER, stateDirectory: dir, observe: idle() })).rejects.toThrow("owned_job_marker_invalid");
        const big = await stateDir();
        await writeFile(join(big, markerName), JSON.stringify({ ...marker(true), pad: "x".repeat(5000) }));
        await expect(recoverOwnedJob({ providerId: PROVIDER, stateDirectory: big, observe: idle() })).rejects.toThrow("owned_job_marker_invalid");
    });

    it("reads a valid marker: inactive is left alone, active is cleared only on proof of idle", async () => {
        const inactive = await stateDir();
        await writeFile(join(inactive, markerName), JSON.stringify(marker(false)));
        const untouched = idle();
        await recoverOwnedJob({ providerId: PROVIDER, stateDirectory: inactive, observe: untouched });
        expect(untouched).not.toHaveBeenCalled();

        const active = await stateDir();
        await writeFile(join(active, markerName), JSON.stringify(marker(true)));
        const observe = idle();
        await recoverOwnedJob({ providerId: PROVIDER, stateDirectory: active, observe });
        expect(observe).toHaveBeenCalledTimes(1);
        expect(JSON.parse(await readFile(join(active, markerName), "utf8")).active).toBe(false);
    });
});
