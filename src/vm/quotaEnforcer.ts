/**
 * v12.5: Tier-Gated VM Quota Enforcer
 *
 * Enforces subscription-based VM limits.
 * Each Synalux tier has maximum VM counts, CPU, RAM, and storage quotas.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface VMQuota {
    maxVMs: number;
    maxCpuCores: number;
    maxRamGb: number;
    maxStorageGb: number;
    maxConcurrentRuns: number;
    allowedPlatforms: string[];
}

export interface VMUsage {
    activeVMs: number;
    totalCpuCores: number;
    totalRamGb: number;
    totalStorageGb: number;
    concurrentRuns: number;
}

export interface QuotaCheckResult {
    allowed: boolean;
    resource: string;
    requested: number;
    available: number;
    limit: number;
    tier: string;
    reason: string;
}

export type SubscriptionTier = "free" | "standard" | "advanced" | "enterprise";

// ─── Tier Quotas ─────────────────────────────────────────────

const TIER_QUOTAS: Record<SubscriptionTier, VMQuota> = {
    free: {
        maxVMs: 1,
        maxCpuCores: 2,
        maxRamGb: 4,
        maxStorageGb: 20,
        maxConcurrentRuns: 1,
        allowedPlatforms: ["linux"],
    },
    standard: {
        maxVMs: 5,
        maxCpuCores: 8,
        maxRamGb: 16,
        maxStorageGb: 100,
        maxConcurrentRuns: 2,
        allowedPlatforms: ["linux", "macos", "windows"],
    },
    advanced: {
        maxVMs: 20,
        maxCpuCores: 32,
        maxRamGb: 64,
        maxStorageGb: 500,
        maxConcurrentRuns: 5,
        allowedPlatforms: ["linux", "macos", "windows", "ios", "android", "visionos"],
    },
    enterprise: {
        maxVMs: -1, // unlimited
        maxCpuCores: -1,
        maxRamGb: -1,
        maxStorageGb: -1,
        maxConcurrentRuns: -1,
        allowedPlatforms: ["*"],
    },
};

// ─── State ───────────────────────────────────────────────────

let currentTier: SubscriptionTier = "free";
let currentUsage: VMUsage = {
    activeVMs: 0,
    totalCpuCores: 0,
    totalRamGb: 0,
    totalStorageGb: 0,
    concurrentRuns: 0,
};

export function setTier(tier: SubscriptionTier): void {
    currentTier = tier;
    debugLog(`VM Quota: Tier set to '${tier}'`);
}

export function getTier(): SubscriptionTier {
    return currentTier;
}

export function getQuota(tier?: SubscriptionTier): VMQuota {
    return { ...TIER_QUOTAS[tier || currentTier] };
}

export function getUsage(): VMUsage {
    return { ...currentUsage };
}

export function updateUsage(usage: Partial<VMUsage>): void {
    currentUsage = { ...currentUsage, ...usage };
}

// ─── Quota Checks ────────────────────────────────────────────

function isUnlimited(value: number): boolean {
    return value === -1;
}

/**
 * Check if creating a new VM is allowed.
 */
