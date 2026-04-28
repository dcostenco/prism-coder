/**
 * v12.5: Plugin/Extension API for IDE Marketplace
 *
 * Load/unload `.prism-plugin.json` extensions with lifecycle hooks.
 * Plugins can register custom tools, add storage backends,
 * or extend the dashboard.
 */

import { debugLog } from "../utils/logger.js";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types ───────────────────────────────────────────────────

export interface PluginManifest {
    name: string;
    version: string;
    description: string;
    author: string;
    license: string;
    main: string;              // Entry point (relative JS path)
    prismVersion: string;      // Minimum compatible Prism version
    capabilities: PluginCapability[];
    config?: Record<string, PluginConfigField>;
}

export type PluginCapability =
    | "tools"           // Register custom MCP tools
    | "storage"         // Custom storage backend
    | "dashboard"       // Dashboard widget
    | "preprocessor"    // Input preprocessor hook
    | "postprocessor"   // Output postprocessor hook
    | "scheduler";      // Background scheduler task

export interface PluginConfigField {
    type: "string" | "number" | "boolean";
    description: string;
    default?: string | number | boolean;
    required?: boolean;
}

export interface LoadedPlugin {
    manifest: PluginManifest;
    path: string;
    status: "loaded" | "active" | "error" | "disabled";
    loadedAt: string;
    error?: string;
    instance?: PluginInstance;
}

export interface PluginInstance {
    onLoad?: () => Promise<void>;
    onUnload?: () => Promise<void>;
    onToolCall?: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
    getTools?: () => Array<{ name: string; description: string; inputSchema: unknown }>;
}

export interface PluginRegistryEntry {
    name: string;
    version: string;
    description: string;
    author: string;
    downloads: number;
    rating: number;
    verified: boolean;
    url: string;
}

// ─── Plugin Manager ──────────────────────────────────────────

const plugins = new Map<string, LoadedPlugin>();

function getPluginsDir(): string {
    return join(process.env.PRISM_DATA_DIR || join(homedir(), ".prism"), "plugins");
}

/**
 * Discover plugins in the plugins directory.
 */
export function discoverPlugins(): PluginManifest[] {
    const dir = getPluginsDir();
    if (!existsSync(dir)) return [];

    const manifests: PluginManifest[] = [];

    try {
        const entries = readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;

            const manifestPath = join(dir, entry.name, "prism-plugin.json");
            if (!existsSync(manifestPath)) continue;

            try {
                const raw = readFileSync(manifestPath, "utf-8");
                const manifest: PluginManifest = JSON.parse(raw);
                manifests.push(manifest);
            } catch (err) {
                debugLog(`Plugin: Failed to parse manifest for ${entry.name}: ${err}`);
            }
        }
    } catch (err) {
        debugLog(`Plugin: Failed to scan plugins directory: ${err}`);
    }

    return manifests;
}

/**
 * Load a plugin by name.
 */
export async function loadPlugin(pluginName: string): Promise<LoadedPlugin> {
    const dir = join(getPluginsDir(), pluginName);
    const manifestPath = join(dir, "prism-plugin.json");

    if (!existsSync(manifestPath)) {
        const loaded: LoadedPlugin = {
            manifest: { name: pluginName, version: "0.0.0", description: "", author: "", license: "", main: "", prismVersion: "", capabilities: [] },
            path: dir,
            status: "error",
            loadedAt: new Date().toISOString(),
            error: `Plugin '${pluginName}' not found at ${dir}`,
        };
        plugins.set(pluginName, loaded);
        return loaded;
    }

    try {
        const manifest: PluginManifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
        const entryPath = resolve(dir, manifest.main);

        let instance: PluginInstance | undefined;

        if (existsSync(entryPath)) {
            try {
                const mod = await import(entryPath);
                instance = mod.default || mod;

                if (instance?.onLoad) {
                    await instance.onLoad();
                }
            } catch (err) {
                debugLog(`Plugin: Failed to load entry point for ${pluginName}: ${err}`);
            }
        }

        const loaded: LoadedPlugin = {
            manifest,
            path: dir,
            status: instance ? "active" : "loaded",
            loadedAt: new Date().toISOString(),
            instance,
        };

        plugins.set(pluginName, loaded);
        debugLog(`Plugin: Loaded '${pluginName}' v${manifest.version} [${manifest.capabilities.join(", ")}]`);
        return loaded;
    } catch (err) {
        const loaded: LoadedPlugin = {
            manifest: { name: pluginName, version: "0.0.0", description: "", author: "", license: "", main: "", prismVersion: "", capabilities: [] },
            path: dir,
            status: "error",
            loadedAt: new Date().toISOString(),
            error: `Failed to load plugin: ${err}`,
        };
        plugins.set(pluginName, loaded);
        return loaded;
    }
}

