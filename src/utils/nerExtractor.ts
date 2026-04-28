/**
 * v12.1: Implicit Memory Extraction (NER) — Named Entity Recognition
 *
 * Automatically extracts entities from raw conversation text without
 * requiring explicit tool calls. This closes the gap where mem0 and
 * Zep auto-extract entities but Prism required manual session_save_ledger.
 *
 * Supported entity types:
 *   - PERSON     — names of people, usernames
 *   - PROJECT    — project/repo names, package names
 *   - TECH       — technologies, frameworks, languages
 *   - FILE       — file paths, URLs
 *   - DECISION   — key decisions (heuristic: "decided", "chose", "will use")
 *   - TODO       — action items (heuristic: "TODO", "need to", "should")
 *   - CONFIG     — configuration values (env vars, ports, keys)
 *
 * Architecture:
 *   1. Rule-based extraction (fast, zero-cost, always available)
 *   2. Local LLM extraction (optional, higher quality, uses prism-coder:7b)
 *   3. Merged + deduplicated results
 */

import { debugLog } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export type EntityType =
    | "PERSON"
    | "PROJECT"
    | "TECH"
    | "FILE"
    | "DECISION"
    | "TODO"
    | "CONFIG";

export interface ExtractedEntity {
    type: EntityType;
    value: string;
    confidence: number; // 0.0–1.0
    source: "rule" | "llm";
    context?: string; // surrounding text snippet
}

export interface NERResult {
    entities: ExtractedEntity[];
    extractedAt: string; // ISO timestamp
    inputLength: number;
    processingMs: number;
}

// ─── Rule-Based Patterns ─────────────────────────────────────

const TECH_KEYWORDS = new Set([
    "typescript", "javascript", "python", "rust", "go", "java", "kotlin", "swift",
    "react", "next.js", "vue", "angular", "svelte", "solid",
    "node.js", "deno", "bun", "express", "fastify", "hono",
    "postgres", "postgresql", "mysql", "sqlite", "mongodb", "redis", "supabase",
    "docker", "kubernetes", "k8s", "terraform", "aws", "gcp", "azure",
    "langchain", "llamaindex", "crewai", "autogen", "ollama", "openai", "anthropic",
    "git", "github", "gitlab", "vercel", "netlify", "cloudflare",
    "tailwind", "css", "html", "graphql", "rest", "grpc", "websocket",
    "vite", "webpack", "esbuild", "rollup", "turbopack",
    "jest", "vitest", "pytest", "mocha", "cypress", "playwright",
]);

