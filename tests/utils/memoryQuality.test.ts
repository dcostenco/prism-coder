import { describe, expect, it } from "vitest";
import {
  filterGreetingOnlyMemoryEntries,
  filterPrismMemoryContext,
  isGreetingOnlyMemoryEntry,
} from "../../src/utils/memoryQuality.js";

const HISTORICAL_GREETINGS = [
  "[VSCode] Hi there! Hello — it's great to see you. How can I assist you today?",
  "[VSCode] Hello! 👋 How can I assist you today? Whether it's working on your projects, debugging issues, or exploring new features in Prism, just let me know what you need!",
] as const;

describe("Prism memory quality", () => {
  it.each(HISTORICAL_GREETINGS)("classifies the observed greeting-only row: %s", (summary) => {
    expect(isGreetingOnlyMemoryEntry({ summary })).toBe(true);
  });

  it("classifies a bare salutation", () => {
    expect(isGreetingOnlyMemoryEntry({ summary: "Hi! 👋" })).toBe(true);
  });

  it("preserves substantive or structured work", () => {
    expect(isGreetingOnlyMemoryEntry({ summary: "Implemented browser approval policy" })).toBe(false);
    expect(isGreetingOnlyMemoryEntry({ summary: "Hello", decisions: ["Use the local worker"] })).toBe(false);
    expect(isGreetingOnlyMemoryEntry({ summary: "Hi", todos: ["Run integration tests"] })).toBe(false);
    expect(isGreetingOnlyMemoryEntry({ summary: "Hey", files_changed: ["src/app.ts"] })).toBe(false);
    expect(isGreetingOnlyMemoryEntry({ summary: "Hello", event_type: "validation" })).toBe(false);
  });

  it("filters legacy greetings without changing substantive order", () => {
    const entries = [
      { id: "greeting-1", summary: HISTORICAL_GREETINGS[0] },
      { id: "work-1", summary: "Fixed duplicate greeting memory" },
      { id: "greeting-2", summary: HISTORICAL_GREETINGS[1] },
      { id: "work-2", summary: "Verified standard context" },
    ];

    expect(filterGreetingOnlyMemoryEntries(entries).map((entry) => entry.id)).toEqual(["work-1", "work-2"]);
  });

  it("filters all context history surfaces without mutating the storage response", () => {
    const context = {
      last_summary: HISTORICAL_GREETINGS[0],
      recent_sessions: [
        { summary: HISTORICAL_GREETINGS[1] },
        { summary: "Built local browser tests" },
      ],
      session_history: [
        { summary: "Verified portal integration" },
        { summary: "Hi" },
      ],
    };

    const filtered = filterPrismMemoryContext(context);

    expect(filtered.last_summary).toBeNull();
    expect(filtered.recent_sessions).toEqual([{ summary: "Built local browser tests" }]);
    expect(filtered.session_history).toEqual([{ summary: "Verified portal integration" }]);
    expect(context.last_summary).toBe(HISTORICAL_GREETINGS[0]);
    expect(context.recent_sessions).toHaveLength(2);
  });
});
