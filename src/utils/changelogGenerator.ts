/**
 * v12.4: AI-Generated Changelogs from Session Ledger History
 *
 * Reads session ledger entries and generates human-readable changelogs
 * in Keep a Changelog format. Uses local LLM (if available) for
 * natural language summarization, with rule-based fallback.
 */

import { debugLog } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface ChangelogEntry {
    version: string;
    date: string;
    sections: {
        added: string[];
        changed: string[];
        fixed: string[];
        removed: string[];
        security: string[];
        deprecated: string[];
    };
}

export interface ChangelogOptions {
    project: string;
    fromDate?: string;
    toDate?: string;
    maxEntries?: number;
    format: "markdown" | "json" | "html";
    groupBy: "date" | "version" | "category";
    includeFileChanges: boolean;
    useLlm: boolean;
}

export interface LedgerEntry {
    id: string;
    summary: string;
    decisions?: string[];
    todos?: string[];
    files_changed?: string[];
    created_at: string;
    conversation_id: string;
    project: string;
}

// ─── Changelog Generation ────────────────────────────────────

/**
 * Classify a ledger summary into a changelog section.
 */
export function classifySummary(summary: string): keyof ChangelogEntry["sections"] {
    const lower = summary.toLowerCase();

    if (/\b(fix|bug|patch|resolve|repair|correct)\b/.test(lower)) return "fixed";
    if (/\b(remov|delet|drop|deprecat|rip out)\b/.test(lower)) return "removed";
    if (/\b(secur|vulnerab|cve|auth|encrypt|permission)\b/.test(lower)) return "security";
    if (/\b(deprecat|sunset|legacy|phase out)\b/.test(lower)) return "deprecated";
    if (/\b(add|creat|new|implement|introduc|support|feat)\b/.test(lower)) return "added";
    return "changed";
}

/**
 * Generate a changelog from ledger entries (rule-based).
 */
export function generateChangelog(
    entries: LedgerEntry[],
    options: Partial<ChangelogOptions> = {},
): ChangelogEntry {
    const {
        fromDate,
        toDate,
        groupBy = "date",
        includeFileChanges = false,
    } = options;

    // Filter by date range
    let filtered = entries;
    if (fromDate) {
        filtered = filtered.filter(e => new Date(e.created_at) >= new Date(fromDate));
    }
    if (toDate) {
        filtered = filtered.filter(e => new Date(e.created_at) <= new Date(toDate));
    }

    // Sort by date (newest first)
    filtered.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

    const sections: ChangelogEntry["sections"] = {
        added: [],
        changed: [],
        fixed: [],
        removed: [],
        security: [],
        deprecated: [],
    };

    for (const entry of filtered) {
        const section = classifySummary(entry.summary);
        let line = entry.summary;

        if (includeFileChanges && entry.files_changed?.length) {
            line += ` (${entry.files_changed.join(", ")})`;
        }

        sections[section].push(line);

        // Also classify decisions
        if (entry.decisions) {
            for (const decision of entry.decisions) {
                const dSection = classifySummary(decision);
                sections[dSection].push(`Decision: ${decision}`);
            }
        }
    }

    const now = new Date().toISOString().split("T")[0];
    return {
        version: "Unreleased",
        date: now,
        sections,
    };
}

/**
 * Format a changelog entry as Markdown (Keep a Changelog format).
 */
export function formatChangelogMarkdown(entry: ChangelogEntry): string {
    const lines: string[] = [];
    lines.push(`## [${entry.version}] - ${entry.date}`);
    lines.push("");

    const sectionNames: Array<[keyof ChangelogEntry["sections"], string]> = [
        ["added", "Added"],
        ["changed", "Changed"],
        ["fixed", "Fixed"],
        ["removed", "Removed"],
        ["security", "Security"],
        ["deprecated", "Deprecated"],
    ];

    for (const [key, label] of sectionNames) {
        if (entry.sections[key].length > 0) {
            lines.push(`### ${label}`);
            for (const item of entry.sections[key]) {
                lines.push(`- ${item}`);
            }
            lines.push("");
        }
    }

    return lines.join("\n");
}

/**
 * Format a changelog entry as HTML.
 */
export function formatChangelogHtml(entry: ChangelogEntry): string {
    let html = `<h2>[${entry.version}] - ${entry.date}</h2>\n`;

    const sectionNames: Array<[keyof ChangelogEntry["sections"], string]> = [
        ["added", "Added"],
        ["changed", "Changed"],
        ["fixed", "Fixed"],
        ["removed", "Removed"],
        ["security", "Security"],
        ["deprecated", "Deprecated"],
    ];

    for (const [key, label] of sectionNames) {
        if (entry.sections[key].length > 0) {
            html += `<h3>${label}</h3>\n<ul>\n`;
            for (const item of entry.sections[key]) {
                html += `  <li>${escapeHtml(item)}</li>\n`;
            }
            html += `</ul>\n`;
        }
    }

    return html;
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

/**
 * Generate a changelog with optional LLM summarization.
 */
export async function generateChangelogWithLlm(
    entries: LedgerEntry[],
    options: Partial<ChangelogOptions> = {},
): Promise<string> {
    const changelog = generateChangelog(entries, options);
    const format = options.format || "markdown";

    if (!options.useLlm) {
        return format === "html"
            ? formatChangelogHtml(changelog)
            : format === "json"
                ? JSON.stringify(changelog, null, 2)
                : formatChangelogMarkdown(changelog);
    }

    // LLM-enhanced: summarize each section
    try {
        const { callLocalLlm } = await import("./localLlm.js");
        const rawMarkdown = formatChangelogMarkdown(changelog);

        const enhanced = await callLocalLlm(
            `You are a technical writer. Rewrite this changelog to be more concise and professional. ` +
            `Keep the Keep a Changelog format. Combine duplicate entries. ` +
            `Use action verbs (Added, Fixed, Changed). Output markdown only:\n\n${rawMarkdown}`,
        );

        return enhanced || rawMarkdown;
    } catch {
        debugLog("Changelog: LLM unavailable, using rule-based output");
        return format === "html"
            ? formatChangelogHtml(changelog)
            : formatChangelogMarkdown(changelog);
    }
}

debugLog("v12.4: Changelog generator loaded");
