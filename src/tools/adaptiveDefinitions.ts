/**
 * Adaptive Engine MCP Tools
 *
 * Exposes the synalux/prism-aac AdaptiveProfile to any MCP client (Claude
 * Desktop, IDE assistants, voice agents, etc.). The profile is the single
 * point of truth for the user's behavioral and emotional state, mirrored
 * across:
 *   - prism-aac/services/adaptiveEngine.ts (web/native client)
 *   - synalux-private/portal/src/shared/adaptiveEngine.ts (server)
 *   - this file (MCP surface)
 *
 * Tools:
 *   adaptive_get_profile  — returns the current AdaptiveProfile + signals
 *   adaptive_set_profile  — replaces the AdaptiveProfile (caregiver/admin)
 *   adaptive_record_event — records a behavioral event (tone, dwell, message)
 *   adaptive_detect_tone  — pure function: text → tone label (no side effects)
 *   adaptive_reset        — wipes the profile (caregiver-initiated reset)
 *
 * Storage: prism-mcp's existing Supabase client (same one used by
 * session_save_ledger / session_load_context). Per-user RLS on the
 * `adaptive_profiles` table. Schema migration:
 *   synalux-private/portal/migrations/20260502_adaptive_profiles.sql
 */
import { type Tool } from "@modelcontextprotocol/sdk/types.js";

export const ADAPTIVE_GET_PROFILE_TOOL: Tool = {
  name: "adaptive_get_profile",
  description:
    "Get the user's current adaptive profile and a compact signals snapshot. " +
    "Use this when you need the user's dominant mood, motor rhythm, noise " +
    "environment, or vocabulary preferences — typically before generating a " +
    "response that should match their state. Returns the full profile plus a " +
    "small `signals` block that is safe to embed in a prompt.",
  inputSchema: {
    type: "object",
    properties: {
      user_id: {
        type: "string",
        description:
          "Optional. User identifier. If omitted, the server uses the authenticated user from context.",
      },
      include_history: {
        type: "boolean",
        description:
          "If true, include the toneHistory and full timeOfDayPatterns. Defaults to false (signals + summary only) to keep payload small.",
      },
    },
  },
};

export const ADAPTIVE_SET_PROFILE_TOOL: Tool = {
  name: "adaptive_set_profile",
  description:
    "Replace the user's adaptive profile in full. Intended for caregivers " +
    "syncing across devices, restoring from backup, or admin migration. " +
    "Schema must match version 2 of the AdaptiveProfile (see " +
    "src/shared/adaptiveEngine.ts).",
  inputSchema: {
    type: "object",
    properties: {
      user_id: {
        type: "string",
        description: "Optional. User identifier (defaults to authenticated user).",
      },
      profile: {
        type: "object",
        description: "Full AdaptiveProfile object. Must include version: 2.",
      },
    },
    required: ["profile"],
  },
};

export const ADAPTIVE_RECORD_EVENT_TOOL: Tool = {
  name: "adaptive_record_event",
  description:
    "Record a single behavioral event into the adaptive profile. " +
    "Use this from any surface that observes user behavior (voice agents, " +
    "AAC dwell triggers, message logs). Events are written incrementally — " +
    "no need to fetch+modify+save the whole profile. " +
    "Event types: " +
    "tone (text → AdaptiveTone, also records to toneHistory), " +
    "dwell (dwellMs sample for motor rhythm), " +
    "move_speed (px/sec sample for cursor smoothing), " +
    "noise (rmsDb sample for environment), " +
    "message (text + optional categoryId for vocab + frequency tracking), " +
    "mispronunciation (heard → intended; emergency words always pass through).",
  inputSchema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "Optional user id." },
      event: {
        type: "string",
        enum: ["tone", "dwell", "move_speed", "noise", "message", "mispronunciation"],
        description: "Event type.",
      },
      text: {
        type: "string",
        description: "For tone/message: the utterance text. For mispronunciation: the heard form.",
      },
      intended: {
        type: "string",
        description: "For mispronunciation: the corrected form.",
      },
      value: {
        type: "number",
        description: "For dwell/move_speed/noise: the numeric sample.",
      },
      category_id: {
        type: "string",
        description: "For message: optional category id (e.g. 'food', 'feelings').",
      },
    },
    required: ["event"],
  },
};

export const ADAPTIVE_DETECT_TONE_TOOL: Tool = {
  name: "adaptive_detect_tone",
  description:
    "Detect emotional tone from a piece of text WITHOUT recording it. " +
    "Pure function — useful when you want to route a response (e.g. choose " +
    "a TTS voice style or shape an LLM system prompt) but don't want to " +
    "perturb the user's profile. Returns one of: " +
    "neutral | friendly | excited | empathetic | serious. Emergency words " +
    "(help/hurt/scared/911/etc) always map to 'serious'.",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string", description: "Text to analyze." },
    },
    required: ["text"],
  },
};

export const ADAPTIVE_RESET_TOOL: Tool = {
  name: "adaptive_reset",
  description:
    "Wipe the user's adaptive profile. Caregiver-initiated reset only — " +
    "resets all learned dwell, motor speed, vocabulary, mispronunciation " +
    "corrections, tone history, and noise calibration. Returns the fresh " +
    "default profile.",
  inputSchema: {
    type: "object",
    properties: {
      user_id: { type: "string", description: "Optional user id." },
      confirm: {
        type: "boolean",
        description: "Must be true. Defends against accidental reset.",
      },
    },
    required: ["confirm"],
  },
};

// ─── Type guards (mirror the patterns used elsewhere in this repo) ───

export function isAdaptiveGetProfileArgs(
  args: unknown
): args is { user_id?: string; include_history?: boolean } {
  return typeof args === "object" && args !== null;
}

export function isAdaptiveSetProfileArgs(
  args: unknown
): args is { user_id?: string; profile: Record<string, unknown> } {
  return (
    typeof args === "object" &&
    args !== null &&
    "profile" in args &&
    typeof (args as { profile: unknown }).profile === "object" &&
    (args as { profile: unknown }).profile !== null
  );
}

export function isAdaptiveRecordEventArgs(
  args: unknown
): args is {
  user_id?: string;
  event: "tone" | "dwell" | "move_speed" | "noise" | "message" | "mispronunciation";
  text?: string;
  intended?: string;
  value?: number;
  category_id?: string;
} {
  if (typeof args !== "object" || args === null) return false;
  const a = args as { event?: unknown };
  return (
    typeof a.event === "string" &&
    ["tone", "dwell", "move_speed", "noise", "message", "mispronunciation"].includes(a.event)
  );
}

export function isAdaptiveDetectToneArgs(
  args: unknown
): args is { text: string } {
  return (
    typeof args === "object" &&
    args !== null &&
    "text" in args &&
    typeof (args as { text: unknown }).text === "string"
  );
}

export function isAdaptiveResetArgs(
  args: unknown
): args is { user_id?: string; confirm: boolean } {
  return (
    typeof args === "object" &&
    args !== null &&
    "confirm" in args &&
    (args as { confirm: unknown }).confirm === true
  );
}
