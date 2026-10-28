import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { configuredOmlxModel, detectOmlx, hasOmlxControl, inspectOmlx, inspectOmlxControl, inspectOmlxCodingModels, inspectOmlxImageModels, inspectOmlxImageInput, OmlxError } from "../utils/omlxProvider.js";
import { localCodingPreference } from "../utils/localCodingPreference.js";
import { readLocalCodingSettings, saveLocalCodingSettings, resolveLocalCodingModel } from "../utils/localCodingSettings.js";
import { omlxSetup, OmlxSetupError, OMLX_SETUP_MODELS } from "../utils/omlxSetup.js";
import { inspectOllamaCodingModels, inspectOllamaImageModels } from "../utils/ollamaCodingModels.js";
import { isLocalCodingModelId } from "../utils/localCodingSettings.js";
import { getAvailableMemoryBytes } from "../utils/availableMemory.js";
import { readLocalImageSettings, saveLocalImageSettings } from "../utils/localImageSettings.js";
import { activateLocalAiSource, inspectLocalAiSource, localAiAssignments, localAiSnapshot, saveLocalAiModels, LocalAiConflict } from "./localAiActions.js";

const MAX_BODY_BYTES = 4096;
// Public synthetic 32x32 red square. Contains no user image or metadata.
const LOCAL_AI_TEST_PNG = "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKElEQVR4nO3NsQ0AAAzCMP5/un0CNkuZ41wybXsHAAAAAAAAAAAAxR4yw/wuPL6QkAAAAABJRU5ErkJggg==";
const LOCAL_AI_TEST_REFERENCE = Object.freeze({ source: "builtin-diagnostic", description: "Solid red square", width: 32, height: 32,
    format: "PNG", sha256: createHash("sha256").update(Buffer.from(LOCAL_AI_TEST_PNG, "base64")).digest("hex") });
export interface LocalCodingRouterDeps {
    setup: Pick<typeof omlxSetup, "status" | "install" | "start"> & { restart?: () => Promise<unknown> };
    snapshot: typeof localAiSnapshot;
    inspectSource: typeof inspectLocalAiSource;
    activateSource: typeof activateLocalAiSource;
    saveModels: typeof saveLocalAiModels;
    infer: (args: unknown) => Promise<{ structuredContent?: Record<string, unknown>; isError?: boolean }>;
    settings: typeof readLocalCodingSettings;
    save: typeof saveLocalCodingSettings;
    preference: typeof localCodingPreference;
    inspect: typeof inspectOmlx;
    detect: typeof detectOmlx;
    control: typeof hasOmlxControl;
    connectionControl: typeof inspectOmlxControl;
    configuredModel: typeof configuredOmlxModel;
    omlxModels: typeof inspectOmlxCodingModels;
    ollamaModels: typeof inspectOllamaCodingModels;
    availableMemory: () => number;
    imageSettings: typeof readLocalImageSettings;
    saveImageSettings: typeof saveLocalImageSettings;
    omlxImageModels: typeof inspectOmlxImageModels;
    omlxImageInput: typeof inspectOmlxImageInput;
    ollamaImageModels: typeof inspectOllamaImageModels;
}
const defaults: LocalCodingRouterDeps = { setup: omlxSetup, settings: readLocalCodingSettings, save: saveLocalCodingSettings,
    preference: localCodingPreference, inspect: inspectOmlx, detect: detectOmlx, control: hasOmlxControl, connectionControl: inspectOmlxControl, configuredModel: configuredOmlxModel,
    omlxModels: inspectOmlxCodingModels, ollamaModels: inspectOllamaCodingModels, availableMemory: getAvailableMemoryBytes,
    snapshot: localAiSnapshot, inspectSource: inspectLocalAiSource, activateSource: activateLocalAiSource, saveModels: saveLocalAiModels,
    infer: async args => (await import("../tools/prismInferHandler.js")).prismInferHandler(args),
    imageSettings: readLocalImageSettings, saveImageSettings: saveLocalImageSettings,
    omlxImageModels: inspectOmlxImageModels, omlxImageInput: inspectOmlxImageInput, ollamaImageModels: inspectOllamaImageModels };
