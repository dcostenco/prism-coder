import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSetting, compareAndSetSetting } from "../storage/configStorage.js";
import { LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, parseLocalCodingSettings, resolveLocalCodingModel, type OmlxSource } from "../utils/localCodingSettings.js";
import { LOCAL_IMAGE_SETTING_KEY, parseLocalImageSettings } from "../utils/localImageSettings.js";
import { inspectOmlx, inspectOmlxControl } from "../utils/omlxProvider.js";

const ABSENT = "local_ai_setting_absent";
export class LocalAiConflict extends Error {}
export async function localAiSnapshot() {
    const keys = [LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, LOCAL_IMAGE_SETTING_KEY];
    const raw = await Promise.all(keys.map(key => getSetting(key, ABSENT, { fresh: true })));
    const expected = Object.fromEntries(keys.map((key, index) => [key, raw[index] === ABSENT ? null : raw[index]]));
    const current = raw[0] !== ABSENT && raw[0] ? raw[0] : raw[1] !== ABSENT ? raw[1] : "";
    const settings = current ? parseLocalCodingSettings(JSON.parse(current)) : parseLocalCodingSettings({ backend: "auto", source: "existing" });
    const image = raw[2] !== ABSENT && raw[2] ? parseLocalImageSettings(JSON.parse(raw[2])) : {};
    return { settings, image, expected, revision: createHash("sha256").update(JSON.stringify(expected)).digest("hex") };
}
export async function inspectLocalAiSource(source: OmlxSource) {
    const options = { basePath: source === "managed" ? join(homedir(), ".prism-mcp", "omlx", "server") : join(homedir(), ".omlx") };
    const [inspection, control] = await Promise.all([inspectOmlx(options), inspectOmlxControl(options)]);
    return { source, connected: true, control, models: inspection.advertised_models,
        adminUrl: new URL(inspection.url).origin + "/admin", version: inspection.status.version };
}
export async function activateLocalAiSource(source: OmlxSource, revision: string) {
    const snapshot = await localAiSnapshot();
    if (snapshot.revision !== revision || !await compareAndSetSetting(LOCAL_CODING_SETTING_KEY,
        JSON.stringify({ ...snapshot.settings, source }), snapshot.expected)) throw new LocalAiConflict("Preferences changed. Refresh the connection preview and retry.");
}
/** A model-form save must never undo another window's connection activation. */
export async function saveLocalAiModels(value: unknown) {
    const input = parseLocalCodingSettings(value), snapshot = await localAiSnapshot();
    if (!await compareAndSetSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({ ...input, source: snapshot.settings.source }), snapshot.expected)) {
        throw new LocalAiConflict("Preferences changed. Refresh the saved models and retry.");
    }
}
export function localAiAssignments(settings: Awaited<ReturnType<typeof localAiSnapshot>>["settings"], image: Awaited<ReturnType<typeof localAiSnapshot>>["image"]) {
    return [
        { purpose: "coder", model: resolveLocalCodingModel(settings, "omlx", "coder") },
        { purpose: "reviewer", model: resolveLocalCodingModel(settings, "omlx", "reviewer") },
        { purpose: "image", model: image.models?.omlx },
    ];
}
