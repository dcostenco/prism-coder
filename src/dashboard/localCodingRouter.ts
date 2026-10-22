import type { IncomingMessage, ServerResponse } from "node:http";
import { configuredOmlxModel, detectOmlx, hasOmlxControl, inspectOmlx, inspectOmlxCodingModels, OmlxError } from "../utils/omlxProvider.js";
import { localCodingPreference } from "../utils/localCodingPreference.js";
import { readLocalCodingSettings, saveLocalCodingSettings, resolveLocalCodingModel } from "../utils/localCodingSettings.js";
import { omlxSetup, OmlxSetupError, OMLX_SETUP_MODELS } from "../utils/omlxSetup.js";
import { inspectOllamaCodingModels } from "../utils/ollamaCodingModels.js";
import { getAvailableMemoryBytes } from "../utils/availableMemory.js";

const MAX_BODY_BYTES = 4096;
export interface LocalCodingRouterDeps {
    setup: Pick<typeof omlxSetup, "status" | "install" | "start">;
    settings: typeof readLocalCodingSettings;
    save: typeof saveLocalCodingSettings;
    preference: typeof localCodingPreference;
    inspect: typeof inspectOmlx;
    detect: typeof detectOmlx;
    control: typeof hasOmlxControl;
    configuredModel: typeof configuredOmlxModel;
    omlxModels: typeof inspectOmlxCodingModels;
    ollamaModels: typeof inspectOllamaCodingModels;
    availableMemory: () => number;
}
const defaults: LocalCodingRouterDeps = { setup: omlxSetup, settings: readLocalCodingSettings, save: saveLocalCodingSettings,
    preference: localCodingPreference, inspect: inspectOmlx, detect: detectOmlx, control: hasOmlxControl, configuredModel: configuredOmlxModel,
    omlxModels: inspectOmlxCodingModels, ollamaModels: inspectOllamaCodingModels, availableMemory: getAvailableMemoryBytes };
function json(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "private, no-store" });
    res.end(JSON.stringify(value));
}
function loopback(req: IncomingMessage) {
    return ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "");
}
async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []; let size = 0;
    for await (const data of req) {
        const chunk = Buffer.from(data); size += chunk.length;
        if (size > MAX_BODY_BYTES) throw new Error("invalid_body");
        chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
/** Mounted only after the dashboard's Host, token and authentication gates. */
export async function handleLocalCodingRoutes(url: URL, req: IncomingMessage, res: ServerResponse, overrides: Partial<LocalCodingRouterDeps> = {}): Promise<boolean> {
    if (url.pathname !== "/api/local-coding" && !url.pathname.startsWith("/api/local-coding/")) return false;
    const deps = { ...defaults, ...overrides };
    try {
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
                connection = { connected: true, control: false, models: observation.advertised_models, adminUrl: new URL(observation.url).origin + "/admin" };
                const model = resolveLocalCodingModel(settings, "omlx", "coder") ?? await deps.configuredModel();
                if (model) { const target = await deps.detect(model); connection.model = model; connection.control = await deps.control(target); }
                else connection.error = "Choose an advertised coding model and save the preference.";
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
        const body = await readBody(req);
        if (url.pathname === "/api/local-coding/preferences") {
            await deps.save(body); json(res, 200, { saved: true }); return true;
        }
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) {
            json(res, 400, { error: "This action accepts no custom setup arguments." }); return true;
        }
        if (url.pathname === "/api/local-coding/install") { json(res, 202, await deps.setup.install()); return true; }
        if (url.pathname === "/api/local-coding/start") { json(res, 202, await deps.setup.start()); return true; }
        json(res, 404, { error: "Unknown local coding action" }); return true;
    } catch (error) {
        const message = error instanceof OmlxSetupError ? error.message : "Local coding setup unavailable. Check the saved settings or local setup log and retry.";
        json(res, 400, { error: message }); return true;
    }
}
