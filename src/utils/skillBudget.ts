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
    const inlined: string[] = [];
    const overflow: string[] = [];

    for (const e of ordered) {
        const piece = render(e);
        // Protected always inline; others only while they fit.
        if (unbudgeted || e.protected || block.length + piece.length <= budgetChars) {
            block += piece;
            inlined.push(e.name);
        } else {
            overflow.push(e.name);
        }
    }

    if (overflow.length > 0) {
        block +=
            `\n\n[📦 SKILLS NOT INLINED — max_tokens budget reached]\n` +
            `${overflow.join(", ")}\n` +
            `To inline them, re-call session_load_context with a higher max_tokens.`;
    }

    return { block, inlined, overflow };
}
