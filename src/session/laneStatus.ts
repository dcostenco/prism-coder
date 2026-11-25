/**
 * Lane status on the client (drift-fix slice D-2a).
 *
 * The portal attaches `lane_status`, `lane_block` and `lane_paths` to load_context, save_ledger,
 * save_handoff and detect_drift responses (a register of the owner's programs and lanes, with a
 * stalled lane named first). This module carries that block to the host: the model reads it at
 * character 0 of the tool result, ahead of summaries and memory notes.
 *
 * How it travels. server.ts opens one `LaneCallContext` per tool call (AsyncLocalStorage). The
 * storage layer reads it to add `conversation_id`, `program` and `host` to the portal request, and
 * writes the block it gets back into it; the dispatcher prepends that block to the result's first
 * text. A call that makes no portal request (a refused save, a greeting skip) records nothing, so a
 * block can never outlive its call.
 *
 * What it never does. It never changes a tool's isError or any text but the one prepended block. A
 * malformed, missing or oversized field leaves the result as it was. The block is capped at 1,000
 * characters and stripped of tag-like text and control characters here, whatever the portal sent.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const LANE_ACTIONS = new Set(["load_context", "save_ledger", "save_handoff", "detect_drift"]);
/**
 * The only tools whose results carry a lane block (design D3). Other tools (prism_infer, memory_checkout,
 * session_export_memory, ...) call the same storage methods inside, and must not grow a block.
 */
export const LANE_TOOLS = new Set(["session_load_context", "session_bootstrap", "session_save_ledger", "session_save_handoff", "session_detect_drift"]);
export const LANE_BLOCK_MAX = 1000;
export const LANE_UNAVAILABLE_LINE = "Lane register unavailable";
const HOST = "prism-mcp";
const PROGRAM_RE = /^[A-Za-z0-9-]{1,24}$/;

export interface LaneCallContext {
  /** False for a tool outside LANE_TOOLS: nothing is added to its requests and nothing is recorded. */
  enabled?: boolean;
  /** The conversation this call belongs to, from the tool's arguments (a bootstrap sets it once it has one). */
  conversationId?: string;
  /** The program a load names (optional; the portal binds the conversation to it). */
  program?: string;
  /** Blocks recorded by this call's portal requests, by project, in order. */
  blocks: Array<{ project: string; text: string }>;
}

export const laneCallContext = new AsyncLocalStorage<LaneCallContext>();

export function newLaneContext(args: unknown, tool?: string): LaneCallContext {
  const a = (args ?? {}) as Record<string, unknown>;
  const conversationId = typeof a.conversation_id === "string" && a.conversation_id.trim() ? a.conversation_id.trim() : undefined;
  const program = typeof a.program === "string" && PROGRAM_RE.test(a.program) ? a.program : undefined;
  return { enabled: tool === undefined || LANE_TOOLS.has(tool), conversationId, program, blocks: [] };
}

/** Adds the lane request fields to a portal request body, for the four lane actions only. */
export function decorateLaneRequest(body: Record<string, unknown>): Record<string, unknown> {
  const ctx = laneCallContext.getStore();
  if (!ctx || ctx.enabled === false || typeof body.action !== "string" || !LANE_ACTIONS.has(body.action)) return body;
  const out = { ...body };
  if (out.host === undefined) out.host = HOST;
  if (out.conversation_id === undefined && ctx.conversationId) out.conversation_id = ctx.conversationId;
  if (body.action === "load_context" && out.program === undefined && ctx.program) out.program = ctx.program;
  return out;
}

