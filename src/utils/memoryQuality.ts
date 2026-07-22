export interface PrismMemoryEntryLike {
  summary?: unknown;
  decisions?: unknown;
  todos?: unknown;
  files_changed?: unknown;
  event_type?: unknown;
}

const SOURCE_LABEL_PATTERN = /^\s*\[[^\]]+\]\s*/u;
const GREETING_ONLY_PATTERN = /^(?:hi|hello|hey|ready)(?:[\s.!?,…—-]|[\u{1F300}-\u{1FAFF}]|\uFE0F)*$/iu;
const GREETING_OPENING_PATTERN = /^(?:hi(?:\s+there)?|hello|hey)\b/iu;
const ASSISTANCE_INVITATION_PATTERN = /\b(?:(?:how|what)\s+(?:can|may)\s+i\s+(?:help|assist)|let\s+me\s+know\s+what\s+you\s+need)\b/iu;
const SUBSTANTIVE_OUTCOME_PATTERN = /\b(?:added|built|changed|completed|configured|created|debugged|deployed|fixed|implemented|investigated|removed|repaired|resolved|tested|updated|verified|wrote)\b/iu;
const STRUCTURED_WORK_FIELDS = ["decisions", "todos", "files_changed"] as const;

function hasStructuredWork(entry: PrismMemoryEntryLike): boolean {
  return STRUCTURED_WORK_FIELDS.some((field) => {
    const value = entry[field];
    if (value === undefined || value === null) return false;
    return !Array.isArray(value) || value.length > 0;
  });
}

/** Greeting-only assistant replies are presentation, not durable work. */
export function isGreetingOnlyMemoryEntry(entry: PrismMemoryEntryLike): boolean {
  if (hasStructuredWork(entry)) return false;
  if (typeof entry.event_type === "string" && entry.event_type !== "session") return false;
  if (typeof entry.summary !== "string") return false;

  const summary = entry.summary.replace(SOURCE_LABEL_PATTERN, "").trim();
  if (!summary) return false;
  if (GREETING_ONLY_PATTERN.test(summary)) return true;

  return GREETING_OPENING_PATTERN.test(summary)
    && ASSISTANCE_INVITATION_PATTERN.test(summary)
    && !SUBSTANTIVE_OUTCOME_PATTERN.test(summary);
}

export function filterGreetingOnlyMemoryEntries<T extends PrismMemoryEntryLike>(entries: T[]): T[] {
  return entries.filter((entry) => !isGreetingOnlyMemoryEntry(entry));
}

/**
 * Defensive local-storage fallback for the portal-owned memory policy.
 * Returns a copy so storage responses remain immutable for other consumers.
 */
export function filterPrismMemoryContext<T extends Record<string, any>>(data: T): T {
  const filtered: Record<string, any> = { ...data };

  if (isGreetingOnlyMemoryEntry({ summary: data.last_summary })) {
    filtered.last_summary = null;
  }
  if (Array.isArray(data.recent_sessions)) {
    filtered.recent_sessions = filterGreetingOnlyMemoryEntries(data.recent_sessions);
  }
  if (Array.isArray(data.session_history)) {
    filtered.session_history = filterGreetingOnlyMemoryEntries(data.session_history);
  }

  return filtered as T;
}
