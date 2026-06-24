/**
 * Image Captioner (v4.5)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Fire-and-forget background pipeline that auto-captions images saved via
 *   `session_save_image`. Connects the VLM adapter → handoff visual_memory →
 *   session ledger → embedding backfill so images become semantically
 *   searchable without any changes to the tool surface area.
 *
 * PIPELINE (all async, never blocks the MCP response):
 *   1. Read vault file → base64
 *   2. Size check (Anthropic: 5MB hard cap; all others: 20MB soft cap)
 *   3. getLLMProvider().generateImageDescription(base64, mimeType, context)
 *   4. storage.updateImageCaption(project, imageId, caption)   — patches handoff
 *   5. storage.saveLedger(...)                                 — makes caption searchable
 *   6. backfillEmbeddingsAsync(project)                        — vector-indexes caption
 *
 * DESIGN DECISIONS:
 *   - `generateImageDescription` is optional on LLMProvider. If the active
 *     provider doesn't support VLM (e.g. a text-only Ollama model), captioning
 *     is skipped gracefully with a single log line.
 *   - Errors are caught and logged; they never propagate. `session_save_image`
 *     already returned successfully when this runs.
 *   - The Anthropic 5MB limit is checked before calling the API. Gemini and
 *     OpenAI accept up to ~20MB.
 *   - The ledger entry embeds image ID and path in the `summary` string because
 *     the ledger schema has no generic metadata column.
 */

import * as fs from "fs";
import * as nodePath from "path";
import { getLLMProvider } from "./llm/factory.js";
import { getStorage } from "../storage/index.js";
import { debugLog, sanitizeForLog } from "./logger.js";
import { PRISM_USER_ID } from "../config.js";
import { getTracer } from "./telemetry.js";
import { SpanStatusCode, context as otelContext, trace } from "@opentelemetry/api";

// ─── Size Caps ────────────────────────────────────────────────────────────────

/** Anthropic Messages API rejects base64 image payloads > 5MB */
const ANTHROPIC_MAX_BYTES = 5 * 1024 * 1024;

/** Gemini / OpenAI accept larger images; 20MB is a conservative safe cap */
const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;

// ─── MIME Type Detection ──────────────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif":  "image/gif",
  ".svg":  "image/svg+xml",
};

