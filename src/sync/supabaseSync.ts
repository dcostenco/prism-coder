/**
 * SupabaseSyncBus — Cloud Realtime Sync via Supabase (v2.0 — Step 6)
 *
 * Uses Supabase Realtime (Postgres CDC) to listen for handoff updates.
 * When ANY client saves a handoff, the Postgres trigger broadcasts
 * the change to all listening Prism MCP instances.
 *
 * ═══════════════════════════════════════════════════════════════════
 * DESIGN DECISIONS:
 *   - Dynamically imports @supabase/supabase-js to avoid a hard dependency.
 *     If the package isn't installed, the bus logs a warning and operates
 *     in "no-op" mode (no crash, just no sync).
 *   - broadcastUpdate() is a no-op because the actual database INSERT
 *     in session_handoffs IS the broadcast — Postgres CDC handles it.
 *   - We don't need client_id filtering here because Supabase Realtime
 *     only fires for external writes (not our own transaction).
 * ═══════════════════════════════════════════════════════════════════
 */

import { SyncBus } from "./index.js";

export class SupabaseSyncBus extends SyncBus {
  private supabaseUrl: string;
  private supabaseKey: string;
  private supabase: any = null;
  private channel: any = null;

  constructor(supabaseUrl: string, supabaseKey: string) {
    super();
    this.supabaseUrl = supabaseUrl;
    this.supabaseKey = supabaseKey;
  }

  async broadcastUpdate(
    _project: string,
    _version: number
  ): Promise<void> {
    // In Supabase mode, the database INSERT itself is the broadcast.
    // Postgres CDC (Change Data Capture) notifies all listeners automatically.
    // No explicit broadcast needed.
  }

  async startListening(): Promise<void> {
    try {
      // Dynamic import — avoids hard dependency on @supabase/supabase-js
      // @ts-ignore — @supabase/supabase-js is an optional dependency
      const { createClient } = await import("@supabase/supabase-js");
      this.supabase = createClient(this.supabaseUrl, this.supabaseKey);

      this.channel = this.supabase
        .channel("prism-sync-handoffs")
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: "session_handoffs",
          },
          (payload: any) => {
            const newRow = payload.new;
            if (newRow) {
              console.error(
                `[SyncBus:Supabase] Received update: project=${newRow.project}, version=${newRow.version}`
              );
              this.emit("update", {
                project: newRow.project,
                version: newRow.version,
                client_id: "supabase-cdc",
                timestamp: Date.now(),
              });
            }
          }
        )
        .subscribe((status: string) => {
          console.error(`[SyncBus:Supabase] Channel status: ${status}`);
        });

      console.error(
        `[SyncBus:Supabase] Listening for realtime updates ` +
          `(client=${this.clientId.substring(0, 8)})`
      );
    } catch (err) {
      console.error(
        `[SyncBus:Supabase] Failed to start realtime sync ` +
          `(is @supabase/supabase-js installed?): ${err instanceof Error ? err.message : String(err)}`
      );
      console.error(
        "[SyncBus:Supabase] Continuing without realtime sync — memory will still save/load normally"
      );
    }
  }

  async stopListening(): Promise<void> {
    if (this.channel && this.supabase) {
      try {
        await this.supabase.removeChannel(this.channel);
        console.error("[SyncBus:Supabase] Stopped listening");
      } catch {
        // Ignore cleanup errors
      }
    }
    this.channel = null;
  }
}