export function checkVMCreation(
    cpuCores: number = 1,
    ramGb: number = 2,
    storageGb: number = 10,
    platform: string = "linux",
): QuotaCheckResult {
    const quota = TIER_QUOTAS[currentTier];

    // Check platform
    if (!quota.allowedPlatforms.includes("*") && !quota.allowedPlatforms.includes(platform)) {
        return {
            allowed: false,
            resource: "platform",
            requested: 0,
            available: 0,
            limit: 0,
            tier: currentTier,
            reason: `Platform '${platform}' not available on ${currentTier} tier. Available: ${quota.allowedPlatforms.join(", ")}`,
        };
    }

    // Check VM count
    if (!isUnlimited(quota.maxVMs) && currentUsage.activeVMs >= quota.maxVMs) {
        return {
            allowed: false,
            resource: "vms",
            requested: 1,
            available: quota.maxVMs - currentUsage.activeVMs,
            limit: quota.maxVMs,
            tier: currentTier,
            reason: `VM limit reached (${currentUsage.activeVMs}/${quota.maxVMs})`,
        };
    }

    // Check CPU
    if (!isUnlimited(quota.maxCpuCores) && currentUsage.totalCpuCores + cpuCores > quota.maxCpuCores) {
        return {
            allowed: false,
            resource: "cpu",
            requested: cpuCores,
            available: quota.maxCpuCores - currentUsage.totalCpuCores,
            limit: quota.maxCpuCores,
            tier: currentTier,
            reason: `CPU quota exceeded (${currentUsage.totalCpuCores + cpuCores}/${quota.maxCpuCores} cores)`,
        };
    }

    // Check RAM
    if (!isUnlimited(quota.maxRamGb) && currentUsage.totalRamGb + ramGb > quota.maxRamGb) {
        return {
            allowed: false,
            resource: "ram",
            requested: ramGb,
            available: quota.maxRamGb - currentUsage.totalRamGb,
            limit: quota.maxRamGb,
            tier: currentTier,
            reason: `RAM quota exceeded (${currentUsage.totalRamGb + ramGb}/${quota.maxRamGb} GB)`,
        };
    }

    // Check storage
    if (!isUnlimited(quota.maxStorageGb) && currentUsage.totalStorageGb + storageGb > quota.maxStorageGb) {
        return {
            allowed: false,
            resource: "storage",
            requested: storageGb,
            available: quota.maxStorageGb - currentUsage.totalStorageGb,
            limit: quota.maxStorageGb,
            tier: currentTier,
            reason: `Storage quota exceeded (${currentUsage.totalStorageGb + storageGb}/${quota.maxStorageGb} GB)`,
        };
    }

    return {
        allowed: true,
        resource: "all",
        requested: 0,
        available: 0,
        limit: 0,
        tier: currentTier,
        reason: "All quota checks passed",
    };
}

/**
 * Check if a concurrent run is allowed.
 */
export function checkConcurrentRun(): QuotaCheckResult {
    const quota = TIER_QUOTAS[currentTier];

    if (!isUnlimited(quota.maxConcurrentRuns) && currentUsage.concurrentRuns >= quota.maxConcurrentRuns) {
        return {
            allowed: false,
            resource: "concurrent_runs",
            requested: 1,
            available: quota.maxConcurrentRuns - currentUsage.concurrentRuns,
            limit: quota.maxConcurrentRuns,
            tier: currentTier,
            reason: `Concurrent run limit reached (${currentUsage.concurrentRuns}/${quota.maxConcurrentRuns})`,
        };
    }

    return {
        allowed: true,
        resource: "concurrent_runs",
        requested: 1,
        available: isUnlimited(quota.maxConcurrentRuns) ? -1 : quota.maxConcurrentRuns - currentUsage.concurrentRuns,
        limit: quota.maxConcurrentRuns,
        tier: currentTier,
        reason: "Concurrent run allowed",
    };
}

/**
 * Get a summary of quota usage vs limits.
 */
export function getQuotaSummary(): {
    tier: string;
    usage: VMUsage;
    limits: VMQuota;
    percentUsed: Record<string, number>;
} {
    const limits = TIER_QUOTAS[currentTier];
    const pct = (used: number, max: number) => max === -1 ? 0 : Math.round((used / max) * 100);

    return {
        tier: currentTier,
        usage: { ...currentUsage },
        limits: { ...limits },
        percentUsed: {
            vms: pct(currentUsage.activeVMs, limits.maxVMs),
            cpu: pct(currentUsage.totalCpuCores, limits.maxCpuCores),
            ram: pct(currentUsage.totalRamGb, limits.maxRamGb),
            storage: pct(currentUsage.totalStorageGb, limits.maxStorageGb),
            runs: pct(currentUsage.concurrentRuns, limits.maxConcurrentRuns),
        },
    };
}

debugLog("v12.5: VM quota enforcer loaded");
