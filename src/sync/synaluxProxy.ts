/**
 * v12.5: Synalux Thin-Client Proxy
 *
 * HTTP relay to Synalux Cloud API for tier-gated features.
 * Routes requests through the Synalux Cloud Gateway, enforcing
 * subscription tier limits and authentication.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface ProxyConfig {
    baseUrl: string;
    apiKey: string;
    tier: "free" | "standard" | "advanced" | "enterprise";
    timeout: number;
    retries: number;
    enabled: boolean;
}

export interface ProxyRequest {
    method: "GET" | "POST" | "PUT" | "DELETE";
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
}

export interface ProxyResponse {
    status: number;
    data: unknown;
    headers: Record<string, string>;
    latencyMs: number;
    cached: boolean;
}

export interface TierLimits {
    maxRequestsPerMinute: number;
    maxMemoryMb: number;
    maxProjects: number;
    cloudFeatures: string[];
}

// ─── Tier Limits ─────────────────────────────────────────────

const TIER_LIMITS: Record<ProxyConfig["tier"], TierLimits> = {
    free: {
        maxRequestsPerMinute: 10,
        maxMemoryMb: 50,
        maxProjects: 3,
        cloudFeatures: ["search", "load_context"],
    },
    standard: {
        maxRequestsPerMinute: 60,
        maxMemoryMb: 500,
        maxProjects: 20,
        cloudFeatures: ["search", "load_context", "save_ledger", "save_handoff", "analytics"],
    },
    advanced: {
        maxRequestsPerMinute: 300,
        maxMemoryMb: 5000,
        maxProjects: -1, // unlimited
        cloudFeatures: ["search", "load_context", "save_ledger", "save_handoff", "analytics", "backup", "sync", "plugins"],
    },
    enterprise: {
        maxRequestsPerMinute: -1, // unlimited
        maxMemoryMb: -1,
        maxProjects: -1,
        cloudFeatures: ["*"], // all features
    },
};

// ─── Rate Limiter ────────────────────────────────────────────

const requestLog: number[] = [];

function checkRateLimit(tier: ProxyConfig["tier"]): boolean {
    const limit = TIER_LIMITS[tier].maxRequestsPerMinute;
    if (limit === -1) return true;

    const now = Date.now();
    const windowStart = now - 60_000;

    // Clean old entries
    while (requestLog.length > 0 && requestLog[0] < windowStart) {
        requestLog.shift();
    }

    if (requestLog.length >= limit) return false;

    requestLog.push(now);
    return true;
}

// ─── Proxy State ─────────────────────────────────────────────

let config: ProxyConfig = {
    baseUrl: "https://cloud.synalux.ai/api/v1/prism",
    apiKey: "",
    tier: "free",
    timeout: 30_000,
    retries: 2,
    enabled: false,
};

export function configureProxy(updates: Partial<ProxyConfig>): void {
    config = { ...config, ...updates };
    debugLog(`Proxy: Configured for ${config.tier} tier → ${config.baseUrl}`);
}

export function getProxyConfig(): Omit<ProxyConfig, "apiKey"> & { apiKey: string } {
    return { ...config, apiKey: config.apiKey ? "***" : "" };
}

export function getTierLimits(tier?: ProxyConfig["tier"]): TierLimits {
    return TIER_LIMITS[tier || config.tier];
}

// ─── Feature Gating ──────────────────────────────────────────

/**
 * Check if a cloud feature is available for the current tier.
 */
export function isFeatureAvailable(feature: string): boolean {
    const limits = TIER_LIMITS[config.tier];
    return limits.cloudFeatures.includes("*") || limits.cloudFeatures.includes(feature);
}

/**
 * List all features available for the current tier.
 */
export function listAvailableFeatures(): string[] {
    return [...TIER_LIMITS[config.tier].cloudFeatures];
}

// ─── HTTP Proxy ──────────────────────────────────────────────

/**
 * Send a request through the Synalux Cloud proxy.
 */
export async function proxyRequest(req: ProxyRequest): Promise<ProxyResponse> {
    if (!config.enabled) {
        return {
            status: 503,
            data: { error: "Synalux Cloud proxy is not enabled. Set PRISM_CLOUD_PROXY=true." },
            headers: {},
            latencyMs: 0,
            cached: false,
        };
    }

    if (!config.apiKey) {
        return {
            status: 401,
            data: { error: "No API key configured. Set PRISM_SYNALUX_API_KEY." },
            headers: {},
            latencyMs: 0,
            cached: false,
        };
    }

    if (!checkRateLimit(config.tier)) {
        return {
            status: 429,
            data: { error: `Rate limit exceeded for ${config.tier} tier (${TIER_LIMITS[config.tier].maxRequestsPerMinute}/min)` },
            headers: {},
            latencyMs: 0,
            cached: false,
        };
    }

    const start = Date.now();
    const url = `${config.baseUrl}${req.path}`;

    let lastError: unknown;

    for (let attempt = 0; attempt <= config.retries; attempt++) {
        try {
            const response = await fetch(url, {
                method: req.method,
                headers: {
                    "Authorization": `Bearer ${config.apiKey}`,
                    "Content-Type": "application/json",
                    "X-Prism-Tier": config.tier,
                    "X-Prism-Version": "12.5.0",
                    ...(req.headers || {}),
                },
                body: req.body ? JSON.stringify(req.body) : undefined,
                signal: AbortSignal.timeout(config.timeout),
            });

            const data = await response.json().catch(() => null);
            const latencyMs = Date.now() - start;

            debugLog(`Proxy: ${req.method} ${req.path} → ${response.status} (${latencyMs}ms)`);

            const responseHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => { responseHeaders[key] = value; });

            return {
                status: response.status,
                data,
                headers: responseHeaders,
                latencyMs,
                cached: response.headers.get("x-cache") === "HIT",
            };
        } catch (err) {
            lastError = err;
            if (attempt < config.retries) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
                await new Promise(r => setTimeout(r, delay));
                debugLog(`Proxy: Retry ${attempt + 1}/${config.retries} after error: ${err}`);
            }
        }
    }

    return {
        status: 502,
        data: { error: `Proxy error after ${config.retries + 1} attempts: ${lastError}` },
        headers: {},
        latencyMs: Date.now() - start,
        cached: false,
    };
}

/**
 * Check cloud connectivity and tier status.
 */
export async function healthCheck(): Promise<{
    connected: boolean;
    tier: string;
    latencyMs: number;
    features: string[];
}> {
    const result = await proxyRequest({ method: "GET", path: "/health" });
    return {
        connected: result.status === 200,
        tier: config.tier,
        latencyMs: result.latencyMs,
        features: listAvailableFeatures(),
    };
}

debugLog("v12.5: Synalux proxy loaded");
