/**
 * Think-Strip — remove <think>...</think> blocks from model output.
 *
 * Qwen3.5 uses <think> blocks for chain-of-thought reasoning.
 * These must be stripped before serving to the user or passing
 * to the grounding verifier (which would try to ground reasoning text).
 *
 * Returns: { stripped: string, thinkContent: string | null, thinkOnly: boolean }
 */

export interface ThinkStripResult {
    stripped: string;
    thinkContent: string | null;
    thinkOnly: boolean;
}

const THINK_RE = /<(?:think|\|synalux_think\|)>[\s\S]*?<\/(?:think|\|synalux_think\|)>\s*/g;
const UNCLOSED_THINK_RE = /<(?:think|\|synalux_think\|)>[\s\S]*$/;

export function stripThink(raw: string): ThinkStripResult {
    if (!raw.includes("<think>") && !raw.includes("<|synalux_think|>")) {
        return { stripped: raw, thinkContent: null, thinkOnly: false };
    }

    const thinkMatch = raw.match(/<(?:think|\|synalux_think\|)>([\s\S]*?)<\/(?:think|\|synalux_think\|)>/);
    const thinkContent = thinkMatch ? thinkMatch[1].trim() : null;

    let stripped = raw.replace(THINK_RE, "");
    stripped = stripped.replace(UNCLOSED_THINK_RE, "");

    stripped = stripped.trim();

    return {
        stripped,
        thinkContent,
        thinkOnly: stripped.length === 0 && raw.trim().length > 0,
    };
}
