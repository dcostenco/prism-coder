/**
 * Session Memory Handlers (v0.4.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: v0.4.0 CHANGES IN THIS FILE
 *
 * 1. sessionSaveLedgerHandler:
 *    - NOW generates embeddings via fire-and-forget for semantic search
 *    - Embedding failure is non-fatal (logged, not thrown)
 *
 * 2. sessionSaveHandoffHandler:
 *    - NOW uses save_handoff_with_version RPC for OCC
 *    - Handles version conflicts gracefully with recovery instructions
 *    - Includes LLM's attempted data in conflict errors (so it's not lost)
 *    - Triggers resource subscription notifications on success
 *
 * 3. sessionLoadContextHandler:
 *    - NOW returns version field from get_session_context (for OCC)
 *
 * 4. NEW: sessionSearchMemoryHandler
 *    - Semantic search via pgvector embeddings
 * ═══════════════════════════════════════════════════════════════════
 */

import { supabasePost, supabaseRpc, supabaseDelete, supabaseGet, supabasePatch } from "../utils/supabaseApi.js";
import { toKeywordArray } from "../utils/keywordExtractor.js";
import { generateEmbedding } from "../utils/embeddingApi.js";
import { GOOGLE_API_KEY } from "../config.js";
import {
  isSessionSaveLedgerArgs,
  isSessionSaveHandoffArgs,
  isSessionLoadContextArgs,
  isKnowledgeSearchArgs,
  isKnowledgeForgetArgs,
  isSessionSearchMemoryArgs,
} from "./sessionMemoryDefinitions.js";

// ─── v0.4.0: Import server type for resource notifications ───
// REVIEWER NOTE: The handoff handler needs to call
// notifyResourceUpdate() after a successful save. The server
// instance is passed as a second argument from the call_tool
// handler in server.ts.
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { notifyResourceUpdate } from "../server.js";

// ─── Save Ledger Handler ──────────────────────────────────────

/**
 * Appends an immutable session log entry.
 *
 * Think of the ledger as a "commit log" for agent work — once written, entries
 * are never modified. This creates a permanent audit trail of all work done.
 *
 * v0.4.0 ADDITION: After saving, generates an embedding vector for the entry
 * via fire-and-forget. The embedding is used by session_search_memory for
 * semantic search. Embedding failure is non-fatal — the entry is saved
 * regardless of whether the embedding succeeds.
 *
 * WHY FIRE-AND-FORGET: Embedding generation takes 200-500ms. We don't want
 * to block the tool response on this. Instead, we:
 *   1. Save the entry immediately (fast, no embedding)
 *   2. Return success to the LLM
 *   3. Generate the embedding in the background
 *   4. PATCH the entry with the embedding when it's ready
 *   5. If it fails, log the error and move on
 */
