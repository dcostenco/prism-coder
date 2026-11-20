/**
 * Cross-platform memory estimates, cached for one second.
 * Cold-load admission uses free plus file-backed pages on macOS. Reporting
 * uses free plus inactive pages, like oMLX's macOS availability estimate.
 * Inactive and file-backed counts can overlap. Neither estimate adds purgeable,
 * speculative or resident model bytes on top. Other platforms use os.freemem().
 */

import * as os from "os";
import { execSync } from "child_process";

type DarwinCounter = "File-backed pages" | "Pages inactive";
const cache = new Map<DarwinCounter, { ts: number; bytes: number }>();
const TTL_MS = 1000;

const HEADER_PATTERN = /^Mach Virtual Memory Statistics: \(page size of ([0-9]+) bytes\)$/;

/** Parse one complete snapshot. A valid zero must not trigger a fallback. */
function parseDarwinEstimate(output: string, counter: DarwinCounter): number | null {
    const lines = output.split(/\r?\n/).map(line => line.trim());
    const headers = lines.filter(line => line.startsWith("Mach Virtual Memory Statistics:"));
    if (headers.length !== 1) return null;
    const header = headers[0].match(HEADER_PATTERN);
    if (!header) return null;
    const pageSize = Number(header[1]);
    if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
    let pages = 0;
    for (const label of ["Pages free", counter]) {
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

/** Conservative input to the existing automatic cold-load gates. */
export function parseDarwinMemoryEstimate(output: string): number | null {
    return parseDarwinEstimate(output, "File-backed pages");
}

/** Reclaimable host memory for advisory reporting. */
export function parseDarwinReclaimableMemoryEstimate(output: string): number | null {
    return parseDarwinEstimate(output, "Pages inactive");
}

function darwinAvailable(counter: DarwinCounter): number | null {
    try {
        return parseDarwinEstimate(execSync("/usr/bin/vm_stat", { encoding: "utf8", timeout: 1000 }), counter);
    } catch {
        return null;
    }
}

/**
 * Returns an advisory estimate in bytes. Runtime resource gates still apply.
 * On macOS uses one vm_stat snapshot; elsewhere uses os.freemem(). Cached 1 s.
 */
function getMemoryEstimate(counter: DarwinCounter): number {
    const now = Date.now();
    const cached = cache.get(counter);
    if (cached && now - cached.ts < TTL_MS) return cached.bytes;

    let bytes: number;
    if (process.platform === "darwin") {
        bytes = darwinAvailable(counter) ?? os.freemem();
    } else {
        bytes = os.freemem();
    }
    cache.set(counter, { ts: now, bytes });
    return bytes;
}

export function getAvailableMemoryBytes(): number {
    return getMemoryEstimate("File-backed pages");
}

export function getReclaimableMemoryBytes(): number {
    return getMemoryEstimate("Pages inactive");
}

/** Test-only. */
export function _resetAvailableMemoryCacheForTest(): void {
    cache.clear();
}