/** Text safe to show: no control characters, no tag-like spans, no more than `max` characters. */
export function cleanBlock(text: string, max = LANE_BLOCK_MAX): string {
  // Only tag-like spans go ("<system>", "</x>", "<!--"); a bare "<" or ">" ("merge data <1h old") stays.
  // Backticks, control, bidi and zero-width characters go too, so a lane title cannot open a code fence
  // or hide text from the output sanitizer.
  // eslint-disable-next-line no-control-regex
  const plain = text.replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff`]/g, "")
    .replace(/<\/?[A-Za-z!?][^>\n]*>?/g, "");
  return plain.length <= max ? plain : `${plain.slice(0, max - 1)}…`;
}

/** The block a portal response carries, or null: nothing for a project with no programs, an unusable field, or no lane fields. */
export function laneBlockFrom(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  const status = r.lane_status;
  if (!status || typeof status !== "object" || Array.isArray(status)) return null;
  if ((status as { unavailable?: unknown }).unavailable === true) return LANE_UNAVAILABLE_LINE;
  if (typeof r.lane_block !== "string") return null;
  const text = cleanBlock(r.lane_block);
  return text.trim() ? text : null;
}

/** Records the block of a portal response on the current tool call. Never throws. */
export function recordLaneBlock(project: unknown, action: unknown, response: unknown): void {
  try {
    const ctx = laneCallContext.getStore();
    if (!ctx || ctx.enabled === false || typeof action !== "string" || !LANE_ACTIONS.has(action)) return;
    const text = laneBlockFrom(response);
    if (text) ctx.blocks.push({ project: typeof project === "string" ? project : "", text });
  } catch { /* the lane block is best-effort: it never breaks a tool call */ }
}

/**
 * The text to put at character 0: the first block per project, up to 1,000 characters in all (so
 * several autoloaded projects share one budget); projects that did not fit are named in one line.
 */
export function laneTextFor(ctx: LaneCallContext): string | null {
  const seen = new Set<string>();
  const wanted: Array<{ project: string; text: string }> = [];
  for (const block of ctx.blocks) {
    if (seen.has(block.project)) continue;
    seen.add(block.project);
    wanted.push(block);
  }
  const shown: Array<{ project: string; text: string }> = [];
  const left: string[] = [];
  let used = 0;
  for (const block of wanted) {
    if (used + block.text.length + (shown.length ? 1 : 0) <= LANE_BLOCK_MAX) {
      used += block.text.length + (shown.length ? 1 : 0);
      shown.push(block);
    } else {
      left.push(block.project || "?");
    }
  }
  if (shown.length === 0) return null;
  const overflow = () => cleanBlock(`More lane status on: ${left.join(", ")} (load them one at a time).`, 200);
  // The overflow line counts against the same 1,000 characters: drop trailing blocks until it fits.
  const total = () => shown.reduce((n, b) => n + b.text.length + 1, 0) + overflow().length;
  while (left.length > 0 && shown.length > 1 && total() > LANE_BLOCK_MAX) {
    left.unshift(shown.pop()!.project || "?");
  }
  // One block left and still over: shorten it (its stall lines come first) to leave room for the overflow line.
  if (left.length > 0 && shown.length === 1 && total() > LANE_BLOCK_MAX) {
    shown[0] = { ...shown[0], text: cleanBlock(shown[0].text, LANE_BLOCK_MAX - overflow().length - 1) };
  }
  const lines = shown.map(block => block.text);
  if (left.length > 0) lines.push(overflow());
  return lines.join("\n");
}

type ToolResult = { content?: Array<{ type: string; text?: string }>; isError?: boolean } | undefined;

/**
 * Puts the lane block at character 0 of the result's first text part. Every failure (no text part,
 * a result that is not an object, a throw) leaves the result exactly as it was.
 */
export function prependLaneBlock(result: ToolResult, ctx: LaneCallContext | undefined): void {
  try {
    if (!result || !ctx || !Array.isArray(result.content)) return;
    const text = laneTextFor(ctx);
    if (!text) return;
    const first = result.content.find(part => part && part.type === "text" && typeof part.text === "string");
    if (!first) return;
    first.text = `${text}\n${first.text}`;
  } catch { /* leave the result untouched */ }
}
