/**
 * session_route_prompt — mid-session skill routing.
 *
 * THE GAP THIS CLOSES (2026-08-12). Skill routing runs at session_bootstrap,
 * which by instruction happens on the first turn. Long sessions are where the
 * work actually is: an eight-hour session was asked six times for a UI/UX
 * review, and even after the routing table learned those phrasings, nothing
 * could deliver the skill — the ask arrived at turn ~530 and routing had run
 * at turn 1. The agent substituted source-grep assertions for rendered
 * evidence and shipped six reactive patches.
 *
 * WHY THIS IS A TOOL AND NOT AUTOMATIC. An MCP server never sees the user's
 * prompt; the protocol only carries what a tool call carries. Truly automatic
 * per-prompt injection needs a HOST hook, which the operator has ruled out.
 * This is the honest approximation: the model passes the prompt, we match it
 * on-device and return only what is genuinely new.
 *
 * CHEAP BY CONSTRUCTION, because an instruction to call it every turn is only
 * affordable if the common answer is nearly free:
 *   - the overwhelmingly common result is "no new skills", a one-line reply;
 *   - `loaded` lets the caller declare what it already has, so a skill is
 *     never re-injected and a repeated call costs nothing;
 *   - bodies are capped, so a pathological match cannot dump the budget.
 *
 * The prompt is matched ON DEVICE against the same table and the same scoped
 * frontmatter triggers session_bootstrap uses. It is never transmitted.
 */
import { debugLog } from "../utils/logger.js";

/** Never return more than this many bodies in one call. */
export const MAX_ROUTED_SKILLS = 3;
/** Hard ceiling on returned characters, so one call cannot flood the window.
 *  Sized from measurement, not taste: the UI-review bundle
 *  (visual-screenshot-verification + playwright-screenshot-discipline +
 *  verified-shipping) is ~24.5k, and at 24k the third — the EVIDENCE-CLAIM
 *  rules, arguably the one that matters most at the merge moment — was
 *  reported "matched, not injected" on the first UI turn of a live session.
 *  A cap that trims the bundle it was built for is mis-sized. */
export const MAX_ROUTED_CHARS = 30_000;

export interface PromptRouteDeps {
  /** On-device matcher — same one session_bootstrap uses. */
  resolvePromptSkillNames: (
    prompt: string,
    manifestVersion?: number,
    scopedTriggers?: Record<string, string[]>,
  ) => Promise<string[]>;
  /** Delivered + local frontmatter triggers collected on this machine. */
  collectTriggers: () => Promise<
    { triggers: Record<string, string[]>; localNames: Set<string> } | undefined
  >;
  /** Names this account is entitled to inject. */
  entitledNames: () => Promise<Set<string>>;
  /** Skill body by name; empty string when absent. */
  getBody: (name: string) => Promise<string>;
  /** Routing table version, for stale-cache detection. */
  manifestVersion: () => Promise<number | undefined>;
}

export interface PromptRouteResult {
  /** Newly matched, entitled, not-already-loaded skill names. */
  names: string[];
  /** Human/agent-facing text. Always non-empty. */
  text: string;
  /** Matched but withheld because the caller already had them. */
  alreadyLoaded: string[];
  /** Matched but dropped by the per-call cap. */
  overflow: string[];
}

/**
 * Match a prompt and return ONLY skills the caller does not already have.
 *
 * Pure over its deps so the tests exercise real matching rather than mocks of
 * the thing under test.
 */
export async function routePrompt(
  prompt: string,
  loaded: string[],
  deps: PromptRouteDeps,
): Promise<PromptRouteResult> {
  const trimmed = (prompt || "").trim();
  if (!trimmed) {
    return { names: [], alreadyLoaded: [], overflow: [], text: "No prompt supplied — nothing to route." };
  }

  const scoped = await deps.collectTriggers().catch(() => undefined);
  const version = await deps.manifestVersion().catch(() => undefined);

  let matched: string[] = [];
  try {
    matched = await deps.resolvePromptSkillNames(trimmed, version, scoped?.triggers);
  } catch (error) {
    // Routing must never take down the turn that asked for it.
    debugLog(`[session_route_prompt] match failed: ${error instanceof Error ? error.message : String(error)}`);
    return { names: [], alreadyLoaded: [], overflow: [], text: "No new skills for this prompt." };
  }

  const entitled = await deps.entitledNames().catch(() => new Set<string>());
  // A local skill is on disk and not in the delivery manifest, so entitlement
  // cannot see it — the same bypass session_bootstrap applies.
  const permitted = matched.filter((n) => entitled.has(n) || scoped?.localNames.has(n));

  const have = new Set(loaded.map((n) => n.trim()).filter(Boolean));
  const alreadyLoaded = permitted.filter((n) => have.has(n));
  const fresh = permitted.filter((n) => !have.has(n));

  if (fresh.length === 0) {
    // The common case, and it must stay one cheap line: an instruction to call
    // this every turn is only reasonable if silence is nearly free.
    return {
      names: [], alreadyLoaded, overflow: [],
      text: "No new skills for this prompt.",
    };
  }

  const selected = fresh.slice(0, MAX_ROUTED_SKILLS);
  const overflow = fresh.slice(MAX_ROUTED_SKILLS);

  const blocks: string[] = [];
  const delivered: string[] = [];
  let budget = MAX_ROUTED_CHARS;
  for (const name of selected) {
    const body = (await deps.getBody(name).catch(() => "")).trim();
    if (!body) {
      // Routed but undeliverable is the exact defect this feature exists to
      // surface. Say so rather than returning a name with nothing behind it.
      blocks.push(`### ${name}\n(no content on this machine — run skill sync)`);
      delivered.push(name);
      continue;
    }
    if (body.length > budget) {
      overflow.push(name);
      continue;
    }
    budget -= body.length;
    blocks.push(`### ${name}\n${body}`);
    delivered.push(name);
  }

  if (delivered.length === 0) {
    return { names: [], alreadyLoaded, overflow, text: "No new skills for this prompt." };
  }

  // Imperative, not a label. A bare list is decorative; nothing else in this
  // path tells the agent these rules bind the work it is about to do.
  const header =
    `**Skills now active for this task:** ${delivered.join(", ")}\n\n` +
    `These apply to the work you are about to do. Read and follow them before proceeding.` +
    (overflow.length > 0 ? `\n\nAlso matched, not injected: ${overflow.join(", ")}.` : "");

  return { names: delivered, alreadyLoaded, overflow, text: `${header}\n\n${blocks.join("\n\n")}` };
}
