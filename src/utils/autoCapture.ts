/**
 * Auto-Capture Utility (v2.1 — Step 10)
 *
 * Automatically captures an HTML snapshot from a running local dev server
 * and saves it to the Prism visual memory vault.
 *
 * How it works:
 *   1. Iterates through configured ports (default: 3000, 3001, 5173, 8080)
 *   2. Attempts a fast HTTP GET with a 1.5s timeout
 *   3. If a server responds, saves the HTML to ~/.prism-mcp/media/<project>/
 *   4. Returns metadata for indexing in handoff.metadata.visual_memory[]
 *   5. If no server is running, returns null silently (zero friction)
 *
 * This is designed to be called as a fire-and-forget side effect from
 * sessionSaveHandoffHandler — it should NEVER block the handoff save.
 *
 * ═══════════════════════════════════════════════════════════════════
 * GATING:
 *   Set PRISM_AUTO_CAPTURE=true to enable
 *   Set PRISM_CAPTURE_PORTS=3000,5173 to customize ports (comma-separated)
 * ═══════════════════════════════════════════════════════════════════
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { randomUUID } from "crypto";

/**
 * Attempts to fetch an HTML snapshot from a list of local ports.
 * Returns the metadata object for visual_memory[] if successful, or null if no server responded.
 */
export async function captureLocalEnvironment(
  project: string,
  ports: number[]
): Promise<{
  id: string;
  description: string;
  filename: string;
  original_path: string;
  timestamp: string;
  auto: boolean;
} | null> {
  for (const port of ports) {
    try {
      // Very short timeout — we don't want to hang the handoff process
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1500);

      const response = await fetch(`http://localhost:${port}`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const html = await response.text();

        // Ensure vault exists
        const mediaDir = path.join(os.homedir(), ".prism-mcp", "media", project);
        if (!fs.existsSync(mediaDir)) {
          fs.mkdirSync(mediaDir, { recursive: true });
        }

        const snapshotId = randomUUID().slice(0, 8);
        const filename = `auto_${snapshotId}.html`;
        const vaultPath = path.join(mediaDir, filename);

        await fs.promises.writeFile(vaultPath, html, "utf8");

        const sizeKB = (Buffer.byteLength(html, "utf8") / 1024).toFixed(1);
        console.error(
          `[AutoCapture] Saved HTML snapshot from port ${port} (${sizeKB}KB) → ${vaultPath}`
        );

        return {
          id: `auto_${snapshotId}`,
          description: `Auto-captured HTML state from localhost:${port}`,
          filename,
          original_path: `http://localhost:${port}`,
          timestamp: new Date().toISOString(),
          auto: true,
        };
      }
    } catch {
      // Expected if no server is running on this port — silently check next
      continue;
    }
  }

  // No dev servers were running — totally fine, return null
  return null;
}