/**
 * Unload a plugin by name.
 */
export async function unloadPlugin(pluginName: string): Promise<boolean> {
    const plugin = plugins.get(pluginName);
    if (!plugin) return false;

    try {
        if (plugin.instance?.onUnload) {
            await plugin.instance.onUnload();
        }
    } catch (err) {
        debugLog(`Plugin: Error during unload of '${pluginName}': ${err}`);
    }

    plugins.delete(pluginName);
    debugLog(`Plugin: Unloaded '${pluginName}'`);
    return true;
}

/**
 * List all loaded plugins.
 */
export function listPlugins(): LoadedPlugin[] {
    return Array.from(plugins.values());
}

/**
 * Get a specific loaded plugin.
 */
export function getPlugin(name: string): LoadedPlugin | undefined {
    return plugins.get(name);
}

/**
 * Get all custom tools registered by plugins.
 */
export function getPluginTools(): Array<{ pluginName: string; tools: unknown[] }> {
    const result: Array<{ pluginName: string; tools: unknown[] }> = [];

    for (const [name, plugin] of plugins) {
        if (plugin.status === "active" && plugin.instance?.getTools) {
            try {
                const tools = plugin.instance.getTools();
                result.push({ pluginName: name, tools });
            } catch (err) {
                debugLog(`Plugin: Error getting tools from '${name}': ${err}`);
            }
        }
    }

    return result;
}

/**
 * Dispatch a tool call to the appropriate plugin.
 */
export async function dispatchPluginToolCall(
    toolName: string,
    args: Record<string, unknown>,
): Promise<{ handled: boolean; result?: unknown }> {
    for (const [, plugin] of plugins) {
        if (plugin.status === "active" && plugin.instance?.onToolCall) {
            try {
                const result = await plugin.instance.onToolCall(toolName, args);
                if (result !== undefined) {
                    return { handled: true, result };
                }
            } catch (err) {
                debugLog(`Plugin: Error dispatching tool '${toolName}': ${err}`);
            }
        }
    }

    return { handled: false };
}

// ─── Plugin Schema Validation ────────────────────────────────

/**
 * Validate a plugin manifest against the schema.
 */
export function validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const m = manifest as Record<string, unknown>;

    if (!m.name || typeof m.name !== "string") errors.push("Missing or invalid 'name'");
    if (!m.version || typeof m.version !== "string") errors.push("Missing or invalid 'version'");
    if (!m.main || typeof m.main !== "string") errors.push("Missing or invalid 'main' entry point");
    if (!m.prismVersion || typeof m.prismVersion !== "string") errors.push("Missing 'prismVersion'");
    if (!Array.isArray(m.capabilities)) errors.push("Missing 'capabilities' array");

    const validCaps: PluginCapability[] = ["tools", "storage", "dashboard", "preprocessor", "postprocessor", "scheduler"];
    if (Array.isArray(m.capabilities)) {
        for (const cap of m.capabilities) {
            if (!validCaps.includes(cap as PluginCapability)) {
                errors.push(`Unknown capability: '${cap}'`);
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

debugLog("v12.5: Plugin manager loaded");