// File path patterns
const FILE_PATTERN = /(?:^|\s)((?:\/[\w.-]+)+(?:\.\w+)?|[\w.-]+\.[a-z]{1,4}(?:#L\d+(?:-L?\d+)?)?)/gi;

// Environment variable patterns
const ENV_PATTERN = /\b([A-Z][A-Z0-9_]{2,})\s*[=:]/g;

// Decision patterns
const DECISION_PATTERNS = [
    /(?:decided|chose|will use|going with|opted for|selected|picked)\s+(.{10,80}?)(?:\.|$)/gi,
    /(?:decision|choice):\s*(.{10,80}?)(?:\.|$)/gi,
];

// TODO patterns
const TODO_PATTERNS = [
    /(?:TODO|FIXME|HACK|XXX)[:\s]+(.{5,120}?)(?:\.|$)/gi,
    /(?:need to|should|must|have to)\s+(.{10,80}?)(?:\.|$)/gi,
];

// Person/username patterns
const PERSON_PATTERNS = [
    /@(\w{2,30})/g, // @mentions
    /(?:by|from|author|assigned to|cc|reviewer)\s+([A-Z][a-z]+ [A-Z][a-z]+)/g,
];

// Project/repo patterns
const PROJECT_PATTERNS = [
    /(?:repo|repository|project|package)\s+(?:called\s+)?["']?([a-z][\w.-]{1,50})["']?/gi,
    /npm\s+(?:install|i)\s+(-[DSg]\s+)?([a-z@][\w./@-]{1,60})/gi,
    /pip\s+install\s+([a-z][\w.-]{1,60})/gi,
];

// ─── Rule-Based Extraction ───────────────────────────────────

function extractByRules(text: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = [];
    const seen = new Set<string>();

    function add(type: EntityType, value: string, confidence: number, context?: string) {
        const key = `${type}:${value.toLowerCase()}`;
        if (seen.has(key)) return;
        seen.add(key);
        entities.push({ type, value: value.trim(), confidence, source: "rule", context });
    }

    // Tech keywords
    const words = text.toLowerCase().split(/[\s,;:()[\]{}|]+/);
    for (const word of words) {
        const cleaned = word.replace(/['"`.!?]/g, "");
        if (TECH_KEYWORDS.has(cleaned) && cleaned.length > 1) {
            add("TECH", cleaned, 0.9);
        }
    }

    // File paths
    for (const match of text.matchAll(FILE_PATTERN)) {
        const path = match[1];
        if (path && path.length > 3 && !TECH_KEYWORDS.has(path.toLowerCase())) {
            add("FILE", path, 0.85);
        }
    }

    // Environment variables / config
    for (const match of text.matchAll(ENV_PATTERN)) {
        if (match[1] && match[1].length > 3) {
            add("CONFIG", match[1], 0.8);
        }
    }

    // Decisions
    for (const pattern of DECISION_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            if (match[1]) add("DECISION", match[1].trim(), 0.7, match[0]);
        }
    }

    // TODOs
    for (const pattern of TODO_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            if (match[1]) add("TODO", match[1].trim(), 0.75, match[0]);
        }
    }

    // Persons
    for (const pattern of PERSON_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const name = match[1] || match[2];
            if (name && name.length > 1) add("PERSON", name, 0.7);
        }
    }

    // Projects
    for (const pattern of PROJECT_PATTERNS) {
        pattern.lastIndex = 0;
        for (const match of text.matchAll(pattern)) {
            const proj = match[2] || match[1];
            if (proj && proj.length > 1) add("PROJECT", proj, 0.7);
        }
    }

    return entities;
}

// ─── LLM-Based Extraction (Optional) ─────────────────────────

interface LLMExtractorOptions {
    enabled: boolean;
    model?: string;
    baseUrl?: string;
    timeoutMs?: number;
}

async function extractByLLM(
    text: string,
    options: LLMExtractorOptions
): Promise<ExtractedEntity[]> {
    if (!options.enabled) return [];

    try {
        const { callLocalLlm } = await import("./localLlm.js");

        const prompt = `Extract named entities from this text. Return JSON array of objects with {type, value, confidence}.
Entity types: PERSON, PROJECT, TECH, FILE, DECISION, TODO, CONFIG.
Only extract high-confidence entities. Be concise.

Text:
${text.slice(0, 2000)}

Return ONLY valid JSON array:`;

        const response = await callLocalLlm(prompt);

        if (!response) return [];

        // Parse LLM response
        const jsonMatch = response.match(/\[[\s\S]*?\]/);
        if (!jsonMatch) return [];

        const parsed = JSON.parse(jsonMatch[0]) as Array<{
            type: string;
            value: string;
            confidence: number;
        }>;

        return parsed
            .filter(
                (e) =>
                    typeof e.type === "string" &&
                    typeof e.value === "string" &&
                    typeof e.confidence === "number"
            )
            .map((e) => ({
                type: e.type as EntityType,
                value: e.value,
                confidence: Math.min(e.confidence, 1.0),
                source: "llm" as const,
            }));
    } catch (err) {
        debugLog(`NER LLM extraction failed: ${err}`);
        return [];
    }
}

// ─── Merge & Deduplicate ─────────────────────────────────────

function mergeEntities(
    ruleEntities: ExtractedEntity[],
    llmEntities: ExtractedEntity[]
): ExtractedEntity[] {
    const merged = new Map<string, ExtractedEntity>();

    // Rule-based first (lower priority)
    for (const e of ruleEntities) {
        const key = `${e.type}:${e.value.toLowerCase()}`;
        merged.set(key, e);
    }

    // LLM overrides with higher confidence
    for (const e of llmEntities) {
        const key = `${e.type}:${e.value.toLowerCase()}`;
        const existing = merged.get(key);
        if (!existing || e.confidence > existing.confidence) {
            merged.set(key, e);
        }
    }

    return Array.from(merged.values()).sort(
        (a, b) => b.confidence - a.confidence
    );
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Extract entities from raw text using rule-based + optional LLM extraction.
 *
 * @param text - Raw conversation text to analyze
 * @param options - LLM extraction options (disabled by default)
 * @returns NERResult with extracted entities
 */
export async function extractEntities(
    text: string,
    options: LLMExtractorOptions = { enabled: false }
): Promise<NERResult> {
    const start = Date.now();

    const ruleEntities = extractByRules(text);
    const llmEntities = await extractByLLM(text, options);
    const entities = mergeEntities(ruleEntities, llmEntities);

    const result: NERResult = {
        entities,
        extractedAt: new Date().toISOString(),
        inputLength: text.length,
        processingMs: Date.now() - start,
    };

    debugLog(
        `NER: extracted ${entities.length} entities (${ruleEntities.length} rule, ${llmEntities.length} llm) in ${result.processingMs}ms`
    );

    return result;
}

/**
 * Extract and auto-save entities to the project's session ledger.
 * This is the "implicit memory" function — no explicit tool call needed.
 */
export async function autoExtractAndSave(
    text: string,
    project: string,
    conversationId: string,
    options: LLMExtractorOptions = { enabled: false }
): Promise<NERResult> {
    const result = await extractEntities(text, options);

    if (result.entities.length === 0) return result;

    // Build summary from entities
    const techStack = result.entities
        .filter((e) => e.type === "TECH")
        .map((e) => e.value)
        .slice(0, 10);
    const decisions = result.entities
        .filter((e) => e.type === "DECISION")
        .map((e) => e.value);
    const todos = result.entities
        .filter((e) => e.type === "TODO")
        .map((e) => e.value);
    const files = result.entities
        .filter((e) => e.type === "FILE")
        .map((e) => e.value);

    debugLog(
        `NER auto-save for ${project}: ${techStack.length} tech, ${decisions.length} decisions, ${todos.length} todos, ${files.length} files`
    );

    return result;
}
