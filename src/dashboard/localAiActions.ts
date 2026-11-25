import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { getSetting, compareAndSetSetting } from "../storage/configStorage.js";
import { LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, parseLocalCodingSettings, resolveLocalCodingModel, type OmlxSource } from "../utils/localCodingSettings.js";
import { LOCAL_IMAGE_SETTING_KEY, parseLocalImageSettings } from "../utils/localImageSettings.js";
import { inspectOmlx, inspectOmlxControl } from "../utils/omlxProvider.js";
import { EXECUTION_ROLES_KEY, parseExecutionAssignments, configuredHostProfiles } from "../utils/executionRoles.js";

const ABSENT = "local_ai_setting_absent";
const MODEL_SAVE_CONFLICT = "Preferences changed. Use Reload saved choices, then review and retry.";
export interface LocalAiSaveRevision { previousRevision: string; revision: string; }
function localAiRevision(expected: Record<string, string | null>): string {
    return createHash("sha256").update(JSON.stringify(expected)).digest("hex");
}
export class LocalAiConflict extends Error {}
export async function localAiSnapshot() {
    const keys = [LOCAL_CODING_SETTING_KEY, LEGACY_LOCAL_CODING_SETTING_KEY, LOCAL_IMAGE_SETTING_KEY, EXECUTION_ROLES_KEY];
    const raw = await Promise.all(keys.map(key => getSetting(key, ABSENT, { fresh: true })));
    const expected = Object.fromEntries(keys.map((key, index) => [key, raw[index] === ABSENT ? null : raw[index]]));
    const current = raw[0] !== ABSENT && raw[0] ? raw[0] : raw[1] !== ABSENT ? raw[1] : "";
    const settings = current ? parseLocalCodingSettings(JSON.parse(current)) : parseLocalCodingSettings({ backend: "auto", source: "existing" });
    const image = raw[2] !== ABSENT && raw[2] ? parseLocalImageSettings(JSON.parse(raw[2])) : {};
    const assignments = raw[3] !== ABSENT && raw[3] ? parseExecutionAssignments(JSON.parse(raw[3])) : {};
    return { settings, image, assignments, expected, revision: localAiRevision(expected) };
}
/** Advance a known image-only snapshot, without borrowing another form's newer state. */
export async function saveLocalAiImages(value: unknown): Promise<LocalAiSaveRevision> {
    const image = JSON.stringify(parseLocalImageSettings(value)), snapshot = await localAiSnapshot();
    if (!await compareAndSetSetting(LOCAL_IMAGE_SETTING_KEY, image, snapshot.expected))
        throw new LocalAiConflict(MODEL_SAVE_CONFLICT);
    return { previousRevision: snapshot.revision,
        revision: localAiRevision({ ...snapshot.expected, [LOCAL_IMAGE_SETTING_KEY]: image }) };
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
export async function saveLocalAiModels(value: unknown, revision?: string) {
    const input = parseLocalCodingSettings(value), snapshot = await localAiSnapshot();
    if (!revision || revision !== snapshot.revision) throw new LocalAiConflict(MODEL_SAVE_CONFLICT);
    if (!await compareAndSetSetting(LOCAL_CODING_SETTING_KEY, JSON.stringify({ ...input, source: snapshot.settings.source }), snapshot.expected)) {
        throw new LocalAiConflict(MODEL_SAVE_CONFLICT);
    }
}
export async function saveExecutionRoles(value: unknown, revision: unknown) {
    const input = parseExecutionAssignments(value), snapshot = await localAiSnapshot();
    if (typeof revision !== "string" || revision !== snapshot.revision) throw new LocalAiConflict(MODEL_SAVE_CONFLICT);
    const hosts = Object.values(input).some(v => v.runtime === "host") ? await configuredHostProfiles() : [];
    if (Object.values(input).some(v => v.runtime === "host" && !hosts.some(p => p.id === v.profile))) throw new Error("execution_host_unavailable");
    if (!await compareAndSetSetting(EXECUTION_ROLES_KEY, JSON.stringify(input), snapshot.expected))
        throw new LocalAiConflict(MODEL_SAVE_CONFLICT);
}
export function localAiAssignments(settings: Awaited<ReturnType<typeof localAiSnapshot>>["settings"], image: Awaited<ReturnType<typeof localAiSnapshot>>["image"]) {
    return [
        { purpose: "coder", model: resolveLocalCodingModel(settings, "omlx", "coder") },
        { purpose: "reviewer", model: resolveLocalCodingModel(settings, "omlx", "reviewer") },
        { purpose: "image", model: image.models?.omlx },
    ];
}
