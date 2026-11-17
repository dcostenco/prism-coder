import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
let { closeConfigStorage, compareAndSetSetting, getSetting, setSetting } = await import("../../src/storage/configStorage.js");
let { activateLocalAiSource, localAiSnapshot, saveLocalAiModels, saveLocalAiImages, saveExecutionRoles } = await import("../../src/dashboard/localAiActions.js");
import { LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY } from "../../src/utils/localCodingSettings.js";
import { LOCAL_IMAGE_SETTING_KEY } from "../../src/utils/localImageSettings.js";
let { localCodingPreference } = await import("../../src/utils/localCodingPreference.js");

beforeEach(async () => {
    closeConfigStorage();
    vi.resetModules();
    vi.stubEnv("PRISM_CONFIG_PATH", join(await mkdtemp(join(tmpdir(), "local-ai-cas-")), "config.db"));
    ({ closeConfigStorage, compareAndSetSetting, getSetting, setSetting } = await import("../../src/storage/configStorage.js"));
    ({ activateLocalAiSource, localAiSnapshot, saveLocalAiModels, saveLocalAiImages, saveExecutionRoles } = await import("../../src/dashboard/localAiActions.js"));
    ({ localCodingPreference } = await import("../../src/utils/localCodingPreference.js"));
});
afterEach(() => { closeConfigStorage(); vi.unstubAllEnvs(); });
describe("connection activation preserves concurrent preferences", () => {
    it('non-code preference reads exclude saved execution roles without changing the saved backend', async () => {
        vi.stubEnv('PRISM_LOCAL_CODING_BACKEND',undefined);
        const start = await localAiSnapshot();
        await saveExecutionRoles({coder:{runtime:'omlx',model:'fixture/code'}},start.revision);
        expect((await localCodingPreference('coder',undefined,false)).effective).toBe('omlx');
        const plain = await localCodingPreference('coder',undefined,false,undefined,false);
        expect(plain).toMatchObject({saved:'auto',effective:'auto'});
        expect(plain.assignment).toBeUndefined();
    });
    it('an image save returns only its own revision transition and preserves role/model choices', async () => {
        const before = await localAiSnapshot();
        const update = await saveLocalAiImages({backend:'omlx',models:{omlx:'fixture/vision'}});
        expect(update.previousRevision).toBe(before.revision);
        expect(update.revision).toBe((await localAiSnapshot()).revision);
        await saveExecutionRoles({coder:{runtime:'synalux'}}, update.revision);
        const after = await localAiSnapshot();
        expect(after.image).toEqual({backend:'omlx',models:{omlx:'fixture/vision'}});
        expect(after.assignments).toEqual({coder:{runtime:'synalux'}});
    });
    it('an image-save revision does not authorize a model save over a later role change', async () => {
        const update = await saveLocalAiImages({backend:'omlx'});
        await saveExecutionRoles({reviewer:{runtime:'synalux'}},update.revision);
        await expect(saveLocalAiModels({backend:'ollama',source:'existing'},update.revision)).rejects.toThrow('Preferences changed');
        expect((await localAiSnapshot()).assignments.reviewer).toEqual({runtime:'synalux'});
    });
    it("an older model form cannot undo a newer connection activation", async () => {
        await setSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({ backend: "auto", source: "managed" }));
        const snapshot = await localAiSnapshot();
        await saveLocalAiModels({ backend: "omlx", source: "existing", models: { omlx: { coder: "new/build" } } }, snapshot.revision);
        expect((await localAiSnapshot()).settings).toEqual({ backend: "omlx", source: "managed", models: { omlx: { coder: "new/build" } } });
    });
    it("rejects an older whole form and role form after another tab saves", async () => {
        const stale = await localAiSnapshot();
        await saveLocalAiModels({ backend: "ollama", source: "existing" }, stale.revision);
        await expect(saveLocalAiModels({ backend: "omlx", source: "existing" }, stale.revision)).rejects.toThrow("Preferences changed");
        await expect(saveExecutionRoles({ reviewer: { runtime: "synalux" } }, stale.revision)).rejects.toThrow("Preferences changed");
        const fresh = await localAiSnapshot();
        await saveExecutionRoles({ reviewer: { runtime: "synalux" } }, fresh.revision);
        expect((await localAiSnapshot()).assignments).toEqual({ reviewer: { runtime: "synalux" } });
        expect((await localAiSnapshot()).settings.backend).toBe("ollama");
        await expect(activateLocalAiSource("managed", fresh.revision)).rejects.toThrow("Preferences changed");
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
