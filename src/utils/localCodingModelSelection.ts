import { localCodingRecommendation } from "./localCodingRecommendation.js";
import { configuredOmlxModel, inspectOmlxCodingModels } from "./omlxProvider.js";
import { inspectOllamaCodingModels, selectedOllamaCodingModel, type LocalCodingModelObservation } from "./ollamaCodingModels.js";
import { isLocalCodingModelId, type LocalCodingRole } from "./localCodingSettings.js";

export const LOCAL_CODING_SELECTION_MS = 2000;
export interface LocalCodingSelection {
    backend: "omlx" | "ollama";
    role: LocalCodingRole;
    ceiling: string;
    ollamaUrl: string;
    deadlineMs: number;
}
interface SelectionDependencies {
    recommend: typeof localCodingRecommendation;
    omlxModels: typeof inspectOmlxCodingModels;
    omlxDefault: typeof configuredOmlxModel;
    ollamaModels: typeof inspectOllamaCodingModels;
    ollamaChoice: typeof selectedOllamaCodingModel;
}
const defaults: SelectionDependencies = { recommend: localCodingRecommendation,
    omlxModels: inspectOmlxCodingModels, omlxDefault: configuredOmlxModel,
    ollamaModels: inspectOllamaCodingModels, ollamaChoice: selectedOllamaCodingModel };
const positive = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n > 0;

/** Generic local selection; recommendation ranking stays with the remote service. */
export async function selectUnassignedCodingModel(options: LocalCodingSelection,
    overrides: Partial<SelectionDependencies> = {}): Promise<string> {
    if (options.backend === "omlx" && options.ceiling !== "27b") throw new Error("omlx_model_ceiling");
    if (!["2b", "4b", "9b", "27b"].includes(options.ceiling)) throw new Error("local_coding_model_unavailable");
    const deps = { ...defaults, ...overrides };
    const deadline = Math.min(options.deadlineMs, Date.now() + LOCAL_CODING_SELECTION_MS);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error("local_coding_selection_timeout");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
        if (controller.signal.aborted || Date.now() >= deadline) throw new Error("local_coding_selection_timeout");
    };
    const work = async () => {
        check();
        let models: LocalCodingModelObservation[];
        const probe = { deadlineMs: deadline, signal: controller.signal };
        if (options.backend === "omlx") {
            const configured = await deps.omlxDefault();
            check();
            if (configured !== undefined) {
                if (!isLocalCodingModelId(configured)) throw new Error("local_coding_model_unavailable");
                return configured;
            }
            models = await deps.omlxModels(probe);
        } else models = await deps.ollamaModels(options.ollamaUrl, undefined, probe);
        check();
        const ids = new Set<string>();
        if (!Array.isArray(models) || models.length > 1024) throw new Error("local_coding_model_unavailable");
        models = models.filter(model => {
            if (!model || !isLocalCodingModelId(model.id) || ids.has(model.id) || typeof model.loaded !== "boolean")
                throw new Error("local_coding_model_unavailable");
            ids.add(model.id);
            return positive(model.weightBytes) && (options.backend !== "omlx" || positive(model.contextTokens));
        });
        if (!models.length) throw new Error("local_coding_model_unavailable");
        const hint = await deps.recommend(options.backend, options.role, { deadlineMs: deadline, signal: controller.signal }).catch(() => undefined);
        check();
        const eligible = async (id: string) => {
            check();
            if (options.backend === "omlx") return true;
            try { await deps.ollamaChoice(options.ollamaUrl, id, options.ceiling, undefined, probe); check(); return true; }
            catch { check(); return false; }
        };
        if (hint && models.some(model => model.id === hint) && await eligible(hint)) return hint;
        const ordered = [...models].sort((a, b) => Number(b.loaded) - Number(a.loaded) || a.weightBytes! - b.weightBytes!
            || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const model of ordered) {
            check();
            if (await eligible(model.id)) return model.id;
        }
        throw new Error("local_coding_model_unavailable");
    };
    try {
        return await Promise.race([work(), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { controller.abort(); reject(new Error("local_coding_selection_timeout")); }, deadline - Date.now());
        })]);
    } finally { clearTimeout(timer); controller.abort(); }
}
