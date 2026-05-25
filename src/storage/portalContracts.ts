/**
 * Portal wire contracts — Zod schemas for every action payload that
 * prism-mcp-server sends to or receives from the Synalux portal.
 *
 * WHY THIS FILE EXISTS:
 *   The 2026-05-24 incident: `knowledge_search` sent `queryText` but
 *   the portal expected `query`. Both sides had passing unit tests
 *   because each test was written to match its own implementation,
 *   not the shared wire contract. This file is the single source of
 *   truth for that contract. A field rename here is a compile error
 *   in synalux.ts AND a schema-validation failure in route.ts —
 *   forcing both sides to update together.
 *
 * ADDING A NEW ACTION:
 *   1. Add RequestSchema + ResponseSchema below.
 *   2. Import and validate in synalux.ts (outgoing) + route.ts (incoming).
 *   3. Add a schema-contract test in synalux-portal-contract.test.ts.
 */

import { z } from "zod";

// ─── knowledge_search ────────────────────────────────────────────

export const KnowledgeSearchRequestSchema = z.object({
  action: z.literal("knowledge_search"),
  project: z.string().optional(),
  keywords: z.array(z.string()).default([]),
  category: z.string().optional(),
  /** Free-text filter applied via Postgres textSearch on summary.
   *  WIRE NAME: `query` — NOT `queryText` (incident 2026-05-24). */
  query: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(10),
  role: z.string().optional(),
  /** 'user' returns only the caller's entries; 'workspace' broadens to all
   *  workspace_members rows after server-side membership verification.
   *  Optional with no default — the portal applies its own default (currently
   *  'user') so this schema doesn't impose a policy on the wire format. */
  scope: z.enum(["user", "workspace"]).optional(),
});
export type KnowledgeSearchRequest = z.infer<typeof KnowledgeSearchRequestSchema>;

export const KnowledgeSearchResponseSchema = z.object({
  status: z.literal("success"),
  action: z.literal("knowledge_search"),
  count: z.number(),
  results: z.array(z.record(z.string(), z.unknown())),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponseSchema>;