export async function sessionSaveLedgerHandler(args: unknown) {
  if (!isSessionSaveLedgerArgs(args)) {
    throw new Error("Invalid arguments for session_save_ledger");
  }

  const { project, conversation_id, summary, todos, files_changed, decisions } = args;

  console.error(`[session_save_ledger] Saving ledger entry for project="${project}"`);

  // Auto-extract keywords from summary + decisions for knowledge accumulation
  const combinedText = [summary, ...(decisions || [])].join(" ");
  const keywords = toKeywordArray(combinedText);
  console.error(`[session_save_ledger] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);

  // Build the record to insert into the session_ledger table
  const record = {
    project,
    conversation_id,
    summary,
    todos: todos || [],
    files_changed: files_changed || [],
    decisions: decisions || [],
    keywords,
  };

  const result = await supabasePost("session_ledger", record);

  // ─── v0.4.0: Fire-and-forget embedding generation ───
  // REVIEWER NOTE: We deliberately don't await this promise.
  // The main save is already complete. The embedding is a bonus
  // for semantic search — if it fails, we log and move on.
  //
  // TRUNCATION: The embedding API has a token limit. We combine
  // summary + decisions into a single text and rely on
  // generateEmbedding() to truncate if needed (see embeddingApi.ts).
  if (GOOGLE_API_KEY && result) {
    const embeddingText = [summary, ...(decisions || [])].join("\n");
    const savedEntry = Array.isArray(result) ? result[0] : result;
    const entryId = savedEntry?.id;

    if (entryId) {
      // Fire-and-forget: generate embedding and update the row
      generateEmbedding(embeddingText)
        .then(async (embedding) => {
          // PATCH the ledger entry with the generated embedding
          await supabasePatch(
            "session_ledger",
            { embedding: JSON.stringify(embedding) },
            { id: `eq.${entryId}` }
          );
          console.error(`[session_save_ledger] Embedding saved for entry ${entryId}`);
        })
        .catch((err) => {
          // REVIEWER NOTE: Non-fatal. The entry is already saved.
          // This can fail if:
          //   1. Gemini API is temporarily unavailable
          //   2. The text is somehow malformed
          //   3. pgvector extension isn't enabled yet
          // In all cases, the entry works fine without an embedding —
          // it just won't appear in semantic search results until
          // the embedding is backfilled.
          console.error(`[session_save_ledger] Embedding generation failed (non-fatal): ${err.message}`);
        });
    }
  }

  // Return a human-readable confirmation with key stats
  return {
    content: [{
      type: "text",
      text: `✅ Session ledger saved for project "${project}"\n` +
        `Summary: ${summary}\n` +
        (todos?.length ? `TODOs: ${todos.length} items\n` : "") +
        (files_changed?.length ? `Files changed: ${files_changed.length}\n` : "") +
        (decisions?.length ? `Decisions: ${decisions.length}\n` : "") +
        (GOOGLE_API_KEY ? `📊 Embedding generation queued for semantic search.\n` : "") +
        `\nRaw response: ${JSON.stringify(result)}`,
    }],
    isError: false,
  };
}

// ─── Save Handoff Handler ─────────────────────────────────────

/**
 * Upserts the latest project handoff state with OCC.
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: v0.4.0 MAJOR CHANGES
 *
 * BEFORE (v0.3.0):
 *   Used PostgREST upsert with "merge-duplicates" →
 *   Last write wins → data loss if two clients save simultaneously.
 *
 * AFTER (v0.4.0):
 *   Uses save_handoff_with_version RPC →
 *   Optimistic concurrency control → rejects stale writes →
 *   Conflict error includes the LLM's attempted data so it's not lost.
 *
 * RESOURCE NOTIFICATIONS:
 *   On successful save, calls notifyResourceUpdate() to push a
 *   silent refresh to any Claude Desktop instance that has this
 *   project's memory resource attached via paperclip.
 *
 * VERSION CONFLICT HANDLING:
 *   When a conflict is detected, the error message includes:
 *   1. What happened (version mismatch explanation)
 *   2. The LLM's attempted data (so regeneration isn't needed)
 *   3. Instructions to reload and merge
 *   This prevents the LLM from losing its generated summary/TODOs.
 * ═══════════════════════════════════════════════════════════════════
 */
export async function sessionSaveHandoffHandler(args: unknown, server?: Server) {
  if (!isSessionSaveHandoffArgs(args)) {
    throw new Error("Invalid arguments for session_save_handoff");
  }

  const {
    project,
    expected_version,
    open_todos,
    active_branch,
    last_summary,
    key_context,
  } = args;

  console.error(
    `[session_save_handoff] Saving handoff for project="${project}" ` +
    `(expected_version=${expected_version ?? "none"})`
  );

  // Auto-extract keywords from summary + context for knowledge accumulation
  const combinedText = [last_summary || "", key_context || ""].filter(Boolean).join(" ");
  const keywords = combinedText ? toKeywordArray(combinedText) : undefined;
  if (keywords) {
    console.error(`[session_save_handoff] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);
  }

  // ─── v0.4.0: Call save_handoff_with_version RPC instead of raw upsert ───
  // REVIEWER NOTE: The RPC handles three cases:
  //   1. No existing handoff → INSERT (version = 1)
  //   2. Version match (or no check) → UPDATE (version++)
  //   3. Version mismatch → CONFLICT (return error with recovery data)
  const result = await supabaseRpc("save_handoff_with_version", {
    p_project: project,
    p_expected_version: expected_version ?? null,
    p_last_summary: last_summary ?? null,
    p_pending_todo: open_todos ?? null,
    p_active_decisions: null,
    p_keywords: keywords ?? null,
    p_key_context: key_context ?? null,
    p_active_branch: active_branch ?? null,
  });

  const data = Array.isArray(result) ? result[0] : result;

  // ─── Handle version conflict ───
  // REVIEWER NOTE: When a conflict is detected, we include the LLM's
  // attempted save data in the error. This is critical because the LLM
  // may have spent 30 seconds generating this data — if we just say
  // "conflict, try again", those thoughts are lost forever.
  if (data?.status === "conflict") {
    console.error(
      `[session_save_handoff] VERSION CONFLICT for "${project}": ` +
      `expected=${expected_version}, current=${data.current_version}`
    );

    return {
      content: [{
        type: "text",
        text: `⚠️ Version conflict detected for project "${project}"!\n\n` +
          `You sent version ${expected_version}, but the current version is ${data.current_version}.\n` +
          `Another session has updated this project since you loaded context.\n\n` +
          `Please call session_load_context to see what changed, then merge ` +
          `it with your attempted updates:\n` +
          (last_summary
            ? `  Your attempted summary: ${last_summary}\n`
            : "") +
          (open_todos?.length
            ? `  Your attempted TODOs: ${JSON.stringify(open_todos)}\n`
            : "") +
          (key_context
            ? `  Your attempted key_context: ${key_context}\n`
            : "") +
          (active_branch
            ? `  Your attempted active_branch: ${active_branch}\n`
            : "") +
          `\nAfter reviewing the latest state, call session_save_handoff again ` +
          `with the updated expected_version.`,
      }],
      isError: true,
    };
  }

  // ─── Success: handoff created or updated ───
  const newVersion = data?.version;

  // ─── v0.4.0: Trigger resource subscription notification ───
  // REVIEWER NOTE: If any Claude Desktop instance has
  // memory://project/handoff attached via paperclip, this
  // silently refreshes their attached context so it's never stale.
  if (server && (data?.status === "created" || data?.status === "updated")) {
    try {
      notifyResourceUpdate(project, server);
    } catch (err) {
      // Non-fatal: subscription notification failure shouldn't
      // prevent a successful save from being reported
      console.error(`[session_save_handoff] Resource notification failed (non-fatal): ${err}`);
    }
  }

  return {
    content: [{
      type: "text",
      text: `✅ Handoff ${data?.status || "saved"} for project "${project}" ` +
        `(version: ${newVersion})\n` +
        (last_summary ? `Last summary: ${last_summary}\n` : "") +
        (open_todos?.length ? `Open TODOs: ${open_todos.length} items\n` : "") +
        (active_branch ? `Active branch: ${active_branch}\n` : "") +
        `\n🔑 Remember: pass expected_version: ${newVersion} on your next save ` +
        `to maintain concurrency control.`,
    }],
    isError: false,
  };
}

