/**
 * SCM API Client — Thin Wrapper for Synalux SCM API
 * ===================================================
 * All engine logic stays in Synalux. Prism only calls the API.
 *
 * Usage:
 *   const client = new ScmClient('https://synalux.ai');
 *   const results = await client.search('owner/repo', { query: 'login', mode: 'exact' });
 *
 * Environment:
 *   SYNALUX_API_URL — Base URL (default: https://synalux.ai)
 *   SYNALUX_API_KEY — API key for authentication (required for paid tiers)
 */

import type {
    SearchQuery, SearchResponse,
    AIReviewResult, HipaaResult,
    ScanSummary, SecurityFinding,
    DoraMetrics,
} from './types.js';

const SAFE_SCM_NAME = /^[a-zA-Z0-9._-]+$/;

export class ScmClient {
    private readonly baseUrl: string;
    private readonly apiKey?: string;

    constructor(baseUrl?: string, apiKey?: string) {
        this.baseUrl = (baseUrl || process.env.SYNALUX_API_URL || 'https://synalux.ai').replace(/\/$/, '');
        this.apiKey = apiKey || process.env.SYNALUX_API_KEY;
    }

    private parseRepo(repo: string): [string, string] {
        const [owner, name] = repo.split('/');
        if (!owner || !name || !SAFE_SCM_NAME.test(owner) || !SAFE_SCM_NAME.test(name)) {
            throw new Error(`Invalid repo identifier: "${repo}". Owner and name must match /^[a-zA-Z0-9._-]+$/.`);
        }
        return [owner, name];
    }

    private async request<T>(path: string, options?: RequestInit): Promise<T> {
        const url = `${this.baseUrl}/api/v1/scm${path}`;
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        };

        const res = await fetch(url, { ...options, headers: { ...headers, ...options?.headers }, signal: AbortSignal.timeout(15_000) });

        if (!res.ok) {
            const body = await res.text().catch(() => '');
            throw new Error(`SCM API ${res.status}: ${body || res.statusText}`);
        }

        return res.json() as Promise<T>;
    }

    // ── Code Search ─────────────────────────────────────────

    async search(repo: string, query: SearchQuery): Promise<SearchResponse> {
        const [owner, name] = this.parseRepo(repo);
        return this.request<SearchResponse>(`/repos/${owner}/${name}/search`, {
            method: 'POST',
            body: JSON.stringify(query),
        });
    }

    // ── AI Review ───────────────────────────────────────────

    async review(repo: string, files: Array<{ name: string; content: string }>, options?: { hipaa?: boolean }): Promise<{ review: AIReviewResult; hipaa?: HipaaResult }> {
        const [owner, name] = this.parseRepo(repo);
        return this.request(`/repos/${owner}/${name}/review`, {
            method: 'POST',
            body: JSON.stringify({ files, hipaa: options?.hipaa }),
        });
    }

    // ── Security Scan ───────────────────────────────────────

    async scan(repo: string, files: Array<{ name: string; content: string }>): Promise<{ summary: ScanSummary; findings: SecurityFinding[] }> {
        const [owner, name] = this.parseRepo(repo);
        return this.request(`/repos/${owner}/${name}/security`, {
            method: 'POST',
            body: JSON.stringify({ files }),
        });
    }

    // ── DORA Metrics ────────────────────────────────────────

    async dora(repo: string, period?: string): Promise<DoraMetrics> {
        const [owner, name] = this.parseRepo(repo);
        const qs = period ? `?period=${encodeURIComponent(period)}` : '';
        return this.request<DoraMetrics>(`/repos/${owner}/${name}/dora${qs}`);
    }
}

/**
 * Create a ScmClient from environment config.
 */
export function createScmClient(): ScmClient {
    return new ScmClient();
}