function getMimeType(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase();
  return EXT_TO_MIME[ext] ?? "image/png";
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fire-and-forget wrapper. Call this from `session_save_image` after the
 * file is in the vault and the handoff has been saved. Errors are swallowed.
 *
 * @param project     Project identifier
 * @param imageId     Short UUID assigned by session_save_image (e.g. "a3f1b2c9")
 * @param vaultPath   Absolute path to the copied file in ~/.prism-mcp/media/
 * @param userContext User-provided description (passed as hint to the VLM)
 */
export function fireCaptionAsync(
  project: string,
  imageId: string,
  vaultPath: string,
  userContext: string,
): void {
  // ── v4.6.0: OTel worker span ──────────────────────────────────────────────
  // We start the span here (not inside captionImageAsync) so it runs within
  // the active OTel context that was propagated from the mcp.call_tool root
  // span in server.ts. AsyncLocalStorage carries the context across the
  // async boundary, making this a child of session_save_image in Jaeger.
  //
  // The parent (mcp.call_tool) typically ends at ~50ms when the MCP response
  // is sent. This worker span continues until captioning completes (2–5s).
  // In Jaeger, you will see the parent end first, then its child outlive it —
  // this is the correct, expected representation of fire-and-forget async work.
  const span = getTracer().startSpan("worker.vlm_caption", {
    attributes: {
      "worker.image_id": imageId,
      "worker.project":  project,
    },
  });

  // context.with() propagates the OTel span into the async chain so any further
  // nested spans (e.g. llm.generate_image_description inside TracingLLMProvider)
  // are correctly parented as grandchildren of mcp.call_tool.
  otelContext.with(trace.setSpan(otelContext.active(), span), () => {
    captionImageAsync(project, imageId, vaultPath, userContext)
      .then(() => {
        span.setStatus({ code: SpanStatusCode.OK });
      })
      .catch(err => {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        console.error(`[ImageCaptioner] Failed for [${sanitizeForLog(imageId)}]: ${sanitizeForLog(err instanceof Error ? err.message : String(err))}`);
      })
      .finally(() => {
        // Always end the span — even on VLM failure — to flush the BatchSpanProcessor.
        span.end();
      });
  });
}

// ─── Core Pipeline ────────────────────────────────────────────────────────────

async function captionImageAsync(
  project: string,
  imageId: string,
  vaultPath: string,
  userContext: string,
): Promise<void> {

  // ── Step 1: Resolve provider ─────────────────────────────────────────────
  const llm = getLLMProvider();

  if (!llm.generateImageDescription) {
    debugLog(
      `[ImageCaptioner] Active LLM provider does not support VLM — ` +
      `captioning skipped for [${imageId}]. ` +
      `Switch to Gemini, OpenAI (gpt-4o-mini+), or Anthropic to enable.`
    );
    return;
  }

  // ── Step 2: Read file + size check ───────────────────────────────────────
  if (!fs.existsSync(vaultPath)) {
    debugLog(`[ImageCaptioner] Vault file not found: ${vaultPath}`);
    return;
  }

  const fileBuffer = fs.readFileSync(vaultPath);
  const fileSizeBytes = fileBuffer.length;
  const mimeType = getMimeType(vaultPath);

  // Detect active text provider to apply the correct size cap.
  // We import getSettingSync lazily to avoid circular dependency issues.
  const { getSettingSync } = await import("../storage/configStorage.js");
  const textProvider = getSettingSync("text_provider", "gemini");
  const maxBytes = textProvider === "anthropic" ? ANTHROPIC_MAX_BYTES : DEFAULT_MAX_BYTES;

  if (fileSizeBytes > maxBytes) {
    const limitMB = (maxBytes / 1024 / 1024).toFixed(0);
    const actualMB = (fileSizeBytes / 1024 / 1024).toFixed(1);
    console.warn(
      `[ImageCaptioner] Image [${sanitizeForLog(imageId)}] is ${sanitizeForLog(actualMB)}MB, exceeding ` +
      `the ${sanitizeForLog(textProvider)} VLM limit (${limitMB}MB). Captioning skipped. ` +
      (textProvider === "anthropic"
        ? "Switch Embedding Provider to Gemini/OpenAI to caption larger images."
        : "Consider resizing the image.")
    );
    return;
  }

  const imageBase64 = fileBuffer.toString("base64");

  // ── Step 3: Generate caption via VLM ────────────────────────────────────
  debugLog(`[ImageCaptioner] Captioning [${imageId}] via ${textProvider}…`);

  const caption = await llm.generateImageDescription(imageBase64, mimeType, userContext);

  if (!caption || caption.trim().length === 0) {
    debugLog(`[ImageCaptioner] Empty caption returned for [${imageId}] — skipping storage.`);
    return;
  }

  debugLog(`[ImageCaptioner] Caption generated for [${imageId}]: "${caption.slice(0, 80)}…"`);

  // ── Step 3b: OCR (optional, second VLM call) ────────────────────────────
  // Caption answers "what's the image about"; OCR answers "what does it
  // literally say". Persisted separately so users can search whiteboards /
  // handwritten notes / document screenshots by their actual contents,
  // not just the high-level caption. Best-effort — OCR failure NEVER
  // sinks the caption pipeline.
  let ocrText = "";
  if (typeof llm.extractImageText === "function") {
    try {
      ocrText = await llm.extractImageText(imageBase64, mimeType);
      if (ocrText) {
        debugLog(
          `[ImageCaptioner] OCR extracted ${ocrText.length} chars for [${imageId}]: ` +
          `"${ocrText.slice(0, 60).replace(/\n/g, ' ')}…"`,
        );
      } else {
        debugLog(`[ImageCaptioner] OCR returned no text for [${imageId}].`);
      }
    } catch (ocrErr) {
      // Don't poison the caption pipeline. The caption already succeeded;
      // OCR is additive value. Surface as warn (not error) so it's grep-able
      // but doesn't trip alerting on transient VLM blips.
      console.warn(
        `[ImageCaptioner] OCR failed for [${sanitizeForLog(imageId)}] (non-fatal): ` +
        `${sanitizeForLog(ocrErr instanceof Error ? ocrErr.message : String(ocrErr))}`,
      );
    }
  }

  // ── Step 4: Patch handoff visual_memory entry ─────────────────────────
  await updateHandoffCaption(project, imageId, caption, vaultPath, ocrText);

  // ── Step 5: Persist as ledger entry (makes caption semantically searchable)
  // NOTE: The ledger schema has no generic metadata column, so we embed the
  // image context directly in the summary string for LLM-readable references.
  // OCR text (when present) is appended so semantic search hits on either
  // the caption ("diagram of the auth flow") or the literal text in the
  // image ("OAuth2 PKCE handler"). Keyword tag `image_ocr` lets callers
  // filter for entries that have OCR content specifically.
  const storage = await getStorage();
  const summaryParts: string[] = [
    `[Visual Memory: ${imageId}]`,
    `Path: ${vaultPath}`,
    `User description: ${userContext}`,
    `VLM Caption: ${caption}`,
  ];
  const keywords = [`image:${imageId}`, "visual_memory", "image_caption"];
  if (ocrText) {
    summaryParts.push(`OCR Text:\n${ocrText}`);
    keywords.push("image_ocr");
  }
  await storage.saveLedger({
    project,
    conversation_id: "vlm-captioner",
    user_id: PRISM_USER_ID,
    event_type: "learning",
    summary: summaryParts.join("\n"),
    keywords,
  });

  // ── Step 6: Backfill embeddings (makes caption findable via vector search)
  // ── Step 6: Embed the caption inline ────────────────────────────────
  // We embed the caption directly here rather than calling backfillEmbeddingsHandler
  // to avoid a circular import (imageCaptioner ↔ sessionMemoryHandlers).
  // We already have getLLMProvider() in scope, so the embed cost is near-zero.
  try {
    const embedText = ocrText
      ? `[Visual Memory: ${imageId}] Description: ${userContext}. Caption: ${caption}. OCR: ${ocrText}`
      : `[Visual Memory: ${imageId}] Description: ${userContext}. Caption: ${caption}`;
    const embedding = await llm.generateEmbedding(embedText);

    // Find the ledger entry we just saved and patch its embedding
    const allEntries = await storage.getLedgerEntries({
      project,
      conversation_id: "vlm-captioner",
    }) as Array<{ id?: string; created_at?: string }>;

    // Sort descending and take the most recent (the one we just inserted)
    const latest = allEntries.sort((a, b) =>
      new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime()
    )[0];

    if (latest?.id) {
      await storage.patchLedger(latest.id, { embedding: JSON.stringify(embedding) });
      debugLog(`[ImageCaptioner] Caption embedded for ledger entry [${latest.id}].`);
    }
  } catch (embedErr) {
    // Non-fatal: caption still persists in the ledger as plain text and
    // will be picked up by the next project-wide backfill sweep.
    debugLog(`[ImageCaptioner] Embedding failed (will surface in next backfill): ${embedErr}`);
  }

  debugLog(`[ImageCaptioner] Pipeline complete for [${imageId}].`);
}

// ─── Handoff Patch ────────────────────────────────────────────────────────────

/**
 * Adds `caption` to the matching visual_memory entry inside the handoff JSON.
 * Uses a read-modify-write because visual_memory is embedded in the handoff
 * metadata JSON blob — there's no dedicated column to patch atomically.
 *
 * On version conflict (OCC), retries once with a fresh read. If both fail,
 * logs and returns (the ledger entry still exists as a search fallback).
 */
async function updateHandoffCaption(
  project: string,
  imageId: string,
  caption: string,
  vaultPath: string,
  ocrText: string = "",
): Promise<void> {
  const storage = await getStorage();

  for (let attempt = 1; attempt <= 2; attempt++) {
    const context = await storage.loadContext(project, "quick", PRISM_USER_ID);
    if (!context) {
      debugLog(`[ImageCaptioner] No handoff context for "${project}" — skipping caption patch.`);
      return;
    }

    const ctx = context as any;
    const meta = ctx.metadata || {};
    const vm: any[] = meta.visual_memory || [];
    const entry = vm.find((e: any) => e.id === imageId);

    if (!entry) {
      debugLog(`[ImageCaptioner] Image [${imageId}] not found in visual_memory — skipping patch.`);
      return;
    }

    // Mutate the entry in-memory, then save back. Only set ocr_text when
    // it's non-empty — otherwise the empty string would shadow a previous
    // OCR pass (e.g. if a user re-captioned the same image after a model
    // change).
    entry.caption = caption;
    entry.caption_path = vaultPath;
    entry.caption_at = new Date().toISOString();
    if (ocrText) {
      entry.ocr_text = ocrText;
      entry.ocr_at = new Date().toISOString();
    }

    const handoffUpdate = {
      project,
      user_id: PRISM_USER_ID,
      metadata: meta,
      last_summary:       ctx.last_summary ?? null,
      pending_todo:       ctx.pending_todo ?? null,
      active_decisions:   ctx.active_decisions ?? null,
      keywords:           ctx.keywords ?? null,
      key_context:        ctx.key_context ?? null,
      active_branch:      ctx.active_branch ?? null,
    };

    const result = await storage.saveHandoff(handoffUpdate, ctx.version);

    if (result.status !== "conflict") {
      debugLog(`[ImageCaptioner] Handoff patched with caption for [${imageId}] (attempt ${attempt}).`);
      return;
    }

    // OCC conflict — retry once with fresh version
    debugLog(`[ImageCaptioner] OCC conflict patching [${imageId}], attempt ${attempt}. Retrying…`);
  }

  console.warn(
    `[ImageCaptioner] Could not patch handoff for [${sanitizeForLog(imageId)}] after 2 attempts. ` +
    `Caption is still saved in the ledger and will surface via semantic search.`
  );
}