// ─── Load Context Handler ─────────────────────────────────────

/**
 * Loads session context for a project at the requested depth level.
 *
 * v0.4.0 CHANGE: The response now includes a `version` field from
 * session_handoffs. The LLM should note this version and pass it
 * back as `expected_version` when calling session_save_handoff.
 */
export async function sessionLoadContextHandler(args: unknown) {
  if (!isSessionLoadContextArgs(args)) {
    throw new Error("Invalid arguments for session_load_context");
  }

  // Default to "standard" if no level specified — best balance of context vs token cost
  const { project, level = "standard" } = args;

  // Validate the level before making the API call
  const validLevels = ["quick", "standard", "deep"];
  if (!validLevels.includes(level)) {
    return {
      content: [{
        type: "text",
        text: `Invalid level "${level}". Must be one of: ${validLevels.join(", ")}`,
      }],
      isError: true,
    };
  }

  console.error(`[session_load_context] Loading ${level} context for project="${project}"`);

  const result = await supabaseRpc("get_session_context", {
    p_project: project,
    p_level: level,
  });

  const data = Array.isArray(result) ? result[0] : result;

  if (!data) {
    return {
      content: [{
        type: "text",
        text: `No session context found for project "${project}" at level ${level}.\n` +
          `This project has no previous session history. Starting fresh.`,
      }],
      isError: false,
    };
  }

  // REVIEWER NOTE: v0.4.0 adds explicit version reminder in the response.
  // The version is already in the JSON data, but we call it out explicitly
  // to make sure the LLM notices and uses it.
  const version = data?.version;
  const versionNote = version
    ? `\n\n🔑 Session version: ${version}. Pass expected_version: ${version} when saving handoff.`
    : "";

  return {
    content: [{
      type: "text",
      text: `📋 Session context for "${project}" (${level}):\n\n${JSON.stringify(data, null, 2)}${versionNote}`,
    }],
    isError: false,
  };
}

// ─── Knowledge Search Handler ─────────────────────────────────

/**
 * Searches accumulated knowledge across all past sessions.
 *
 * This is the "brain query" tool — it searches keywords that were
 * automatically extracted from every saved ledger and handoff entry.
 * Results are ranked by relevance (keyword overlap + full-text match).
 */
