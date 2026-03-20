/**
 * Session Memory Handlers (v2.0 — StorageBackend Refactor)
 *
 * ═══════════════════════════════════════════════════════════════════
 * v2.0 CHANGES IN THIS FILE (Step 1: Pure Refactor)
 *
 * BEFORE: All handlers called supabasePost/Get/Rpc/Patch/Delete directly.
 * AFTER:  All handlers call StorageBackend methods via `getStorage()`.
 *
 * This refactor changes ZERO behavior. Every method call maps 1:1 to
 * the same Supabase API call (see src/storage/supabase.ts for mapping).
 *
 * WHY: This enables Step 2 (SQLite local mode) — once SqliteStorage
 * implements the same interface, the handlers work with both backends
 * without any code changes.
 * ═══════════════════════════════════════════════════════════════════
 */

import { getStorage } from "../storage/index.js";
import { toKeywordArray } from "../utils/keywordExtractor.js";
import { generateEmbedding } from "../utils/embeddingApi.js";
import { getCurrentGitState, getGitDrift } from "../utils/git.js";
import { GOOGLE_API_KEY, PRISM_USER_ID } from "../config.js";
import {
  isSessionSaveLedgerArgs,
  isSessionSaveHandoffArgs,
  isSessionLoadContextArgs,
  isKnowledgeSearchArgs,
  isKnowledgeForgetArgs,
  isSessionSearchMemoryArgs,
  isBackfillEmbeddingsArgs,
  isMemoryHistoryArgs,
  isMemoryCheckoutArgs,
} from "./sessionMemoryDefinitions.js";

// ─── v0.4.0: Import server type for resource notifications ───
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { notifyResourceUpdate } from "../server.js";

// ─── Save Ledger Handler ──────────────────────────────────────

/**
 * Appends an immutable session log entry.
 *
 * Think of the ledger as a "commit log" for agent work — once written, entries
 * are never modified. This creates a permanent audit trail of all work done.
 *
 * After saving, generates an embedding vector for the entry via fire-and-forget.
 */