function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store" });
    res.end(JSON.stringify(value));
}
function loopback(req: IncomingMessage) {
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}
async function readBody(req: IncomingMessage, requireBody = false): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const data of req) {
        const chunk = Buffer.from(data); size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error("invalid_body");
        chunks.push(chunk);
    }
    if (requireBody && size === 0) throw new Error("invalid_body");
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Mounted only after the dashboard's Host, token and authentication gates. */
export async function handleLocalCodingRoutes(url: URL, req: IncomingMessage, res: ServerResponse, overrides: Partial<LocalCodingRouterDeps> = {}): Promise<boolean> {
    if (url.pathname !== "/api/local-coding" && !url.pathname.startsWith("/api/local-coding/")) return false;
    const deps = { ...defaults, ...overrides };
    try {
        if (req.method === "GET" && url.pathname === "/api/local-coding/connection-preview") {
            const source = url.searchParams.get("source");
            if (source !== "existing" && source !== "managed") { json(res, 400, { error: "Choose an existing or managed connection." }); return true; }
            const snapshot = await deps.snapshot();
            const observation = await deps.inspectSource(source);
            const managed = source === "managed" ? await deps.setup.status() : undefined;
            const preference = await deps.preference().catch(() => undefined);
            json(res, 200, { source, revision: snapshot.revision, activeSource: snapshot.settings.source,
                effective: { codingBackend: preference?.effective ?? "unknown", backendOverride: preference?.envOverride ?? null,
                    existingEndpointOverride: source === "existing" && Boolean(process.env.OMLX_BASE_URL),
                    existingAuthOverride: source === "existing" && Boolean(process.env.OMLX_API_KEY), imageBackend: snapshot.image.backend ?? "legacy" },
                connection: observation, canActivate: observation.control && (source !== "managed" || managed?.server.owned === true),
                assignments: localAiAssignments(snapshot.settings, snapshot.image).map(item => ({ ...item,
                    available: item.model ? observation.models.includes(item.model) : null })),
                sharedScope: "This connection is used by all oMLX coding, review and image tasks. Saved model IDs are preserved." }); return true;
        }
        if (req.method === "GET" && url.pathname === "/api/local-coding/image-models") {
            const selectedId = url.searchParams.get("ollamaModel") || undefined;
            const selectedOmlx = url.searchParams.get("omlxModel") || undefined;
            if ([selectedId, selectedOmlx].some(id => id !== undefined && !isLocalCodingModelId(id))) { json(res, 400, { error: "Invalid image model ID." }); return true; }
            const settings = await deps.imageSettings();
            const omlxModel = url.searchParams.has("omlxModel") ? selectedOmlx : settings.models?.omlx;
            const [inventories, omlxInput] = await Promise.all([
                Promise.allSettled([deps.omlxImageModels(), deps.ollamaImageModels(url.searchParams.has("ollamaModel") ? selectedId : settings.models?.ollama)]),
                omlxModel ? deps.omlxImageInput(omlxModel).catch(() => ({ model: omlxModel, state: "unknown" as const }))
                    : Promise.resolve({ state: "not_selected" as const }),
            ]);
            json(res, 200, { settings, selectionApplied: false, canManage: loopback(req), availableMemoryBytes: deps.availableMemory(),
                omlxInput,
                discovered: { omlx: inventories[0].status === "fulfilled" ? inventories[0].value : [],
                    ollama: inventories[1].status === "fulfilled" ? inventories[1].value : [] },
                discoveryErrors: { omlx: inventories[0].status === "rejected" ? "oMLX image inventory unavailable." : null,
                    ollama: inventories[1].status === "rejected" ? "Ollama image inventory unavailable." : null } }); return true;
        }
        if (req.method === "GET" && url.pathname === "/api/local-coding/image-preferences") {
            json(res, 200, { settings: await deps.imageSettings(), selectionApplied: false }); return true;
        }
        if (req.method === "GET" && url.pathname === "/api/local-coding") {
            const settings = await deps.settings();
            let preference, preferenceError: string | undefined;
            try { preference = await deps.preference(); }
            catch {
                preferenceError = "Backend preference inspection failed. You can change the saved settings below; check PRISM_LOCAL_CODING_BACKEND if an environment override is set.";
                // Recovery controls remain available. Inference still refuses a
                // broken configuration rather than silently changing backend.
                preference = { saved: settings.backend, effective: settings.backend, envOverride: null, configured: false };
            }
            const managed = await deps.setup.status();
            const inventories = await Promise.allSettled([deps.omlxModels(), deps.ollamaModels()]);
            const discovered = { omlx: inventories[0].status === "fulfilled" ? inventories[0].value : [],
                ollama: inventories[1].status === "fulfilled" ? inventories[1].value : [] };
            const discoveryErrors = { omlx: inventories[0].status === "rejected" ? "oMLX model metadata unavailable; memory requirements unknown." : null,
                ollama: inventories[1].status === "rejected" ? "Ollama model inventory unavailable. Check the configured server." : null };
            let connection: { connected: boolean; control: boolean; model?: string; models: string[]; error?: string; adminUrl?: string } = { connected: false, control: false, models: [] };
            try {
                const observation = await deps.inspect();
                connection = { connected: true, control: await deps.connectionControl(), models: observation.advertised_models, adminUrl: new URL(observation.url).origin + "/admin" };
                const model = resolveLocalCodingModel(settings, "omlx", "coder") ?? await deps.configuredModel();
                if (model) connection.model = model;
            } catch (error) { connection.error = error instanceof OmlxError ? error.reason : "Connection check unavailable."; }
            json(res, 200, { settings, preference, preferenceError, managed, connection, discovered, discoveryErrors,
                availableMemoryBytes: deps.availableMemory(), canManage: loopback(req),
                requiredClassifier: OMLX_SETUP_MODELS[0].id }); return true;
        }
        if (req.method !== "POST") { json(res, 405, { error: "Method not allowed" }); return true; }
        // Installing packages is a local operator action. A configured remote
        // dashboard origin and cross-port browser requests do not authorize it.
        const origin = req.headers.origin;
        let sameOrigin = !origin;
        try { if (origin) sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
        if (!loopback(req) || !sameOrigin || !req.headers["content-type"]?.startsWith("application/json")) {
            json(res, 403, { error: "Open this dashboard on this Mac to change local coding setup." }); return true;
        }
        const body = await readBody(req, url.pathname === "/api/local-coding/image-preferences");
        if (url.pathname === "/api/local-coding/image-preferences") {
            await deps.saveImageSettings(body); json(res, 200, { saved: true, selectionApplied: false }); return true;
        }
        if (url.pathname === "/api/local-coding/preferences") {
            await deps.save(body); json(res, 200, { saved: true }); return true;
        }
        if (url.pathname === "/api/local-coding/model-preferences") {
            await deps.saveModels(body); json(res, 200, { saved: true }); return true;
        }
        if (url.pathname === "/api/local-coding/activate-connection") {
            const value = body as Record<string, unknown>;
            if (!value || Array.isArray(value) || Object.keys(value).some(key => !["source", "revision"].includes(key))
                || (value.source !== "existing" && value.source !== "managed") || typeof value.revision !== "string" || !/^[a-f0-9]{64}$/.test(value.revision)) {
                json(res, 400, { error: "Refresh the connection preview before activation." }); return true;
            }
            const observation = await deps.inspectSource(value.source);
            if (!observation.control || (value.source === "managed" && (await deps.setup.status()).server.owned !== true)) {
                json(res, 409, { error: "The server is not ready or managed ownership is unproven. Saved preferences were preserved." }); return true;
            }
            await deps.activateSource(value.source, value.revision); json(res, 200, { saved: true, source: value.source }); return true;
        }
        if (url.pathname === "/api/local-coding/test") {
            const value = body as Record<string, unknown>;
            if (!value || Array.isArray(value) || Object.keys(value).some(key => !["purpose", "backend"].includes(key))
                || !["coder", "reviewer", "image"].includes(String(value.purpose)) || !["omlx", "ollama"].includes(String(value.backend))) {
                json(res, 400, { error: "Choose a local backend and purpose to test." }); return true;
            }
            const backend = value.backend as "omlx" | "ollama", purpose = value.purpose as "coder" | "reviewer" | "image";
            const coding = await deps.settings(), images = await deps.imageSettings();
            const model = purpose === "image" ? images.models?.[backend] : resolveLocalCodingModel(coding, backend, purpose);
            if (!model) { json(res, 200, { status: "blocked", reason: "model_not_selected", message: "Choose and save a model before testing." }); return true; }
            if (purpose === "image" && backend === "ollama") { json(res, 200, { status: "blocked", reason: "local_image_backend_not_enabled", message: "Ollama image execution is unavailable. Your selection is preserved." }); return true; }
            if (purpose !== "image" && backend === "omlx" && !(await deps.inspect()).advertised_models.includes(OMLX_SETUP_MODELS[0].id)) {
                json(res, 200, { status: "blocked", reason: "classifier_missing", message: "The required coding/review safety model is not installed. Image tasks do not require the coding pack." }); return true;
            }
            const args = { mode: "code", max_tokens: 48, think: false, timeout_ms: 60_000, cloud_fallback: false, verify: false,
                strict_entitlements: true, model_ceiling: "27b", route_guard: "local", escalation: "report",
                ...(purpose === "image" ? { prompt: "Describe the shape and color shown.", images: [LOCAL_AI_TEST_PNG], image_backend: backend, image_model: model }
                    : { prompt: "Reply exactly LOCAL_READY for this local connection diagnostic.", local_backend: backend, local_role: purpose, local_model: model }) };
            const result = await deps.infer(args), data = result.structuredContent;
            const reportedBackend = data?.backend;
            // The normal inference result labels Ollama with its served tier
            // or exact selected ID (for example ollama-4b).
            const backendMatches = reportedBackend === backend || backend === "ollama" && typeof reportedBackend === "string"
                && reportedBackend.startsWith("ollama-") && reportedBackend.length > "ollama-".length;
            const passed = !result.isError && backendMatches && data?.model_picked === model && data.used_cloud === false
                && typeof data.output === "string" && data.output.length > 0
                && (data.gate_outcome as { status?: string } | undefined)?.status === "success";
            json(res, 200, { status: passed ? "passed" : "blocked", purpose, backend, model,
                reason: passed ? undefined : (data?.gate_outcome as { reason?: string } | undefined)?.reason ?? "local_test_refused",
                message: passed ? "Local request completed. This verifies execution, not model accuracy or future RAM fit." : "Local test was refused. Check capability, safety dependencies, account entitlement and current resources.",
                output: passed ? data?.output : undefined,
                reference: passed && purpose === "image" ? LOCAL_AI_TEST_REFERENCE : undefined }); return true;
        }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
            json(res, 400, { error: "This action accepts no custom setup arguments." }); return true;
        }
        if (url.pathname === "/api/local-coding/install") { json(res, 202, await deps.setup.install()); return true; }
        if (url.pathname === "/api/local-coding/install-server") { json(res, 202, await deps.setup.install({ models: false })); return true; }
        if (url.pathname === "/api/local-coding/start") { json(res, 202, await deps.setup.start()); return true; }
        if (url.pathname === "/api/local-coding/restart" && deps.setup.restart) { json(res, 202, await deps.setup.restart()); return true; }
        json(res, 404, { error: "Unknown local coding action" }); return true;
    } catch (error) {
        if (error instanceof LocalAiConflict) { json(res, 409, { error: error.message }); return true; }
        const message = error instanceof OmlxSetupError ? error.message : "Local coding setup unavailable. Check the saved settings or local setup log and retry.";
        json(res, 400, { error: message }); return true;
    }
}