export async function knowledgeSearchHandler(args: unknown) {
  if (!isKnowledgeSearchArgs(args)) {
    throw new Error("Invalid arguments for knowledge_search");
  }

  const { project, query, category, limit = 10 } = args;

  console.error(`[knowledge_search] Searching: project=${project || "all"}, query="${query || ""}", category=${category || "any"}, limit=${limit}`);

  // Extract keywords from the query text to use in array-overlap search
  const searchKeywords = query ? toKeywordArray(query) : [];

  const result = await supabaseRpc("search_knowledge", {
    p_project: project || null,
    p_keywords: searchKeywords,
    p_category: category || null,
    p_query_text: query || null,
    p_limit: Math.min(limit, 50),
  });

  const data = Array.isArray(result) ? result[0] : result;

  if (!data || !data.results || data.count === 0) {
    return {
      content: [{
        type: "text",
        text: `🔍 No knowledge found matching your search.\n` +
          (query ? `Query: "${query}"\n` : "") +
          (category ? `Category: ${category}\n` : "") +
          (project ? `Project: ${project}\n` : "") +
          `\nTip: Try session_search_memory for semantic (meaning-based) search ` +
          `if keyword search doesn't find what you need.`,
      }],
      isError: false,
    };
  }

  return {
    content: [{
      type: "text",
      text: `🧠 Found ${data.count} knowledge entries:\n\n${JSON.stringify(data, null, 2)}`,
    }],
    isError: false,
  };
}

// ─── Knowledge Forget Handler ─────────────────────────────────

/**
 * Selectively forget (delete) accumulated knowledge entries.
 * Unchanged from v0.3.0 — see in-line comments for details.
 */
export async function knowledgeForgetHandler(args: unknown) {
  if (!isKnowledgeForgetArgs(args)) {
    throw new Error("Invalid arguments for knowledge_forget");
  }

  const {
    project,
    category,
    older_than_days,
    clear_handoff = false,
    confirm_all = false,
    dry_run = false,
  } = args;

  if (!project && !confirm_all) {
    return {
      content: [{
        type: "text",
        text: `⚠️ Safety check: You must specify a 'project' to forget, ` +
          `or set 'confirm_all: true' to wipe all entries.\n` +
          `This prevents accidental deletion of all knowledge.`,
      }],
      isError: true,
    };
  }

  console.error(`[knowledge_forget] ${dry_run ? "DRY RUN: " : ""}Forgetting: ` +
    `project=${project || "ALL"}, category=${category || "any"}, ` +
    `older_than=${older_than_days || "any"}d, clear_handoff=${clear_handoff}`);

  const ledgerParams: Record<string, string> = {};
  if (project) {
    ledgerParams.project = `eq.${project}`;
  }
  if (category) {
    ledgerParams.keywords = `cs.{cat:${category}}`;
  }
  if (older_than_days) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - older_than_days);
    ledgerParams.created_at = `lt.${cutoffDate.toISOString()}`;
  }

  let ledgerCount = 0;
  let handoffCleared = false;

  if (dry_run) {
    const selectParams = { ...ledgerParams, select: "id" };
    const entries = await supabaseGet("session_ledger", selectParams);
    ledgerCount = Array.isArray(entries) ? entries.length : 0;
  } else {
    const result = await supabaseDelete("session_ledger", ledgerParams);
    ledgerCount = Array.isArray(result) ? result.length : 0;

    if (clear_handoff && project) {
      await supabaseDelete("session_handoffs", { project: `eq.${project}` });
      handoffCleared = true;
    }
  }

  const action = dry_run ? "would be forgotten" : "forgotten";
  const emoji = dry_run ? "🔍" : "🧹";

  return {
    content: [{
      type: "text",
      text: `${emoji} ${ledgerCount} ledger entries ${action}` +
        (project ? ` for project "${project}"` : "") +
        (category ? ` in category "${category}"` : "") +
        (older_than_days ? ` older than ${older_than_days} days` : "") +
        `.\n` +
        (handoffCleared ? `🗑️ Handoff state also cleared for "${project}".\n` : "") +
        (dry_run ? `\n💡 This was a dry run — nothing was actually deleted. Remove dry_run to execute.` : "") +
        (!dry_run && ledgerCount > 0 ? `\n✅ Knowledge base pruned. Fresh start!` : ""),
    }],
    isError: false,
  };
}

// ─── v0.4.0: Semantic Search Handler (Enhancement #4) ─────────

