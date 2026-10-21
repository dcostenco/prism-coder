import { afterEach, describe, expect, it } from "vitest";
import { createClient } from "@libsql/client";
import { join } from "node:path";
import { closeConfigStorage, getSetting, setSetting } from "../../src/storage/configStorage.js";

afterEach(() => closeConfigStorage());

describe("settings saved by another Prism process", () => {
    it("lets runtime preferences observe an external save despite a warm process cache", async () => {
        const key = "local_coding_backend";
        await setSetting(key, "ollama");
        expect(await getSetting(key)).toBe("ollama");
        const path = process.env.PRISM_CONFIG_PATH!;
        expect(path).toContain(join("tests", ".tmp", "prism-config-"));
        const otherProcessConnection = createClient({ url: `file:${path}` });
        try {
            await otherProcessConnection.execute({ sql: "UPDATE system_settings SET value=? WHERE key=?", args: ["omlx", key] });
        } finally { otherProcessConnection.close(); }
        expect(await getSetting(key)).toBe("ollama");
        expect(await getSetting(key, "auto", { fresh: true })).toBe("omlx");
    });
});
