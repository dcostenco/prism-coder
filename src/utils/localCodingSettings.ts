import { getSetting, setSetting } from "../storage/configStorage.js";

export const LOCAL_CODING_BACKENDS = ["auto", "omlx", "ollama"] as const;
export type LocalCodingBackend = typeof LOCAL_CODING_BACKENDS[number];
export type OmlxSource = "existing" | "managed";
export const LOCAL_CODING_ROLES = ["coder", "reviewer"] as const;
export type LocalCodingRole = typeof LOCAL_CODING_ROLES[number];
export type LocalCodingModels = Partial<Record<"omlx" | "ollama", Partial<Record<LocalCodingRole, string>>>>;
export interface LocalCodingSettings { backend: LocalCodingBackend; source: OmlxSource; model?: string; models?: LocalCodingModels }
// Older Prism versions reject unknown keys. A single versioned record keeps
// new saves atomic without corrupting their legacy config or rollback state.
const KEY = "local_coding_config_v2";
const LEGACY_KEY = "local_coding_config";
export function isLocalCodingModelId(value: unknown): value is string {
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value);
}
function record(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local_coding_preference_invalid");
    return value as Record<string, unknown>;
}
function parseModels(value: unknown): LocalCodingModels {
    const input = record(value), models: LocalCodingModels = {};
    for (const backend of Object.keys(input)) {
        if (backend !== "omlx" && backend !== "ollama") throw new Error("local_coding_preference_invalid");
        const roles = record(input[backend]);
        models[backend] = {};
        for (const role of Object.keys(roles)) {
            if ((role !== "coder" && role !== "reviewer") || !isLocalCodingModelId(roles[role])) throw new Error("local_coding_preference_invalid");
            models[backend]![role] = roles[role];
        }
    }
    return models;
}
export function isLocalCodingBackend(value: unknown): value is LocalCodingBackend {
    return LOCAL_CODING_BACKENDS.some(backend => backend === value);
}
export function parseLocalCodingSettings(value: unknown): LocalCodingSettings {
    const input = record(value);
    if (!Object.hasOwn(input, "backend") || !Object.hasOwn(input, "source")
        || Object.keys(input).some(key => !["backend", "source", "model", "models"].includes(key))
        || !isLocalCodingBackend(input.backend) || (input.source !== "existing" && input.source !== "managed")
        || (Object.hasOwn(input, "model") && !isLocalCodingModelId(input.model)))
        throw new Error("local_coding_preference_invalid");
    return { backend: input.backend, source: input.source,
        ...(Object.hasOwn(input, "model") ? { model: input.model as string } : {}),
        ...(Object.hasOwn(input, "models") ? { models: parseModels(input.models) } : {}) };
}
/** Exact assignments: sharing an ID is allowed, never inferred across roles. */
export function resolveLocalCodingModel(settings: Pick<LocalCodingSettings, "model" | "models">,
    backend: "omlx" | "ollama", role: LocalCodingRole, explicitModel?: string): string | undefined {
    return explicitModel ?? settings.models?.[backend]?.[role] ?? (backend === "omlx" && role === "coder" ? settings.model : undefined);
}
export async function readLocalCodingSettings(): Promise<LocalCodingSettings> {
    const raw = await getSetting(KEY, "", { fresh: true }) || await getSetting(LEGACY_KEY, "", { fresh: true });
    return raw ? parseLocalCodingSettings(JSON.parse(raw)) : { backend: "auto", source: "existing" };
}
export async function saveLocalCodingSettings(value: unknown): Promise<void> {
    await setSetting(KEY, JSON.stringify(parseLocalCodingSettings(value)));
}
