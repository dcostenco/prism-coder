/**
 * Cross-platform memory estimate, cached for one second.
 * On macOS, vm_stat's printed free count excludes speculative pages.
 * Add inactive pages as an estimate only: they may include anonymous memory
 * that cannot be reclaimed promptly. Purgeable pages can overlap inactive
 * pages and must not be added again. This is not Linux MemAvailable or a
 * guarantee that a model will fit. Other platforms/errors use os.freemem().
 */

import * as os from "os";
import { execSync } from "child_process";

let cache: { ts: number; bytes: number } | null = null;
const TTL_MS = 1000;

const COUNTER_LABELS = ["Pages free", "Pages inactive", "Pages speculative"];
const HEADER_PATTERN = /^Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)$/;

/** Parse one complete snapshot. A valid zero must not trigger a fallback. */
export function parseDarwinMemoryEstimate(output: string): number | null {
    const lines = output.split(/\r?\n/).map(line => line.trim());
    const headers = lines.filter(line => line.startsWith("Mach Virtual Memory Statistics:"));
    if (headers.length !== 1) return null;
    const header = headers[0].match(HEADER_PATTERN);
    if (!header) return null;
    const pageSize = Number(header[1]);
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
    let pages = 0;
    for (const label of COUNTER_LABELS) {
        const matches = lines.filter(line => line.startsWith(label + ":"));
        if (matches.length !== 1) return null;
        const match = matches[0].slice(label.length + 1).trim().match(/^([0-9]+)\.$/);
        if (!match) return null;
        const value = Number(match[1]);
        if (!Number.isSafeInteger(value)) return null;
        pages += value;
        if (!Number.isSafeInteger(pages)) return null;
    }
    const bytes = pages * pageSize;
    return Number.isSafeInteger(bytes) ? bytes : null;
}

function darwinAvailable(): number | null {
    try {
        return parseDarwinMemoryEstimate(execSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000 }));
    } catch {
        return null;
    }
}

/**
 * Returns an advisory estimate in bytes. Runtime resource gates still apply.
 * On macOS uses one vm_stat snapshot; elsewhere uses os.freemem(). Cached 1 s.
 */
export function getAvailableMemoryBytes(): number {
    const now = Date.now();
    if (cache && now - cache.ts < TTL_MS) return cache.bytes;

    let bytes: number;
    if (process.platform === "darwin") {
        bytes = darwinAvailable() ?? os.freemem();
    } else {
        bytes = os.freemem();
    }
    cache = { ts: now, bytes };
    return bytes;
}

/** Test-only. */
export function _resetAvailableMemoryCacheForTest(): void {
    cache = null;
}
