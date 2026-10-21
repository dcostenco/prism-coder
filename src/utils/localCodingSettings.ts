import { getSetting, setSetting } from "../storage/configStorage.js";

export const LOCAL_CODING_BACKENDS = ["auto", "omlx", "ollama"] as const;
export type LocalCodingBackend = typeof LOCAL_CODING_BACKENDS[number];
export type OmlxSource = "existing" | "managed";
export interface LocalCodingSettings { backend: LocalCodingBackend; source: OmlxSource; model?: string }
const KEY = "local_coding_config";
export function isLocalCodingBackend(value: unknown): value is LocalCodingBackend {
    return LOCAL_CODING_BACKENDS.some(backend => backend === value);
}
export function parseLocalCodingSettings(value: unknown): LocalCodingSettings {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local_coding_preference_invalid");
    const record = value as Record<string, unknown>;
    if (!Object.hasOwn(record, "backend") || !Object.hasOwn(record, "source")
        || Object.keys(record).some(key => !["backend", "source", "model"].includes(key))
        || !isLocalCodingBackend(record.backend) || !["existing", "managed"].includes(String(record.source))
        || (record.model !== undefined && (typeof record.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(record.model))))
        throw new Error("local_coding_preference_invalid");
    return { backend: record.backend, source: record.source as OmlxSource, ...(record.model ? { model: record.model as string } : {}) };
}
export async function readLocalCodingSettings(): Promise<LocalCodingSettings> {
    const raw = await getSetting(KEY, "", { fresh: true });
    return raw ? parseLocalCodingSettings(JSON.parse(raw)) : { backend: "auto", source: "existing" };
}
export async function saveLocalCodingSettings(value: unknown): Promise<void> {
    await setSetting(KEY, JSON.stringify(parseLocalCodingSettings(value)));
}
