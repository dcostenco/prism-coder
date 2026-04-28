/**
 * v12.4: Memory Attestation — SHA-256 Merkle Tree
 *
 * Provides cryptographic proof of memory integrity.
 * Builds a Merkle tree from session entries, enabling:
 *   - Tamper detection on individual entries
 *   - Provable audit trail for compliance
 *   - Efficient partial verification
 */

import { createHash } from "node:crypto";
import { debugLog } from "./logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface MerkleNode {
    hash: string;
    left?: MerkleNode;
    right?: MerkleNode;
    entryId?: string; // Only on leaf nodes
    depth: number;
}

export interface MerkleProof {
    entryId: string;
    entryHash: string;
    proof: ProofStep[];
    root: string;
    verified: boolean;
}

export interface ProofStep {
    hash: string;
    position: "left" | "right";
}

export interface AttestationReport {
    root: string;
    entryCount: number;
    treeDepth: number;
    generatedAt: string;
    project: string;
    entries: Array<{ id: string; hash: string }>;
}

// ─── Hashing ─────────────────────────────────────────────────

/**
 * SHA-256 hash of a string.
 */
export function sha256(data: string): string {
    return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Hash two child hashes into a parent hash.
 */
export function hashPair(left: string, right: string): string {
    return sha256(left + right);
}

/**
 * Hash a memory entry's content for use as a leaf node.
 */
export function hashEntry(entryId: string, content: string, timestamp: string): string {
    return sha256(`${entryId}:${content}:${timestamp}`);
}

// ─── Merkle Tree Construction ────────────────────────────────

/**
 * Build a Merkle tree from leaf hashes.
 */
export function buildMerkleTree(
    entries: Array<{ id: string; hash: string }>,
): MerkleNode | null {
    if (entries.length === 0) return null;

    // Create leaf nodes
    let nodes: MerkleNode[] = entries.map(e => ({
        hash: e.hash,
        entryId: e.id,
        depth: 0,
    }));

    // If odd number of leaves, duplicate the last one
    if (nodes.length % 2 !== 0) {
        nodes.push({ ...nodes[nodes.length - 1] });
    }

    let depth = 0;

    // Build tree bottom-up
    while (nodes.length > 1) {
        depth++;
        const next: MerkleNode[] = [];

        for (let i = 0; i < nodes.length; i += 2) {
            const left = nodes[i];
            const right = nodes[i + 1] || left; // Duplicate last if odd

            next.push({
                hash: hashPair(left.hash, right.hash),
                left,
                right,
                depth,
            });
        }

        nodes = next;
    }

    return nodes[0];
}

/**
 * Get the Merkle root hash.
 */
export function getMerkleRoot(
    entries: Array<{ id: string; hash: string }>,
): string {
    const tree = buildMerkleTree(entries);
    return tree?.hash || sha256("empty");
}

// ─── Proof Generation & Verification ─────────────────────────

/**
 * Generate a Merkle proof for a specific entry.
 */
export function generateProof(
    entries: Array<{ id: string; hash: string }>,
    targetEntryId: string,
): MerkleProof | null {
    const targetIdx = entries.findIndex(e => e.id === targetEntryId);
    if (targetIdx === -1) return null;

    // Pad to even length
    const padded = [...entries];
    if (padded.length % 2 !== 0) {
        padded.push({ ...padded[padded.length - 1] });
    }

    const proof: ProofStep[] = [];
    let idx = targetIdx;
    let currentLevel = padded.map(e => e.hash);

    while (currentLevel.length > 1) {
        const nextLevel: string[] = [];
        const siblingIdx = idx % 2 === 0 ? idx + 1 : idx - 1;

        if (siblingIdx < currentLevel.length) {
            proof.push({
                hash: currentLevel[siblingIdx],
                position: idx % 2 === 0 ? "right" : "left",
            });
        }

        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = currentLevel[i + 1] || left;
            nextLevel.push(hashPair(left, right));
        }

        idx = Math.floor(idx / 2);
        currentLevel = nextLevel;
    }

    const root = currentLevel[0];
    const entryHash = entries[targetIdx].hash;

    return {
        entryId: targetEntryId,
        entryHash,
        proof,
        root,
        verified: verifyProof(entryHash, proof, root),
    };
}

/**
 * Verify a Merkle proof.
 */
export function verifyProof(
    entryHash: string,
    proof: ProofStep[],
    expectedRoot: string,
): boolean {
    let currentHash = entryHash;

    for (const step of proof) {
        if (step.position === "right") {
            currentHash = hashPair(currentHash, step.hash);
        } else {
            currentHash = hashPair(step.hash, currentHash);
        }
    }

    return currentHash === expectedRoot;
}

// ─── Attestation Report ──────────────────────────────────────

/**
 * Generate a full attestation report for a project's memory.
 */
export function generateAttestationReport(
    project: string,
    entries: Array<{ id: string; content: string; timestamp: string }>,
): AttestationReport {
    const hashedEntries = entries.map(e => ({
        id: e.id,
        hash: hashEntry(e.id, e.content, e.timestamp),
    }));

    const tree = buildMerkleTree(hashedEntries);

    const report: AttestationReport = {
        root: tree?.hash || sha256("empty"),
        entryCount: entries.length,
        treeDepth: tree?.depth || 0,
        generatedAt: new Date().toISOString(),
        project,
        entries: hashedEntries,
    };

    debugLog(`Attestation: Generated report for '${project}' — ${entries.length} entries, root: ${report.root.slice(0, 16)}...`);
    return report;
}

/**
 * Verify that a single entry hasn't been tampered with.
 */
export function verifyEntry(
    entryId: string,
    content: string,
    timestamp: string,
    report: AttestationReport,
): boolean {
    const expectedHash = hashEntry(entryId, content, timestamp);
    const storedEntry = report.entries.find(e => e.id === entryId);

    if (!storedEntry) return false;
    return storedEntry.hash === expectedHash;
}

debugLog("v12.4: Memory attestation (Merkle tree) loaded");
