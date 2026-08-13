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
/** What a HOST will actually hand the model inline from a hook. Claude Code
 *  hard-caps hook additionalContext at 10,000 chars — over that, the full text
 *  goes to a file and the model gets a 2KB preview (three live instances
 *  observed 2026-08-13: 13.2/18/18.9KB injections, all offloaded). Codex
 *  truncates at ~2,500 tokens by default. MAX_ROUTED_CHARS bounds the PAYLOAD;
 *  this bounds what may ride INLINE through a hook — anything larger must be
 *  our own offload file with an imperative pointer, not the host's silent one. */
export const HOOK_INLINE_SAFE_CHARS = 9_800;

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
  /** Imperative header, kept separate so hook callers can re-budget inline text. */
  header?: string;
  /** One `### name\nbody` block per delivered skill, in priority order. */
  blocks?: string[];
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
  //
  // The overflow list is CAPPED: the header feeds reshapeForInlineBudget's
  // base text, whose budget guarantee (and the pointer's first-2KB placement)
  // holds only if the header is bounded. An unbounded list of matched names
  // was measured at 12,950 chars for a 400-skill match — over the host cap
  // before a single body was added.
  const overflowShown = overflow.slice(0, 8);
  const overflowNote =
    overflow.length > 0
      ? `\n\nAlso matched, not injected: ${overflowShown.join(", ")}${overflow.length > overflowShown.length ? ` (+${overflow.length - overflowShown.length} more)` : ""}.`
      : "";
  const header =
    `**Skills now active for this task:** ${delivered.join(", ")}\n\n` +
    `These apply to the work you are about to do. Read and follow them before proceeding.` +
    overflowNote;

  return { names: delivered, alreadyLoaded, overflow, header, blocks, text: `${header}\n\n${blocks.join("\n\n")}` };
}

export interface InlineShaped {
  /** What the hook should emit as additionalContext. */
  text: string;
  /** True when the full payload did not fit inline. */
  offloaded: boolean;
  /** Where the full payload was written, when the writer succeeded. */
  offloadPath?: string;
}

/**
 * Fit a routed payload under a host's inline hook cap.
 *
 * The host's own overflow handling is the failure mode, not the fallback:
 * Claude Code silently swaps anything over 10k chars for a 2KB preview, and
 * nothing tells the model to go read the rest. So when the payload is over
 * budget WE offload it — to a file we name, behind an imperative that sits in
 * the first 2KB where every host preview window can still deliver it — and
 * inline as many whole priority bodies as fit.
 *
 * Pure over its writer so tests exercise the real budgeting.
 */
export function reshapeForInlineBudget(
  result: PromptRouteResult,
  budgetChars: number,
  writeOffload: (fullText: string) => string | undefined,
): InlineShaped {
  const full = result.text;
  if (full.length <= budgetChars || !result.header || !result.blocks || result.blocks.length === 0) {
    return { text: full, offloaded: false };
  }

  let offloadPath: string | undefined;
  try {
    offloadPath = writeOffload(full);
  } catch {
    offloadPath = undefined;
  }

  const pieces: string[] = [result.header];
  if (offloadPath) {
    pieces.push(
      `**Host hook context is size-capped — the full text of all ${result.names.length} skill(s) is saved at: ${offloadPath}**\n` +
        `**Read that file now and follow those skills before proceeding. If the host shows "Full output saved to" with another path above, Read that file instead.**`,
    );
  }

  // Reserve room for the loud-failure footer when there is no offload file to
  // point at — a silently dropped skill is the defect this feature exists for.
  // COMPUTED from the worst-case footer (every delivered name skipped), not a
  // guessed constant: a fixed 300 was measured overrunning the budget by 99
  // chars with two long-named skills.
  const footerFor = (names: string[]) =>
    `\n\n**Not inlined (host size cap, offload unavailable): ${names.join(", ")} — fetch each with knowledge_search and follow it before proceeding.**`;
  const reserve = offloadPath ? 0 : footerFor(result.names).length;
  let inline = pieces.join("\n\n");
  const skipped: string[] = [];
  for (let i = 0; i < result.blocks.length; i++) {
    const candidate = `${inline}\n\n${result.blocks[i]}`;
    if (candidate.length <= budgetChars - reserve) {
      inline = candidate;
    } else {
      skipped.push(result.names[i] ?? `skill ${i + 1}`);
    }
  }
  if (!offloadPath && skipped.length > 0) {
    inline += footerFor(skipped);
  }
  // Belt over the construction: the budget is a HOST hard cap, and "the data
  // stayed small" is not an invariant. If a pathological header ever pushes
  // the base past it, keep the first budgetChars — the names line and pointer
  // sit at the front by construction, so what survives is the recoverable part.
  if (inline.length > budgetChars) {
    inline = inline.slice(0, budgetChars);
  }
  return { text: inline, offloaded: true, offloadPath };
}
