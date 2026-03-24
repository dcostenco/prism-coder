/**
 * Server Lifecycle Management
 * Handles singleton PID locking, graceful shutdown, and SQLite handle cleanup.
 *
 * CRITICAL: All logging MUST use console.error() (stderr).
 * Using console.log() (stdout) will corrupt the MCP JSON-RPC stream.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { execSync } from "child_process";
import { closeConfigStorage } from "./storage/configStorage.js";
import { getStorage } from "./storage/index.js";

const PRISM_DIR = path.join(os.homedir(), ".prism-mcp");
const PID_FILE = path.join(PRISM_DIR, "server.pid");

function log(msg: string) {
  console.error(`[Prism Lifecycle] ${msg}`);
}

/**
 * Checks if a process is an orphan (adopted by init/launchd, PPID=1).
 * Returns false on Windows (PID logic is different there).
 */
function isOrphanProcess(pid: number): boolean {
  if (process.platform === "win32") {
    // Windows doesn't have reliable PPID checks via 'ps'. 
    // Safer to assume it's NOT an orphan to avoid killing valid instances.
    return false;
  }

  try {
    // 'ps -o ppid= -p PID' returns just the parent PID
    const ppid = execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8" }).trim();
    return ppid === "1";
  } catch {
    // If ps fails (e.g. process gone), assume it's safe to claim
    return true;
  }
}

/**
 * Ensures valid server execution state.
 * 
 * LOGIC:
 * 1. If --no-lock is passed, skip everything (testing mode).
 * 2. If PID file exists:
 *    - If process is dead: Overwrite lock.
 *    - If process is alive AND is an orphan (PPID=1): Kill it (Zombie), then overwrite.
 *    - If process is alive AND has a parent: Log warning, allow coexistence (don't kill).
 */
export function acquireLock() {
  if (process.argv.includes("--no-lock")) {
    log("Lock acquisition skipped (--no-lock flag)");
    return;
  }

  if (!fs.existsSync(PRISM_DIR)) {
    fs.mkdirSync(PRISM_DIR, { recursive: true });
  }

  if (fs.existsSync(PID_FILE)) {
    try {
      const oldPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
      
      if (oldPid && oldPid !== process.pid) {
        let isAlive = false;
        try {
          process.kill(oldPid, 0); // 0 signal checks for existence
          isAlive = true;
        } catch {
          isAlive = false;
        }

        if (isAlive) {
          // Process exists. Is it a zombie?
          if (isOrphanProcess(oldPid)) {
            log(`Found zombie process (PID ${oldPid}, PPID=1). Terminating...`);
            try {
              process.kill(oldPid, "SIGTERM");
              // Give it 100ms to die, then force kill if needed
              setTimeout(() => {
                try { process.kill(oldPid, "SIGKILL"); } catch {}
              }, 100);
            } catch (e) {
              log(`Failed to kill zombie: ${e}`);
            }
          } else {
            // It has a parent (e.g., another VS Code window or Claude Desktop)
            log(`Existing server (PID ${oldPid}) is active and managed. Coexisting...`);
            // We do NOT overwrite the PID file here. 
            // If we overwrite it, the *active* server will fail to clean up 
            // the PID file when it eventually shuts down.
            return; 
          }
        }
      }
    } catch (err) {
      log(`Warning: Failed to process existing PID file: ${err}`);
    }
  }

  // Claim the lock for this process
  try {
    fs.writeFileSync(PID_FILE, process.pid.toString(), "utf8");
    log(`Acquired singleton lock (PID ${process.pid})`);
  } catch (err) {
    log(`Warning: Failed to write PID file: ${err}`);
  }
}

/**
 * Registers handlers to close SQLite file handles cleanly when the server stops.
 */
export function registerShutdownHandlers() {
  let shuttingDown = false;

  const shutdown = async (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down gracefully (${reason})...`);

    try {
      // 1. Close system settings DB
      closeConfigStorage();

      // 2. Close main ledger DB
      const storage = await getStorage();
      if (storage && typeof storage.close === "function") {
        await storage.close();
      }

      // 3. Remove PID lockfile (only if WE own it)
      if (fs.existsSync(PID_FILE)) {
        try {
          const storedPid = parseInt(fs.readFileSync(PID_FILE, "utf8").trim(), 10);
          if (storedPid === process.pid) {
            fs.unlinkSync(PID_FILE);
          }
        } catch {
          // Ignore read errors during shutdown
        }
      }
    } catch (err) {
      log(`Error during shutdown cleanup: ${err}`);
    } finally {
      process.exit(0);
    }
  };

  // OS Signals
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // MCP Client Disconnect (CRITICAL)
  process.stdin.on("close", () => {
    shutdown("CLIENT_DISCONNECTED_STDIN_CLOSED");
  });
}
