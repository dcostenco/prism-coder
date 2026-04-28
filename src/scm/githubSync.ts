/**
 * v12.4: GitHub Issues/PR Bidirectional Sync
 *
 * Syncs Prism memory entries with GitHub Issues and Pull Requests.
 * - Memory decisions → GitHub Issues (auto-create)
 * - GitHub Issue comments → memory ledger entries
 * - PR merge events → session ledger (auto-record file changes)
 *
 * Uses GitHub REST API v3 with PAT authentication.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface GitHubConfig {
    owner: string;
    repo: string;
    token: string;
    baseUrl?: string; // For GitHub Enterprise
    syncEnabled: boolean;
    syncInterval: number; // minutes
    labelPrefix: string;
}

export interface SyncedIssue {
    issueNumber: number;
    title: string;
    memoryEntryId: string;
    project: string;
    syncedAt: string;
    direction: "memory_to_github" | "github_to_memory";
    state: "open" | "closed";
}

export interface SyncedPR {
    prNumber: number;
    title: string;
    branch: string;
    memoryEntryId: string;
    project: string;
    syncedAt: string;
    filesChanged: string[];
    merged: boolean;
}

export interface GitHubSyncResult {
    issuesCreated: number;
    issuesUpdated: number;
    prsTracked: number;
    memoryEntriesCreated: number;
    errors: string[];
    durationMs: number;
}

// ─── Config ──────────────────────────────────────────────────

const DEFAULT_CONFIG: GitHubConfig = {
    owner: "",
    repo: "",
    token: "",
    syncEnabled: false,
    syncInterval: 15,
    labelPrefix: "prism:",
};

let currentConfig: GitHubConfig = { ...DEFAULT_CONFIG };

export function configureGitHubSync(config: Partial<GitHubConfig>): void {
    currentConfig = { ...currentConfig, ...config };
    debugLog(`GitHub Sync: Configured for ${currentConfig.owner}/${currentConfig.repo}`);
}

export function getGitHubSyncConfig(): GitHubConfig {
    return { ...currentConfig, token: currentConfig.token ? "***" : "" };
}

// ─── API Helpers ─────────────────────────────────────────────

function getApiBase(): string {
    return currentConfig.baseUrl || "https://api.github.com";
}

function getHeaders(): Record<string, string> {
    return {
        Authorization: `Bearer ${currentConfig.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "User-Agent": "Prism-MCP-GitHubSync/12.4",
    };
}

async function githubFetch(
    path: string,
    method: string = "GET",
    body?: unknown,
): Promise<{ status: number; data: unknown }> {
    const url = `${getApiBase()}${path}`;
    const options: RequestInit = {
        method,
        headers: getHeaders(),
    };
    if (body) {
        options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);
    const data = await response.json();
    return { status: response.status, data };
}

// ─── Issue Sync ──────────────────────────────────────────────

/**
 * Create a GitHub Issue from a memory decision entry.
 */
export async function createIssueFromMemory(
    title: string,
    body: string,
    project: string,
    memoryEntryId: string,
    labels: string[] = [],
): Promise<SyncedIssue | null> {
    if (!currentConfig.token || !currentConfig.owner) {
        debugLog("GitHub Sync: Not configured, skipping issue creation");
        return null;
    }

    try {
        const { status, data } = await githubFetch(
            `/repos/${currentConfig.owner}/${currentConfig.repo}/issues`,
            "POST",
            {
                title: `[Prism] ${title}`,
                body: `${body}\n\n---\n*Synced from Prism project \`${project}\` | Entry: \`${memoryEntryId}\`*`,
                labels: [`${currentConfig.labelPrefix}synced`, ...labels],
            },
        );

        if (status === 201) {
            const issue = data as any;
            debugLog(`GitHub Sync: Created issue #${issue.number} from memory entry ${memoryEntryId}`);
            return {
                issueNumber: issue.number,
                title: issue.title,
                memoryEntryId,
                project,
                syncedAt: new Date().toISOString(),
                direction: "memory_to_github",
                state: "open",
            };
        }

        debugLog(`GitHub Sync: Failed to create issue (HTTP ${status})`);
        return null;
    } catch (err) {
        debugLog(`GitHub Sync: Issue creation error: ${err}`);
        return null;
    }
}

/**
 * List recent issues with the Prism sync label.
 */
export async function listSyncedIssues(
    state: "open" | "closed" | "all" = "open",
    limit: number = 20,
): Promise<SyncedIssue[]> {
    if (!currentConfig.token || !currentConfig.owner) return [];

    try {
        const { status, data } = await githubFetch(
            `/repos/${currentConfig.owner}/${currentConfig.repo}/issues?labels=${currentConfig.labelPrefix}synced&state=${state}&per_page=${limit}`,
        );

        if (status !== 200) return [];

        return (data as any[]).map((issue: any) => ({
            issueNumber: issue.number,
            title: issue.title,
            memoryEntryId: extractMemoryId(issue.body || ""),
            project: extractProject(issue.body || ""),
            syncedAt: issue.created_at,
            direction: "memory_to_github" as const,
            state: issue.state,
        }));
    } catch (err) {
        debugLog(`GitHub Sync: List issues error: ${err}`);
        return [];
    }
}

/**
 * Track a PR's file changes into memory.
 */
export async function trackPR(prNumber: number, project: string): Promise<SyncedPR | null> {
    if (!currentConfig.token || !currentConfig.owner) return null;

    try {
        const { status, data } = await githubFetch(
            `/repos/${currentConfig.owner}/${currentConfig.repo}/pulls/${prNumber}`,
        );

        if (status !== 200) return null;

        const pr = data as any;

        // Get files changed
        const { data: files } = await githubFetch(
            `/repos/${currentConfig.owner}/${currentConfig.repo}/pulls/${prNumber}/files`,
        );

        const filesChanged = (files as any[]).map((f: any) => f.filename);

        return {
            prNumber,
            title: pr.title,
            branch: pr.head?.ref || "unknown",
            memoryEntryId: `pr_${prNumber}_${Date.now()}`,
            project,
            syncedAt: new Date().toISOString(),
            filesChanged,
            merged: pr.merged || false,
        };
    } catch (err) {
        debugLog(`GitHub Sync: PR tracking error: ${err}`);
        return null;
    }
}

// ─── Helpers ─────────────────────────────────────────────────

function extractMemoryId(body: string): string {
    const match = body.match(/Entry: `([^`]+)`/);
    return match?.[1] || "unknown";
}

function extractProject(body: string): string {
    const match = body.match(/project `([^`]+)`/);
    return match?.[1] || "unknown";
}

/**
 * Get sync status summary.
 */
export function getSyncStatus(): {
    configured: boolean;
    enabled: boolean;
    repo: string;
    interval: number;
} {
    return {
        configured: !!(currentConfig.token && currentConfig.owner && currentConfig.repo),
        enabled: currentConfig.syncEnabled,
        repo: currentConfig.owner ? `${currentConfig.owner}/${currentConfig.repo}` : "not configured",
        interval: currentConfig.syncInterval,
    };
}

debugLog("v12.4: GitHub sync module loaded");
