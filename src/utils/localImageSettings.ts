import { getSetting, setSetting } from "../storage/configStorage.js";
import { isLocalCodingModelId } from "./localCodingSettings.js";

export const LOCAL_IMAGE_BACKENDS = ["omlx", "ollama"] as const;
export type LocalImageBackend = typeof LOCAL_IMAGE_BACKENDS[number];
export interface LocalImageSettings {
    backend?: LocalImageBackend;
    models?: Partial<Record<LocalImageBackend, string>>;
}
const KEY = "local_image_config_v1";
const FIELDS = new Set(["backend", "models"]);
const INVALID = "local_image_preference_invalid";
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(INVALID);
    return value as Record<string, unknown>;
}
function isBackend(value: unknown): value is LocalImageBackend {
    return LOCAL_IMAGE_BACKENDS.some(backend => backend === value);
}
/** Selection only: neither a saved ID nor a backend grants image readiness. */
export function parseLocalImageSettings(value: unknown): LocalImageSettings {
    const input = record(value), settings: LocalImageSettings = {};
    if (Object.keys(input).some(key => !FIELDS.has(key))) throw new Error(INVALID);
    if (Object.hasOwn(input, "backend")) {
        if (!isBackend(input.backend)) throw new Error(INVALID);
        settings.backend = input.backend;
    }
    if (Object.hasOwn(input, "models")) {
        const models = record(input.models);
        settings.models = {};
        for (const backend of Object.keys(models)) {
            if (!isBackend(backend) || !isLocalCodingModelId(models[backend])) throw new Error(INVALID);
            settings.models[backend] = models[backend];
        }
    }
    return settings;
}
export async function readLocalImageSettings(): Promise<LocalImageSettings> {
    const raw = await getSetting(KEY, "", { fresh: true });
    return raw ? parseLocalImageSettings(JSON.parse(raw)) : {};
}
export async function saveLocalImageSettings(value: unknown): Promise<void> {
    await setSetting(KEY, JSON.stringify(parseLocalImageSettings(value)));
}
