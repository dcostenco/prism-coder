/**
 * SyncBus — Multi-Client Synchronization (v2.0 — Step 6)
 *
 * Abstract event bus that enables "Telepathy" between Prism MCP instances.
 * When Agent A (in Cursor) saves a handoff, Agent B (in Claude Desktop)
 * instantly receives a notification to sync up.
 *
 * ═══════════════════════════════════════════════════════════════════
 * ARCHITECTURE:
 *   SyncBus (abstract)
 *     ├── SqliteSyncBus  — file-based IPC via sync.lock (local mode)
 *     └── SupabaseSyncBus — Supabase Realtime CDC (cloud mode)
 *
 * DESIGN DECISIONS:
 *   - Uses EventEmitter instead of callbacks for clean decoupling.
 *   - Each instance gets a unique clientId to prevent echo (hearing
 *     your own saves as updates from another agent).
 *   - SyncEvent is minimal — just project, version, client_id, and
 *     timestamp. The receiving agent calls session_load_context to
 *     get the full state.
 * ═══════════════════════════════════════════════════════════════════
 */

import { EventEmitter } from "events";
import { randomUUID } from "crypto";

/**
 * Payload broadcast when any Prism MCP instance saves a handoff.
 */
export interface SyncEvent {
  project: string;
  version: number;
  client_id: string;
  timestamp: number;
}

/**
 * Abstract sync bus. Concrete implementations handle the transport.
 */
export abstract class SyncBus extends EventEmitter {
  /** Unique ID for this MCP instance — used to filter echo events */
  public readonly clientId: string = randomUUID();

  /** Broadcast that we just saved a handoff (notify other instances) */
  abstract broadcastUpdate(project: string, version: number): Promise<void>;

  /** Start listening for updates from other instances */
  abstract startListening(): Promise<void>;

  /** Stop listening and clean up resources */
  abstract stopListening(): Promise<void>;
}
