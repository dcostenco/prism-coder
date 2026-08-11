/**
 * Skill-delivery budgeting — makes the skill block honor the caller's
 * max_tokens budget instead of inlining every resolved skill.
 *
 * Why: paid-tier resolution returns 30+ skills (~114KB measured). Unbudgeted
 * inlining exceeds host tool-result caps, and hosts divert the WHOLE response
 * to a file — the agent receives none of it. A budgeted block that fits is
 * strictly more context than an unbudgeted one that gets diverted.
 *
 * Policy (in fill order):
 *   1. protected skills — ALWAYS inlined in full, even over budget. This is
 *      the documented floor (2026-06-13 incident: silent truncation stripped
 *      the agent's core behavioral rules; "protected" exists to prevent that).
 *   2. prompt-category skills — they matched THIS prompt's keywords; they are
 *      usually the reason the caller passed `prompt` at all.
 *   3. everything else (unprotected universal, project, role) by ascending
 *      priority — while budget remains.
 * Skills that do not fit are NEVER silently dropped: they are listed in an
 * overflow manifest so the agent can read them on demand or re-load with a
 * higher max_tokens.
 */

export interface SkillEntryForBudget {
    name: string;
    content: string;
    protected: boolean;
    category: "universal" | "project" | "prompt" | "role" | "offline";
    priority: number;
}

export interface BudgetedSkillBlock {
    block: string;
    inlined: string[];
    overflow: string[];
}

function fillOrder(a: SkillEntryForBudget, b: SkillEntryForBudget): number {
    const rank = (e: SkillEntryForBudget) =>
        e.protected ? 0 : e.category === "prompt" ? 1 : e.category === "role" ? 2 : 3;
    return rank(a) - rank(b) || a.priority - b.priority;
}

function render(e: SkillEntryForBudget): string {
    const label = e.category === "role" ? "ROLE SKILL" : "SKILL";
    return `\n\n[📜 ${label}: ${e.name}]\n${e.content.trim()}`;
}

export type SkillBudgetLevel = "quick" | "standard" | "deep";

/**
 * Skill tranche used when the caller sets no `max_tokens`.
 *
 * Sized against the ~25k-token host tool-result cap: at the 3.5 chars/token
 * heuristic that is ~87k chars for the WHOLE response, so the skill block has
 * to leave room for briefing, handoff, and history.
 *
 * These are ADDITIVE on top of the protected floor, not a total. Protected
 * skills inline even when the budget is already blown (assembleSkillBlock), and
 * the repo-measured v26 floor is ~39k chars on its own — so the ceiling here is
 * roughly 87k - 39k - memory. `standard` matches the 8,400-char tranche the
 * existing v26 shape test already treats as the standard budget (60% of 14k
 * tokens); `deep` doubles it and still leaves headroom for deep history.
 *
 * `quick` is deliberately near-nothing — it is the setting a caller picks to
 * minimize context, and before this it still inlined the full skill payload,
 * because `level` gated only the memory portion, which is the small part.
 *
 * Every value is finite and > 0 on purpose: assembleSkillBlock treats ≤ 0 and
 * non-finite as "unbudgeted", so a zero here would silently restore the very
 * bug this table exists to fix.
 */
export const DEFAULT_SKILL_BUDGET_CHARS: Record<SkillBudgetLevel, number> = {
    quick: 2_000,
    standard: 8_400,
    deep: 16_000,
};

/**
 * Resolve the skill-block budget for one call.
 *
 * 2026-08-01: this previously evaluated to POSITIVE_INFINITY whenever
 * `max_tokens` was absent — which is the documented default and therefore the
 * common call shape. Routing v25 (76 -> 95 skills, 19 moved to auto-load) then
 * pushed the unbudgeted block to 91,578 chars, past the host cap, and the host
 * diverted the ENTIRE response to a file: the agent received no context at all.
 * The budget must be armed by default, not only when a caller opts in.
 */
export function resolveSkillBudgetChars(
    maxTokens: number | undefined,
    level: SkillBudgetLevel,
): number {
    // 60% of the response allowance: skills must not saturate it, or the
    // briefing and history this tool exists to deliver get truncated away.
    if (typeof maxTokens === "number" && Number.isFinite(maxTokens) && maxTokens > 0) {
        return Math.max(1, Math.floor(maxTokens * 3.5 * 0.6));
    }
    return DEFAULT_SKILL_BUDGET_CHARS[level] ?? DEFAULT_SKILL_BUDGET_CHARS.standard;
}

/**
 * Assemble the skill block within `budgetChars`. `budgetChars` ≤ 0 or
 * non-finite means unbudgeted (legacy behavior: inline everything).
 */
export function assembleSkillBlock(
    entries: SkillEntryForBudget[],
    budgetChars: number,
): BudgetedSkillBlock {
    const ordered = [...entries].sort(fillOrder);
    const unbudgeted = !Number.isFinite(budgetChars) || budgetChars <= 0;

    let block = "";
    let unprotectedChars = 0;
    const inlined: string[] = [];
    const overflow: string[] = [];

    for (const e of ordered) {
        const piece = render(e);
        // Protected always inline and NEVER debit the budget: the tranche is
        // documented as ADDITIVE on top of the floor. The previous check
        // compared block.length — which the floor had already filled — so with
        // a ~46KB floor against 2-16KB tranches, NO unprotected skill ever
        // inlined at any normal budget. Rank was irrelevant; the budget was
        // pre-spent. Found 2026-08-11 tracing why a prompt-matched
        // verified-shipping still sat in overflow while an agent shipped
        // unverified UI claims; the 2026-08-03 note ("no unprotected universal
        // was ever inlined") had recorded this symptom and it was treated by
        // protecting one skill instead of fixing the accounting.
        if (unbudgeted || e.protected) {
            block += piece;
            inlined.push(e.name);
            continue;
        }
        if (unprotectedChars + piece.length <= budgetChars) {
            block += piece;
            unprotectedChars += piece.length;
            inlined.push(e.name);
        } else {
            overflow.push(e.name);
        }
    }

    if (overflow.length > 0) {
        block +=
            `\n\n[📦 SKILLS NOT INLINED — max_tokens budget reached]\n` +
            `${overflow.join(", ")}\n` +
            `These are RULES YOU ARE BOUND BY, not optional reading — only their text ` +
            `was withheld for budget. Before acting on work a listed skill governs ` +
            `(e.g. verified-shipping before any completion claim, push, or PR), load ` +
            `its body first: invoke it via the host's Skill tool, read it from the ` +
            `skills directory, or re-call session_load_context with a higher ` +
            `max_tokens. Claiming done without consulting the governing skill is the ` +
            `exact failure this list exists to prevent.`;
    }

    return { block, inlined, overflow };
}
