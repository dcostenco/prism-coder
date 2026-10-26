import { parseLocalImageSettings, type LocalImageBackend } from "./localImageSettings.js";
import { isLocalCodingModelId } from "./localCodingSettings.js";

export const LOCAL_IMAGE_SELECTION_MS = 1000;
export const LOCAL_IMAGE_ERRORS = Object.freeze({
    request: "local_image_request_invalid",
    backend: "local_image_backend_missing",
    model: "local_image_model_missing",
    preference: "local_image_preference_invalid",
    timeout: "local_image_selection_timeout",
    omlx: "local_image_execution_not_qualified",
    ollama: "local_image_backend_not_enabled",
});
export interface LocalImageRequestArguments {
    images?: unknown;
    image_backend?: unknown;
    image_model?: unknown;
    local_backend?: unknown;
    local_model?: unknown;
    local_role?: unknown;
}
export interface LocalImageSelection { backend: LocalImageBackend; model: string }

/** New image overrides never mix with the legacy coding argument family. */
export function localImageRequestProblem(args: LocalImageRequestArguments): string | null {
    if (args.image_backend === undefined && args.image_model === undefined) return null;
    if (!Array.isArray(args.images) || !args.images.length
        || (args.image_backend !== undefined && args.image_backend !== "omlx" && args.image_backend !== "ollama")
        || (args.image_model !== undefined && !isLocalCodingModelId(args.image_model))
        || args.local_backend !== undefined || args.local_model !== undefined || args.local_role !== undefined)
        return LOCAL_IMAGE_ERRORS.request;
    return null;
}

/** Select identifiers only. A selection carries no authority to run images. */
export function resolveLocalImageSelection(args: LocalImageRequestArguments, settings: unknown): LocalImageSelection | null {
    const problem = localImageRequestProblem(args);
    if (problem) throw new Error(problem);
    if (!Array.isArray(args.images) || !args.images.length || args.local_backend !== undefined) return null;
    const explicitBackend = args.image_backend as LocalImageBackend | undefined;
    const explicitModel = args.image_model as string | undefined;
    if (explicitBackend && explicitModel) return { backend: explicitBackend, model: explicitModel };
    const saved = parseLocalImageSettings(settings);
    const backend = explicitBackend ?? saved.backend;
    if (!backend) {
        if (explicitModel) throw new Error(LOCAL_IMAGE_ERRORS.backend);
        return null;
    }
    const model = explicitModel ?? saved.models?.[backend];
    if (!model) throw new Error(LOCAL_IMAGE_ERRORS.model);
    return { backend, model };
}
