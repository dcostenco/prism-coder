import { configuredOmlxModel } from "./omlxProvider.js";
import { isLocalCodingBackend, readLocalCodingSettings, type LocalCodingBackend } from "./localCodingSettings.js";
export { LOCAL_CODING_BACKENDS, isLocalCodingBackend, type LocalCodingBackend } from "./localCodingSettings.js";

export interface LocalCodingPreference {
    saved: LocalCodingBackend;
    effective: LocalCodingBackend;
    envOverride: LocalCodingBackend | null;
    model?: string;
    configured: boolean;
}

/** Read on each task so a dashboard save applies without restarting a host. */
export async function localCodingPreference(): Promise<LocalCodingPreference> {
    const settings = await readLocalCodingSettings(), stored = settings.backend;
    const override = process.env.PRISM_LOCAL_CODING_BACKEND;
    if (override !== undefined && !isLocalCodingBackend(override)) throw new Error("local_coding_override_invalid");
    const model = settings.model;
    const effective = override ?? stored;
    // A broken configured server is an error, not permission to change backend.
    const configured = effective === "auto" ? Boolean(await configuredOmlxModel(model || undefined)) : false;
    return { saved: stored, effective, envOverride: override ?? null, model: model || undefined, configured };
}

export function resolveLocalCodingBackend(
    args: { local_backend?: "omlx" | "ollama"; mode?: string; images?: string[]; model_ceiling?: string },
    preference: LocalCodingPreference,
): "omlx" | "ollama" {
    if (args.local_backend) return args.local_backend;
    if (args.mode !== "code" || args.images?.length) return "ollama";
    if (preference.effective === "auto" && args.model_ceiling && args.model_ceiling !== "27b") return "ollama";
    return preference.effective === "omlx" || (preference.effective === "auto" && preference.configured) ? "omlx" : "ollama";
}
