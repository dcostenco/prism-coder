import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeConfigStorage, compareAndSetSetting, getSetting, setSetting } from "../../src/storage/configStorage.js";
import { activateLocalAiSource, localAiSnapshot, saveLocalAiModels } from "../../src/dashboard/localAiActions.js";
import { LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY } from "../../src/utils/localCodingSettings.js";
import { LOCAL_IMAGE_SETTING_KEY } from "../../src/utils/localImageSettings.js";

beforeEach(async () => {
    closeConfigStorage();
    vi.stubEnv("PRISM_CONFIG_PATH", join(await mkdtemp(join(tmpdir(), "local-ai-cas-")), "config.db"));
});
afterEach(() => { closeConfigStorage(); vi.unstubAllEnvs(); });
describe("connection activation preserves concurrent preferences", () => {
    it("an older model form cannot undo a newer connection activation", async () => {
        await setSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({ backend: "auto", source: "managed" }));
        await saveLocalAiModels({ backend: "omlx", source: "existing", models: { omlx: { coder: "new/build" } } });
        expect((await localAiSnapshot()).settings).toEqual({ backend: "omlx", source: "managed", models: { omlx: { coder: "new/build" } } });
    });
    it("atomically creates an absent key and refuses a stale expectation without a cache write", async () => {
        expect(await compareAndSetSetting("choice", "one", { choice: null })).toBe(true);
        expect(await compareAndSetSetting("choice", "two", { choice: null })).toBe(false);
        expect(await getSetting("choice", "", { fresh: true })).toBe("one");
        expect(await compareAndSetSetting("choice", "two", { choice: "one", dependency: null })).toBe(true);
        await setSetting("dependency", "changed");
        expect(await compareAndSetSetting("choice", "three", { choice: "two", dependency: null })).toBe(false);
        expect(await getSetting("choice")).toBe("two");
    });
    it("preserves independent role/image IDs, legacy settings and backend while changing only shared source", async () => {
        const coding = { backend: "ollama", source: "existing", models: { omlx: { coder: "future/build", reviewer: "future/build" } } };
        const image = { backend: "omlx", models: { omlx: "future/vision" } };
        await setSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify(coding));
        await setSetting(LEGACY_LOCAL_CODING_SETTING_KEY, JSON.stringify({ backend: "auto", source: "existing" }));
        await setSetting(LOCAL_IMAGE_SETTING_KEY, JSON.stringify(image));
        const preview = await localAiSnapshot();
        await activateLocalAiSource("managed", preview.revision);
        const after = await localAiSnapshot();
        expect(after.settings).toEqual({ ...coding, source: "managed" });
        expect(after.image).toEqual(image);
        expect(after.expected[LEGACY_LOCAL_CODING_SETTING_KEY]).toBe(preview.expected[LEGACY_LOCAL_CODING_SETTING_KEY]);
    });
    it.each([LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, LOCAL_IMAGE_SETTING_KEY])("rejects a changed %s after preview", async key => {
        const before = await localAiSnapshot();
        const value = key === LOCAL_IMAGE_SETTING_KEY ? { backend: "omlx", models: { omlx: "new/vision" } } : { backend: "ollama", source: "existing" };
        await setSetting(key, JSON.stringify(value));
        await expect(activateLocalAiSource("managed", before.revision)).rejects.toThrow("Preferences changed");
        expect(await getSetting(key, "", { fresh: true })).toBe(JSON.stringify(value));
    });
});