export async function sessionSaveLedgerHandler(args: unknown) {
  if (!isSessionSaveLedgerArgs(args)) {
    throw new Error("Invalid arguments for session_save_ledger");
  }

  const { project, conversation_id, summary, todos, files_changed, decisions } = args;
  const storage = await getStorage();

  console.error(`[session_save_ledger] Saving ledger entry for project="${project}"`);

  // Auto-extract keywords from summary + decisions for knowledge accumulation
  const combinedText = [summary, ...(decisions || [])].join(" ");
  const keywords = toKeywordArray(combinedText);
  console.error(`[session_save_ledger] Extracted ${keywords.length} keywords: ${keywords.slice(0, 5).join(", ")}...`);

  // Save via storage backend
  const result = await storage.saveLedger({
    project,
    conversation_id,
    summary,
    user_id: PRISM_USER_ID,
    todos: todos || [],
    files_changed: files_changed || [],
    decisions: decisions || [],
    keywords,
  });

  // ─── Fire-and-forget embedding generation ───
  if (GOOGLE_API_KEY && result) {
    const embeddingText = [summary, ...(decisions || [])].join("\n");
    const savedEntry = Array.isArray(result) ? result[0] : result;
    const entryId = (savedEntry as any)?.id;

    if (entryId) {
      generateEmbedding(embeddingText)
        .then(async (embedding) => {
          await storage.patchLedger(entryId, {
            embedding: JSON.stringify(embedding),
          });
          console.error(`[session_save_ledger] Embedding saved for entry ${entryId}`);
        })
        .catch((err) => {
          console.error(`[session_save_ledger] Embedding generation failed (non-fatal): ${err.message}`);
        });
    }
  }

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

  const storage = await getStorage();

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

  // Auto-capture Git state for Reality Drift Detection (v2.0 Step 5)
  const gitState = getCurrentGitState();
  const metadata: Record<string, unknown> = {};
  if (gitState.isRepo) {
    metadata.git_branch = gitState.branch;
    metadata.last_commit_sha = gitState.commitSha;
    console.error(
      `[session_save_handoff] Git state captured: branch=${gitState.branch}, sha=${gitState.commitSha?.substring(0, 8)}`
    );
  }

  // Save via storage backend (OCC-aware)
  const data = await storage.saveHandoff(
    {
      project,
      user_id: PRISM_USER_ID,
      last_summary: last_summary ?? null,
      pending_todo: open_todos ?? null,
      active_decisions: null,
      keywords: keywords ?? null,
      key_context: key_context ?? null,
      active_branch: active_branch ?? null,
      metadata,
    },
    expected_version ?? null
  );

  // ─── Handle version conflict ───
  if (data.status === "conflict") {
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
  const newVersion = data.version;

  // ─── TIME MACHINE: Auto-snapshot for time travel (fire-and-forget) ───
  // Every successful save creates a snapshot so the user can revert later.
  // We don't await — this should never block the success response.
  if (data.status === "created" || data.status === "updated") {
    const snapshotEntry = {
      project,
      user_id: PRISM_USER_ID,
      last_summary: last_summary ?? null,
      pending_todo: open_todos ?? null,
      active_decisions: null,
      keywords: keywords ?? null,
      key_context: key_context ?? null,
      active_branch: active_branch ?? null,
      version: newVersion,
    };
    storage.saveHistorySnapshot(snapshotEntry).catch(err =>
      console.error(`[session_save_handoff] History snapshot failed (non-fatal): ${err}`)
    );
  }

  // ─── Trigger resource subscription notification ───
  if (server && (data.status === "created" || data.status === "updated")) {
    try {
      notifyResourceUpdate(project, server);
    } catch (err) {
      console.error(`[session_save_handoff] Resource notification failed (non-fatal): ${err}`);
    }
  }

  return {
    content: [{
      type: "text",
      text: `✅ Handoff ${data.status || "saved"} for project "${project}" ` +
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
 */
export async function sessionLoadContextHandler(args: unknown) {
  if (!isSessionLoadContextArgs(args)) {
    throw new Error("Invalid arguments for session_load_context");
  }

  const { project, level = "standard" } = args;

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

  const storage = await getStorage();
  const data = await storage.loadContext(project, level, PRISM_USER_ID);

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

  const version = (data as any)?.version;
  const versionNote = version
    ? `\n\n🔑 Session version: ${version}. Pass expected_version: ${version} when saving handoff.`
    : "";

  // ─── Reality Drift Detection (v2.0 Step 5) ───
  // Check if the developer changed code since the last handoff save.
  let driftReport = "";
  const meta = (data as any)?.metadata;

  if (meta?.last_commit_sha) {
    const currentGit = getCurrentGitState();

    if (currentGit.isRepo) {
      if (meta.git_branch && currentGit.branch !== meta.git_branch) {
        // Branch switch — inform but don't panic
        driftReport = `\n\n⚠️ **CONTEXT SHIFT:** This memory was saved on branch ` +
          `\`${meta.git_branch}\`, but you are currently on branch \`${currentGit.branch}\`. ` +
          `Code may have diverged — review carefully before making changes.`;
        console.error(
          `[session_load_context] Context shift detected: ${meta.git_branch} → ${currentGit.branch}`
        );
      } else if (currentGit.commitSha !== meta.last_commit_sha) {
        // Same branch, different commits — calculate drift
        const changes = getGitDrift(meta.last_commit_sha as string);
        if (changes) {
          driftReport = `\n\n⚠️ **REALITY DRIFT DETECTED**\n` +
            `Since this memory was saved (commit ${(meta.last_commit_sha as string).substring(0, 8)}), ` +
            `the following files were modified outside of agent sessions:\n\`\`\`\n${changes}\n\`\`\`\n` +
            `Please review these files if they overlap with your current task.`;
          console.error(
            `[session_load_context] Reality drift detected! ${changes.split("\n").length} files changed`
          );
        }
      } else {
        console.error(`[session_load_context] No drift — repo matches saved state`);
      }
    }
  }

  return {
    content: [{
      type: "text",
      text: `📋 Session context for "${project}" (${level}):\n\n${JSON.stringify(data, null, 2)}${driftReport}${versionNote}`,
    }],
    isError: false,
  };
}

// ─── Knowledge Search Handler ─────────────────────────────────

/**
 * Searches accumulated knowledge across all past sessions.
 */
export async function knowledgeSearchHandler(args: unknown) {
  if (!isKnowledgeSearchArgs(args)) {
    throw new Error("Invalid arguments for knowledge_search");
  }

  const { project, query, category, limit = 10 } = args;

  console.error(`[knowledge_search] Searching: project=${project || "all"}, query="${query || ""}", category=${category || "any"}, limit=${limit}`);

  const searchKeywords = query ? toKeywordArray(query) : [];
  const storage = await getStorage();

  const data = await storage.searchKnowledge({
    project: project || null,
    keywords: searchKeywords,
    category: category || null,
    queryText: query || null,
    limit: Math.min(limit, 50),
    userId: PRISM_USER_ID,
  });

  if (!data) {
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

  const storage = await getStorage();

  const ledgerParams: Record<string, string> = {};
  ledgerParams.user_id = `eq.${PRISM_USER_ID}`;
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
    const entries = await storage.getLedgerEntries(selectParams);
    ledgerCount = entries.length;
  } else {
    const result = await storage.deleteLedger(ledgerParams);
    ledgerCount = result.length;

    if (clear_handoff && project) {
      await storage.deleteHandoff(project, PRISM_USER_ID);
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

// ─── Semantic Search Handler ──────────────────────────────────

/**
 * Searches session history semantically using embeddings.
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

  // Step 2: Search via storage backend
  try {
    const storage = await getStorage();
    const results = await storage.searchMemory({
      queryEmbedding: JSON.stringify(queryEmbedding),
      project: project || null,
      limit: Math.min(limit, 20),
      similarityThreshold: similarity_threshold,
      userId: PRISM_USER_ID,
    });

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

// ─── Backfill Embeddings Handler ──────────────────────────────

/**
 * Repair ledger entries with missing embeddings.
 */
export async function backfillEmbeddingsHandler(args: unknown) {
  if (!isBackfillEmbeddingsArgs(args)) {
    throw new Error("Invalid arguments for session_backfill_embeddings");
  }

  if (!GOOGLE_API_KEY) {
    return {
      content: [{
        type: "text",
        text: "❌ Cannot backfill: GOOGLE_API_KEY is not configured.",
      }],
      isError: true,
    };
  }

  const { project, limit = 20, dry_run = false } = args;
  const safeLimit = Math.min(limit, 50);

  console.error(
    `[backfill_embeddings] ${dry_run ? "DRY RUN: " : ""}` +
    `project=${project || "all"}, limit=${safeLimit}`
  );

  const storage = await getStorage();

  // Find entries missing embeddings
  const params: Record<string, string> = {
    "embedding": "is.null",
    "archived_at": "is.null",
    user_id: `eq.${PRISM_USER_ID}`,
    order: "created_at.desc",
    limit: String(safeLimit),
    select: "id,summary,decisions,project",
  };
  if (project) {
    params.project = `eq.${project}`;
  }

  const entries = await storage.getLedgerEntries(params);

  if (entries.length === 0) {
    return {
      content: [{
        type: "text",
        text: "✅ No entries with missing embeddings found. All ledger entries have embeddings.",
      }],
      isError: false,
    };
  }

  // Dry run: just report count
  if (dry_run) {
    const projects = [...new Set(entries.map((e: any) => e.project))];
    return {
      content: [{
        type: "text",
        text: `🔍 Found ${entries.length} entries with missing embeddings:\n` +
          `Projects: ${projects.join(", ")}\n\n` +
          `Run without dry_run to generate embeddings.`,
      }],
      isError: false,
    };
  }

  // Generate embeddings for each entry
  let repaired = 0;
  let failed = 0;

  for (const entry of entries) {
    try {
      const e = entry as any;
      const textToEmbed = [
        e.summary || "",
        ...(e.decisions || []),
      ].filter(Boolean).join(" | ");

      if (!textToEmbed.trim()) {
        console.error(`[backfill] Skipping entry ${e.id}: no text content`);
        failed++;
        continue;
      }

      const embedding = await generateEmbedding(textToEmbed);

      await storage.patchLedger(e.id, {
        embedding: JSON.stringify(embedding),
      });

      repaired++;
      console.error(`[backfill] ✅ Repaired ${e.id} (${e.project})`);
    } catch (err) {
      failed++;
      console.error(`[backfill] ❌ Failed ${(entry as any).id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    content: [{
      type: "text",
      text: `🔧 Embedding backfill complete:\n\n` +
        `• Repaired: ${repaired}\n` +
        `• Failed: ${failed}\n` +
        `• Total scanned: ${entries.length}\n\n` +
        (failed > 0
          ? `⚠️ ${failed} entries could not be repaired. Check server logs for details.`
          : `All entries now have embeddings for semantic search.`),
    }],
    isError: false,
  };
}

// ─── Memory History Handler (v2.0 — Time Travel) ─────────────

/**
 * Lists the version timeline for a project.
 * The agent should call this BEFORE memory_checkout to see available versions.
 */
export async function memoryHistoryHandler(args: unknown) {
  if (!isMemoryHistoryArgs(args)) {
    throw new Error("Invalid arguments for memory_history");
  }

  const { project, limit = 10 } = args;
  const storage = await getStorage();

  console.error(`[memory_history] Fetching history for project="${project}" (limit=${limit})`);

  const history = await storage.getHistory(project, PRISM_USER_ID, Math.min(limit, 50));

  if (history.length === 0) {
    return {
      content: [{
        type: "text",
        text: `No memory history found for project "${project}".\n\n` +
          `History is automatically created each time you save a handoff.\n` +
          `Use session_save_handoff first, then check history again.`,
      }],
      isError: false,
    };
  }

  // Format timeline for LLM readability
  const timeline = history.map(h => {
    const summary = h.snapshot.last_summary || "(no summary)";
    const todos = h.snapshot.pending_todo?.length || 0;
    const branch = h.branch !== "main" ? ` [branch: ${h.branch}]` : "";
    return `  v${h.version} [${h.created_at}]${branch}\n    Summary: ${summary}\n    TODOs: ${todos} items`;
  }).join("\n\n");

  return {
    content: [{
      type: "text",
      text: `🕰️ Memory History for "${project}" (${history.length} snapshots):\n\n${timeline}\n\n` +
        `To revert to any version, use: memory_checkout with project="${project}" and target_version=<version number>.`,
    }],
    isError: false,
  };
}

// ─── Memory Checkout Handler (v2.0 — Time Travel) ────────────

/**
 * Reverts a project's memory to a historical version — like Git revert.
 * The version number moves FORWARD (no data is lost), and the revert itself
 * is recorded in history so you can undo an undo.
 */
export async function memoryCheckoutHandler(args: unknown) {
  if (!isMemoryCheckoutArgs(args)) {
    throw new Error("Invalid arguments for memory_checkout");
  }

  const { project, target_version } = args;
  const storage = await getStorage();

  console.error(
    `[memory_checkout] Reverting project="${project}" to version ${target_version}`
  );

  // 1. Find the target snapshot
  const history = await storage.getHistory(project, PRISM_USER_ID, 50);
  const targetState = history.find(h => h.version === target_version);

  if (!targetState) {
    const available = history.map(h => `v${h.version}`).join(", ") || "none";
    return {
      content: [{
        type: "text",
        text: `❌ Version ${target_version} not found in history for "${project}".\n\n` +
          `Available versions: ${available}\n\n` +
          `Use memory_history to see the full timeline.`,
      }],
      isError: true,
    };
  }

  // 2. Get current state for OCC
  const currentContext = await storage.loadContext(project, "quick", PRISM_USER_ID);
  const currentVersion = currentContext ? (currentContext as Record<string, unknown>).version as number : null;

  // 3. Build the revert handoff — copy the historical snapshot but mark it as a revert
  const revertHandoff = {
    ...targetState.snapshot,
    project,
    user_id: PRISM_USER_ID,
    last_summary: `[REVERTED TO v${target_version}] ${targetState.snapshot.last_summary || ""}`,
  };

  // 4. Save with OCC — pass current version to prevent race conditions
  const result = await storage.saveHandoff(revertHandoff, currentVersion);

  if (result.status === "conflict") {
    return {
      content: [{
        type: "text",
        text: `⚠️ Version conflict during checkout! Another session updated the project.\n\n` +
          `Current version: ${result.current_version}\n` +
          `Call session_load_context to see the latest state, then try again.`,
      }],
      isError: true,
    };
  }

  // 5. Save the revert itself to history (so you can undo the undo)
  const revertSnapshotEntry = {
    ...revertHandoff,
    version: result.version,
  };
  await storage.saveHistorySnapshot(revertSnapshotEntry).catch(err =>
    console.error(`[memory_checkout] History snapshot of revert failed (non-fatal): ${err}`)
  );

  const newVersion = result.version;

  return {
    content: [{
      type: "text",
      text: `🕰️ Time travel successful!\n\n` +
        `• Project: "${project}"\n` +
        `• Reverted from: v${currentVersion || "?"} → restored v${target_version}\n` +
        `• New current version: v${newVersion}\n` +
        `• Summary: ${targetState.snapshot.last_summary || "(no summary)"}\n\n` +
        `The project's memory has been restored to the state from ${targetState.created_at}.\n` +
        `This revert is also saved in history, so you can undo it with another memory_checkout.\n\n` +
        `🔑 Remember: pass expected_version: ${newVersion} on your next save.`,
    }],
    isError: false,
  };
}
