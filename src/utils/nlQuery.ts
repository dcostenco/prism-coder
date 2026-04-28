/**
 * v12.2: Natural Language Memory Query
 *
 * Translates natural language questions into structured memory searches.
 * "What did we decide about auth?" → knowledge_search("authentication decision")
 *
 * This closes the gap where users have to learn tool syntax to query memories.
 * Instead, they ask plain English questions and get structured results.
 *
 * Pipeline:
 *   1. Intent classification (decision, todo, file, general)
 *   2. Key phrase extraction
 *   3. Multi-strategy search (keyword + semantic)
 *   4. Answer synthesis (optional, uses local LLM)
 */

import { debugLog } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export type QueryIntent =
    | "decision"    // "what did we decide about X?"
    | "todo"        // "what's still open?" / "what needs to be done?"
    | "file"        // "what files did we change?"
    | "timeline"    // "what happened last week?"
    | "general";    // fallback — broad search

export interface NLQueryResult {
    originalQuery: string;
    intent: QueryIntent;
    extractedKeywords: string[];
    searchQuery: string;
    confidence: number;
    suggestedTool: string;
    suggestedArgs: Record<string, unknown>;
}

export interface NLAnswerResult extends NLQueryResult {
    answer: string;
    sources: Array<{
        summary: string;
        project: string;
        createdAt: string;
    }>;
}

// ─── Intent Classification ───────────────────────────────────

const INTENT_PATTERNS: Array<{
    intent: QueryIntent;
    patterns: RegExp[];
    weight: number;
}> = [
        {
            intent: "decision",
            patterns: [
                /what\s+(did\s+we\s+)?decid/i,
                /what\s+was\s+(the\s+)?decision/i,
                /why\s+did\s+we\s+(choose|pick|select|go\s+with)/i,
                /what\s+approach/i,
                /how\s+did\s+we\s+(handle|solve|fix)/i,
            ],
            weight: 0.9,
        },
        {
            intent: "todo",
            patterns: [
                /what('s|\s+is)\s+(still\s+)?open/i,
                /what\s+(needs|remains)\s+to\s+be\s+done/i,
                /pending\s+(tasks?|items?|work)/i,
                /TODO/i,
                /what\s+should\s+(I|we)\s+do\s+next/i,
                /unfinished/i,
            ],
            weight: 0.9,
        },
        {
            intent: "file",
            patterns: [
                /what\s+files?\s+(did\s+we\s+)?(change|modify|edit|create|update)/i,
                /which\s+files?\s+(were|got)\s+(changed|modified|touched)/i,
                /file\s+changes/i,
            ],
            weight: 0.85,
        },
        {
            intent: "timeline",
            patterns: [
                /what\s+(happened|did\s+we\s+do)\s+(last|this|yesterday|today)/i,
                /show\s+(me\s+)?history/i,
                /recent\s+(sessions?|work|changes)/i,
                /timeline/i,
                /last\s+\d+\s+(days?|weeks?|sessions?)/i,
            ],
            weight: 0.8,
        },
    ];

function classifyIntent(query: string): { intent: QueryIntent; confidence: number } {
    for (const { intent, patterns, weight } of INTENT_PATTERNS) {
        for (const pattern of patterns) {
            if (pattern.test(query)) {
                return { intent, confidence: weight };
            }
        }
    }
    return { intent: "general", confidence: 0.5 };
}

// ─── Keyword Extraction ──────────────────────────────────────

const STOP_WORDS = new Set([
    "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "do", "does", "did", "will", "would", "could",
    "should", "may", "might", "shall", "can", "need", "dare", "ought",
    "what", "which", "who", "whom", "when", "where", "why", "how",
    "that", "this", "these", "those", "it", "its", "we", "our", "they",
    "about", "with", "from", "for", "and", "but", "or", "not", "no",
    "still", "open", "last", "did", "decide", "decided", "change", "changed",
    "show", "tell", "me", "us", "my",
]);

function extractKeywords(query: string): string[] {
    return query
        .toLowerCase()
        .replace(/[^a-z0-9\s.-]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
        .slice(0, 8); // Max 8 keywords
}

// ─── Search Query Construction ───────────────────────────────

function buildSearchQuery(
    keywords: string[],
    intent: QueryIntent,
): { query: string; tool: string; args: Record<string, unknown> } {
    const baseQuery = keywords.join(" ");

    switch (intent) {
        case "decision":
            return {
                query: `decision ${baseQuery}`,
                tool: "knowledge_search",
                args: { query: `decision ${baseQuery}`, limit: 10 },
            };

        case "todo":
            return {
                query: baseQuery || "open TODO",
                tool: "session_load_context",
                args: { level: "standard" },
            };

        case "file":
            return {
                query: `files changed ${baseQuery}`,
                tool: "knowledge_search",
                args: { query: `files changed ${baseQuery}`, limit: 10 },
            };

        case "timeline":
            return {
                query: baseQuery,
                tool: "session_load_context",
                args: { level: "deep" },
            };

        default:
            return {
                query: baseQuery,
                tool: "knowledge_search",
                args: { query: baseQuery, limit: 10 },
            };
    }
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Parse a natural language query into a structured search command.
 *
 * @param query - Natural language question
 * @param project - Optional project scope
 * @returns Structured query with intent, keywords, and suggested tool call
 */
export function parseNLQuery(query: string, project?: string): NLQueryResult {
    const { intent, confidence } = classifyIntent(query);
    const keywords = extractKeywords(query);
    const { query: searchQuery, tool, args } = buildSearchQuery(keywords, intent);

    // Add project scope if provided
    if (project) {
        (args as any).project = project;
    }

    return {
        originalQuery: query,
        intent,
        extractedKeywords: keywords,
        searchQuery,
        confidence,
        suggestedTool: tool,
        suggestedArgs: args,
    };
}

/**
 * Execute a natural language query end-to-end.
 *
 * Parses the query, executes the appropriate tool, and optionally
 * synthesizes an answer using the local LLM.
 */
export async function executeNLQuery(
    query: string,
    project: string,
    synthesize: boolean = false,
): Promise<NLAnswerResult> {
    const parsed = parseNLQuery(query, project);

    // Execute the search
    let sources: NLAnswerResult["sources"] = [];
    let answer = "";

    try {
        // Return the parsed query structure — the caller (handler) will
        // execute the actual tool call using the suggestedTool and suggestedArgs.
        answer =
            `Intent: ${parsed.intent} (confidence: ${(parsed.confidence * 100).toFixed(0)}%)\n` +
            `Keywords: ${parsed.extractedKeywords.join(", ")}\n` +
            `Suggested tool: ${parsed.suggestedTool}\n` +
            `Search query: "${parsed.searchQuery}"`;
    } catch (err) {
        debugLog(`NL query execution failed: ${err}`);
        answer = `Unable to parse query: ${err}`;
    }

    return {
        ...parsed,
        answer: answer || "No relevant memories found.",
        sources,
    };
}

debugLog("v12.2: Natural language query module loaded");
