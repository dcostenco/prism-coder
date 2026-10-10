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
import { ANALYTICS_DATE_PATTERN } from "../dashboard/readMessages.js";

const AnalyticsCountSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const UTC_DAY_MS = 24 * 60 * 60 * 1000;
export const ProjectAnalyticsSchema = z.object({
    totalEntries: AnalyticsCountSchema,
    totalRollups: AnalyticsCountSchema,
    rollupSavings: AnalyticsCountSchema,
    avgSummaryLength: z.number().nonnegative().finite(),
    sessionsByDay: z.array(z.object({
      date: z.string().regex(ANALYTICS_DATE_PATTERN), count: AnalyticsCountSchema,
    })).length(14),
  }).refine(value => value.totalRollups <= value.totalEntries
    && value.sessionsByDay.reduce((sum, day) => sum + day.count, 0) <= value.totalEntries - value.totalRollups
    && value.sessionsByDay.every((day, index, days) => {
      const time = Date.parse(day.date);
      return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day.date
        && (index === 0 || time - Date.parse(days[index - 1].date) === UTC_DAY_MS);
    }));
export const ProjectAnalyticsResponseSchema = z.object({
  status: z.literal('success'),
  project: z.string().min(1).max(100),
  analytics: ProjectAnalyticsSchema,
});

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
  /** How the portal matched. Optional so an older portal deployment that
   *  predates the ranked search RPC still validates. When present and
   *  'relaxed', callers MUST NOT present the rows as exact hits. */
  match_mode: z.enum(["strict", "relaxed", "unfiltered", "none"]).optional(),
});
export type KnowledgeSearchResponse = z.infer<typeof KnowledgeSearchResponseSchema>;
