import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const managedMaintenancePath = (home = homedir()) => join(home, ".prism-mcp", "omlx", "maintenance.json");
/** A crashed restart must not silently reopen inference after its OS lease dies. */
export async function checkLocalAiMaintenance(home?: string): Promise<void> {
    let file;
    try {
        file = await open(managedMaintenancePath(home), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        throw new Error("Local AI maintenance needs operator recovery. Check the managed server before retrying.");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally { await file?.close(); }
}
export async function beginLocalAiMaintenance(home: string | undefined, id: string): Promise<() => Promise<void>> {
    const path = managedMaintenancePath(home);
    const file = await open(path, "wx", 0o600);
    const identity = await file.stat();
    const bytes = JSON.stringify({ id, startedAt: new Date().toISOString() });
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    return async () => {
        const current = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const observed = await current.stat();
            if (!observed.isFile() || observed.ino !== identity.ino || observed.dev !== identity.dev
                || observed.size !== Buffer.byteLength(bytes) || await current.readFile("utf8") !== bytes) throw new Error("maintenance_identity_changed");
        } finally { await current.close(); }
        await unlink(path);
    };
}
