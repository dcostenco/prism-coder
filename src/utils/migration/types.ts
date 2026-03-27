/**
 * ═══════════════════════════════════════════════════════════════════
 * Migration Types — Strategy Pattern Interfaces
 * ═══════════════════════════════════════════════════════════════════
 *
 * REVIEWER NOTE:
 *   This file defines the core contracts for the Universal Migration
 *   Utility. Each LLM format (Claude, Gemini, OpenAI) implements the
 *   MigrationAdapter interface. All turns are normalized into the
 *   NormalizedTurn schema before being mapped to Prism's LedgerEntry.
 *
 * DESIGN DECISION:
 *   NormalizedTurn is intentionally NOT a subset of LedgerEntry.
 *   The orchestrator (universalImporter.ts) performs the final mapping.
 *   This keeps adapters decoupled from storage internals.
 * ═══════════════════════════════════════════════════════════════════
 */

/**
 * A normalized representation of a single conversational turn.
 * All format-specific adapters must map their source data into this shape.
 *
 * Fields like `sessionId` and `project` are set to defaults in adapters
 * and can be overridden by the orchestrator via CLI flags (--project).
 */
export interface NormalizedTurn {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;       // ISO 8601 — adapters must provide fallbacks if source lacks timestamps
  sessionId: string;       // Adapter-generated ID (e.g., 'claude-migration')
  project: string;         // Default target project — overridable by orchestrator
  branch?: string;         // Git branch context, if available in source data
  todos: string[];         // Extracted TODO items (usually empty for migration)
  files_changed: string[]; // Files referenced in this turn (usually empty for migration)
  messageId?: string;      // For Claude streaming deduplication — the message.id that groups chunks
  tools?: string[];        // Names of tools invoked in this turn (e.g., ['get_weather', 'read_file'])
}

/**
 * Strategy Pattern interface for format-specific adapters.
 *
 * REVIEWER NOTE:
 *   - `canHandle`: Heuristic auto-detection based on file path. This is a
 *     convenience fallback — users should prefer explicit `--format=` flags.
 *   - `parse`: Streaming callback pattern — each turn is emitted via `onTurn`
 *     to keep memory usage O(1) regardless of file size.
 */
export interface MigrationAdapter {
  /** Unique adapter identifier (e.g., 'claude', 'gemini', 'openai') */
  id: string;

  /**
   * Heuristic auto-detection: returns true if this adapter can likely
   * handle the given file path. Used as a fallback when --format is not specified.
   *
   * IMPORTANT: This is filename-based, not content-based. For ambiguous files,
   * users must use --format= to avoid misdetection. See Finding 1 in code_review.md.
   */
  canHandle(filePath: string): boolean;

  /**
   * Stream-parse the source file and emit normalized turns via the callback.
   * Implementations MUST handle OOM safety (streaming, not full-file reads).
   */
  parse(filePath: string, onTurn: (turn: NormalizedTurn) => Promise<void>): Promise<void>;
}
