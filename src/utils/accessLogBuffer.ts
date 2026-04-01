/**
 * AccessLogBuffer — Write Contention Prevention for memory_access_log
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Prevents SQLite SQLITE_BUSY errors by batching access log writes.
 *
 * PROBLEM (Rule #1):
 *   Every memory search fires logAccess() writes. If an LLM agent fires
 *   5 parallel tool calls to search memory, you get 5 concurrent SQLite
 *   write attempts. SQLite's WAL mode helps for reads but writes still
 *   acquire an exclusive lock — concurrent writes throw SQLITE_BUSY.
 *
 * SOLUTION:
 *   Buffer access events in memory, flush as a single INSERT transaction
 *   every flushIntervalMs (default 5000ms). This reduces write operations
 *   from O(searches) to O(1 per interval).
 *
 * PROPERTIES:
 *   - push() is synchronous (zero latency for callers)
 *   - flush() uses a single multi-value INSERT (1 write lock, not N)
 *   - splice(0) drain is atomic — no data loss during concurrent access
 *   - dispose() flushes remaining buffer on shutdown
 *   - Deduplication: collapses duplicate entryIds within the same
 *     flush window (prevents bloat from rapid agent loops, Rule #3B)
 *
 * LIFECYCLE:
 *   Instantiated once in SqliteStorage.initialize().
 *   Disposed in SqliteStorage.close().
 *
 * FILES THAT IMPORT THIS:
 *   - src/storage/sqlite.ts (construction + delegation)
 * ═══════════════════════════════════════════════════════════════════
 */

import { debugLog } from "./logger.js";

/** A single buffered access event waiting to be flushed to SQLite. */
interface BufferedAccess {
  entryId: string;
  contextHash: string | null;
  timestamp: string;
}

/**
 * Database interface — minimal contract for the buffer to write.
 * Keeps the buffer decoupled from the full SqliteStorage class.
 *
 * NOTE: The `args` type must be `Array<string | number | bigint | ArrayBuffer | null>`
 * (i.e., compatible with @libsql/client's InValue[]) so that SqliteStorage.db
 * satisfies this interface without casting.
 */
interface BufferDatabase {
  execute(query: { sql: string; args: Array<string | number | bigint | ArrayBuffer | null> }): Promise<unknown>;
}

export class AccessLogBuffer {
  private buffer: BufferedAccess[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private db: BufferDatabase;
  private disposed = false;

  /**
   * @param db - Database connection for flushing (injected for testability)
   * @param flushIntervalMs - How often to flush (default: 5000ms)
   */
  constructor(db: BufferDatabase, flushIntervalMs: number = 5000) {
    this.db = db;

    // Only start the timer if a positive interval is given.
    // Tests may pass 0 to disable auto-flush and control it manually.
    if (flushIntervalMs > 0) {
      this.flushTimer = setInterval(() => {
        this.flush().catch(err => {
          debugLog(
            `[AccessLogBuffer] Auto-flush failed: ${err instanceof Error ? err.message : String(err)}`
          );
        });
      }, flushIntervalMs);

      // Prevent the timer from keeping the Node.js process alive
      // when all other handles have been closed (graceful shutdown).
      if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  /**
   * Record an access event. This is intentionally SYNCHRONOUS —
   * callers pay zero async overhead. The event is buffered in memory
   * and will be flushed to SQLite on the next flush cycle.
   *
   * @param entryId - The session_ledger entry that was accessed
   * @param contextHash - Optional hash of the search query context
   */
  push(entryId: string, contextHash?: string): void {
    if (this.disposed) return;

    this.buffer.push({
      entryId,
      contextHash: contextHash || null,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Flush the buffer to SQLite as a single batch INSERT.
   *
   * DEDUPLICATION (Rule #3B — Buffer Debouncing):
   *   Before building the INSERT, collapses duplicate entryIds within
   *   the same flush window. If an agent retrieves the same memory 5
   *   times in 2 seconds, only 1 access log row is written.
   *   This preserves frequency semantics (1 access per 5s is plenty
   *   for ACT-R math) without database bloat.
   *
   * @returns Number of unique rows inserted
   */
  async flush(): Promise<number> {
    // Atomic drain: splice(0) removes all elements and returns them.
    // Even if push() is called during this async operation, those new
    // events won't be lost — they go into the fresh empty array.
    const batch = this.buffer.splice(0);

    if (batch.length === 0) return 0;

    // ── Deduplication: keep only the LATEST access per entryId ──
    // Map from entryId → BufferedAccess, last-write-wins within window
    const deduped = new Map<string, BufferedAccess>();
    for (const event of batch) {
      deduped.set(event.entryId, event);
    }

    const uniqueEvents = Array.from(deduped.values());

    if (uniqueEvents.length === 0) return 0;

    // ── Chunked INSERT to stay within SQLITE_MAX_VARIABLE_NUMBER ──
    // Older SQLite builds cap bound variables at 999; modern ones at 32766.
    // 500 entries × 3 vars = 1500, safe on all versions.
    const CHUNK_SIZE = 500;
    let totalInserted = 0;

    try {
      for (let i = 0; i < uniqueEvents.length; i += CHUNK_SIZE) {
        const chunk = uniqueEvents.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "(?, ?, ?)").join(", ");
        const args: Array<string | number | bigint | ArrayBuffer | null> = [];
        for (const event of chunk) {
          args.push(event.entryId, event.timestamp, event.contextHash);
        }

        await this.db.execute({
          sql: `INSERT INTO memory_access_log (entry_id, accessed_at, context_hash) VALUES ${placeholders}`,
          args,
        });

        totalInserted += chunk.length;
      }

      debugLog(`[AccessLogBuffer] Flushed ${totalInserted} access events (from ${batch.length} raw)`);
      return totalInserted;
    } catch (err) {
      // On failure, DO NOT re-queue — access logs are telemetry,
      // not critical data. Losing a flush window is acceptable.
      debugLog(
        `[AccessLogBuffer] Flush failed (partial loss): ` +
        `${err instanceof Error ? err.message : String(err)}`
      );
      return totalInserted;
    }
  }

  /**
   * Graceful shutdown: clear the timer and flush any remaining events.
   * Called from SqliteStorage.close().
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    if (this.flushTimer !== null) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Final flush to drain any remaining events
    await this.flush();

    debugLog("[AccessLogBuffer] Disposed");
  }

  /**
   * Returns the number of events currently buffered (for observability).
   */
  get pendingCount(): number {
    return this.buffer.length;
  }
}
