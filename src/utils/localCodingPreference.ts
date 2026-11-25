import { configuredOmlxModel } from "./omlxProvider.js";
import { readExecutionAssignments, type ExecutionAssignment } from "./executionRoles.js";
import { isLocalCodingBackend, readLocalCodingSettings, resolveLocalCodingModel, type LocalCodingBackend, type LocalCodingModels, type LocalCodingRole } from "./localCodingSettings.js";
export { LOCAL_CODING_BACKENDS, isLocalCodingBackend, type LocalCodingBackend } from "./localCodingSettings.js";

export interface LocalCodingPreference {
    saved: LocalCodingBackend;
    effective: LocalCodingBackend;
    envOverride: LocalCodingBackend | null;
    model?: string;
    models?: LocalCodingModels;
    configured: boolean;
    assignment?: ExecutionAssignment;
}

/** Read on each task so a dashboard save applies without restarting a host. */
export async function localCodingPreference(role: LocalCodingRole = "coder", explicitBackend?: "omlx" | "ollama", checkAutoEligibility = true, explicitModel?: string, useRoleAssignment = true): Promise<LocalCodingPreference> {
    const settings = await readLocalCodingSettings(), stored = settings.backend;
    const assignment = !useRoleAssignment || explicitBackend || explicitModel ? undefined : (await readExecutionAssignments())[role];
    const override = explicitBackend ? undefined : process.env.PRISM_LOCAL_CODING_BACKEND;
    if (override !== undefined && !isLocalCodingBackend(override)) throw new Error("local_coding_override_invalid");
    const model = resolveLocalCodingModel(settings, "omlx", "coder");
    if (assignment && assignment.runtime !== "auto" && override !== undefined && override !== "auto" && override !== assignment.runtime)
        throw new Error("execution_assignment_override_conflict");
    if (useRoleAssignment && !explicitBackend && !explicitModel && stored !== "auto" && override && override !== "auto" && override !== stored
        && resolveLocalCodingModel(settings, stored, role)) throw new Error("execution_assignment_override_conflict");
    const effective = explicitBackend ?? (assignment?.runtime === "omlx" || assignment?.runtime === "ollama" ? assignment.runtime : override ?? stored);
    // A broken configured server is an error, not permission to change backend.
    const localAutoAssignment = !assignment || assignment.runtime === "auto";
    const configured = localAutoAssignment && effective === "auto" && checkAutoEligibility
        ? Boolean(await configuredOmlxModel(resolveLocalCodingModel(settings, "omlx", role))) : false;
    return { saved: stored, effective, envOverride: override ?? null, model: model || undefined, models: settings.models, configured, assignment };
}

export function resolveLocalCodingBackend(
    args: { local_backend?: "omlx" | "ollama"; mode?: string; images?: string[]; model_ceiling?: string },
    preference: LocalCodingPreference,
): "omlx" | "ollama" {
    if (args.local_backend) return args.local_backend;
    if (args.images?.length) return "ollama";
    if (preference.effective === "omlx") return "omlx";
    if (args.mode !== "code") return "ollama";
    if (preference.effective === "auto" && args.model_ceiling && args.model_ceiling !== "27b") return "ollama";
    return preference.effective === "auto" && preference.configured ? "omlx" : "ollama";
}