/**
 * Searches session history semantically using pgvector embeddings.
 *
 * ═══════════════════════════════════════════════════════════════════
 * REVIEWER NOTE: This complements the keyword-based knowledge_search.
 *
 * HOW IT WORKS:
 *   1. Takes the user's natural language query
 *   2. Generates a 768-dim embedding via Gemini's text-embedding-004
 *   3. Calls semantic_search_ledger RPC (Supabase/pgvector)
 *   4. Returns results ranked by cosine similarity
 *
 * WHEN TO USE (vs knowledge_search):
 *   - knowledge_search: best when you know the exact keywords
 *     ("supabase migration", "authentication bug")
 *   - session_search_memory: best when the phrasing differs
 *     ("that thing we fixed with the login last week")
 *
 * PREREQUISITES:
 *   - pgvector extension enabled in Supabase
 *   - GOOGLE_API_KEY configured (for embedding generation)
 *   - Ledger entries with embeddings (generated at save time)
 * ═══════════════════════════════════════════════════════════════════
 */
export async function sessionSearchMemoryHandler(args: unknown) {
  if (!isSessionSearchMemoryArgs(args)) {
    throw new Error("Invalid arguments for session_search_memory");
  }

  const {
    query,
    project,
    limit = 5,
    similarity_threshold = 0.7,
  } = args;

  console.error(
    `[session_search_memory] Semantic search: query="${query}", ` +
    `project=${project || "all"}, limit=${limit}, threshold=${similarity_threshold}`
  );

  // Step 1: Generate embedding for the search query
  if (!GOOGLE_API_KEY) {
    return {
      content: [{
        type: "text",
        text: `❌ Semantic search requires GOOGLE_API_KEY for embedding generation.\n` +
          `Set this environment variable and restart the server.\n\n` +
          `💡 As a workaround, try knowledge_search (keyword-based) instead.`,
      }],
      isError: true,
    };
  }

  let queryEmbedding: number[];
  try {
    queryEmbedding = await generateEmbedding(query);
  } catch (err) {
    return {
      content: [{
        type: "text",
        text: `❌ Failed to generate embedding for query: ${err instanceof Error ? err.message : String(err)}\n\n` +
          `💡 Try knowledge_search (keyword-based) as a fallback.`,
      }],
      isError: true,
    };
  }

  // Step 2: Call pgvector semantic search RPC
  try {
    const result = await supabaseRpc("semantic_search_ledger", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_project: project || null,
      p_limit: Math.min(limit, 20),
      p_similarity_threshold: similarity_threshold,
    });

    const results = Array.isArray(result) ? result : [];

    if (results.length === 0) {
      return {
        content: [{
          type: "text",
          text: `🔍 No semantically similar sessions found for: "${query}"\n` +
            (project ? `Project: ${project}\n` : "") +
            `Similarity threshold: ${similarity_threshold}\n\n` +
            `Tips:\n` +
            `• Lower the similarity_threshold (e.g., 0.5) for broader results\n` +
            `• Try knowledge_search for keyword-based matching\n` +
            `• Ensure sessions have been saved with embeddings (requires GOOGLE_API_KEY)`,
        }],
        isError: false,
      };
    }

    // Format results with similarity scores
    const formatted = results.map((r: any, i: number) => {
      const score = typeof r.similarity === "number"
        ? `${(r.similarity * 100).toFixed(1)}%`
        : "N/A";
      return `[${i + 1}] ${score} similar — ${r.session_date || "unknown date"}\n` +
        `  Project: ${r.project}\n` +
        `  Summary: ${r.summary}\n` +
        (r.decisions?.length ? `  Decisions: ${r.decisions.join("; ")}\n` : "") +
        (r.files_changed?.length ? `  Files: ${r.files_changed.join(", ")}\n` : "");
    }).join("\n");

    return {
      content: [{
        type: "text",
        text: `🧠 Found ${results.length} semantically similar sessions:\n\n${formatted}`,
      }],
      isError: false,
    };
  } catch (err) {
    // REVIEWER NOTE: If pgvector isn't enabled, the RPC will fail.
    // Provide a clear error message guiding the user to enable it.
    const errorMsg = err instanceof Error ? err.message : String(err);
    if (errorMsg.includes("vector") || errorMsg.includes("does not exist")) {
      return {
        content: [{
          type: "text",
          text: `❌ Semantic search is not available: pgvector extension may not be enabled.\n\n` +
            `To fix: Go to Supabase Dashboard → Database → Extensions → enable "vector"\n` +
            `Then run migration 018_semantic_search.sql\n\n` +
            `💡 Use knowledge_search (keyword-based) as an alternative.`,
        }],
        isError: true,
      };
    }
    throw err;
  }
}
