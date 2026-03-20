/**
 * SqliteSyncBus — File-Based IPC for Local Mode (v2.0 — Step 6)
 *
 * Cross-platform, zero-dependency sync between Prism MCP instances
 * using a tiny JSON file (~/.prism-mcp/sync.lock).
 *
 * ═══════════════════════════════════════════════════════════════════
 * HOW IT WORKS:
 *   1. Agent A saves a handoff → Prism writes SyncEvent to sync.lock
 *   2. Agent B's fs.watchFile detects the mtime change (every 500ms)
 *   3. Agent B reads sync.lock, checks client_id to prevent echo
 *   4. If it's from a different instance → emits 'update' event
 *   5. server.ts sends an MCP logging notification to Agent B's IDE
 *
 * WHY fs.watchFile (NOT fs.watch):
 *   fs.watch uses OS-specific APIs (inotify, FSEvents, ReadDirectoryChanges)
 *   that are unreliable for cross-platform lockfiles. fs.watchFile uses
 *   stable stat polling that works everywhere — the 500ms interval is
 *   intentionally low-overhead.
 *
 * WHY A FILE (NOT SQLite WAL):
 *   WAL tracking is complex and fragile. A simple JSON file is:
 *   - Atomic on all OS when content is < 4KB (single filesystem page)
 *   - Debuggable (just cat the file!)
 *   - Zero coupling to the storage layer
 * ═══════════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { SyncBus, SyncEvent } from "./index.js";

export class SqliteSyncBus extends SyncBus {
  private lockFilePath: string;
  private watching = false;

  constructor() {
    super();
    const prismDir = path.join(os.homedir(), ".prism-mcp");
    if (!fs.existsSync(prismDir)) {
      fs.mkdirSync(prismDir, { recursive: true });
    }
    this.lockFilePath = path.join(prismDir, "sync.lock");

    // Ensure the lockfile exists
    if (!fs.existsSync(this.lockFilePath)) {
      fs.writeFileSync(this.lockFilePath, "{}", "utf8");
    }
  }

  async broadcastUpdate(project: string, version: number): Promise<void> {
    const payload: SyncEvent = {
      project,
      version,
      client_id: this.clientId,
      timestamp: Date.now(),
    };

    // Atomic write — content is < 200 bytes, well within single-page write
    fs.writeFileSync(this.lockFilePath, JSON.stringify(payload), "utf8");
    console.error(
      `[SyncBus] Broadcast: project=${project}, version=${version}, ` +
        `client=${this.clientId.substring(0, 8)}`
    );
  }

  async startListening(): Promise<void> {
    if (this.watching) return;
    this.watching = true;

    // fs.watchFile is cross-platform stable (uses stat polling)
    // 500ms interval = detect changes within ~0.5s, minimal CPU overhead
    fs.watchFile(this.lockFilePath, { interval: 500 }, (curr, prev) => {
      if (curr.mtimeMs > prev.mtimeMs) {
        try {
          const data = fs.readFileSync(this.lockFilePath, "utf8");
          const event = JSON.parse(data) as SyncEvent;

          // Only emit if it came from a DIFFERENT Prism MCP instance
          if (event.client_id && event.client_id !== this.clientId) {
            console.error(
              `[SyncBus] Received update from client ${event.client_id.substring(0, 8)}: ` +
                `project=${event.project}, version=${event.version}`
            );
            this.emit("update", event);
          }
        } catch {
          // Ignore JSON parse errors from partial writes or empty file
        }
      }
    });

    console.error(
      `[SyncBus] Listening for updates on ${this.lockFilePath} ` +
        `(client=${this.clientId.substring(0, 8)})`
    );
  }

  async stopListening(): Promise<void> {
    if (!this.watching) return;
    this.watching = false;
    fs.unwatchFile(this.lockFilePath);
    console.error("[SyncBus] Stopped listening");
  }
}
