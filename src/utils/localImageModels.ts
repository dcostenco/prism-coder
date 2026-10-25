export interface ImageCapability {
    vision: "yes" | "no" | "unknown";
    source: "omlx.engine_type" | "ollama.show.capabilities" | "metadata_unavailable";
}
export interface LocalImageModelObservation {
    id: string;
    loaded?: boolean;
    weightBytes?: number;
    loadedBytes?: number;
    residentEstimateBytes?: number;
    capability: ImageCapability;
}
const MAX_CAPABILITIES = 64;
const MAX_CAPABILITY_LENGTH = 64;

/** Advertisements only; never substitutes for a controlled image test. */
export function advertisedImageCapability(backend: "omlx" | "ollama", metadata: unknown): ImageCapability {
    const unknown: ImageCapability = { vision: "unknown", source: "metadata_unavailable" };
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return unknown;
    if (backend === "omlx") {
        if (!Object.hasOwn(metadata, "engine_type")) return unknown;
        const engine = (metadata as Record<string, unknown>).engine_type;
        return engine === "vlm" || engine === "llm" ? { vision: engine === "vlm" ? "yes" : "no", source: "omlx.engine_type" } : unknown;
    }
    if (!Object.hasOwn(metadata, "capabilities")) return unknown;
    const capabilities = (metadata as Record<string, unknown>).capabilities;
    if (!Array.isArray(capabilities) || capabilities.length > MAX_CAPABILITIES) return unknown;
    for (let i = 0; i < capabilities.length; i++) {
        if (!Object.hasOwn(capabilities, i) || typeof capabilities[i] !== "string" || !capabilities[i].length
            || capabilities[i].length > MAX_CAPABILITY_LENGTH) return unknown;
    }
    return { vision: capabilities.includes("vision") ? "yes" : "no", source: "ollama.show.capabilities" };
}
