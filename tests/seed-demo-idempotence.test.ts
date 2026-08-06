/**
 * Idempotence of the first-run demo seed.
 *
 * The first_bootstrap_at marker is check-then-set, so two hosts bootstrapping
 * a fresh machine simultaneously BOTH take the first-run branch — several
 * concurrent agent sessions on one machine is a real setup, not a corner
 * case. The seed must therefore be safe to run twice: the second caller must
 * render the existing row, not insert a duplicate.
 *
 * The true concurrent read-read window cannot be pinned deterministically in
 * a test; what CAN be pinned is the sequential contract that closes most of
 * it: "a demo row already exists → do not insert another".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const saveLedger = vi.fn().mockResolvedValue(undefined);
const getLedgerEntries = vi.fn();

vi.mock("../src/storage/index.js", () => ({
  getStorage: vi.fn(async () => ({ saveLedger, getLedgerEntries })),
  activeStorageBackend: () => "sqlite",
}));

import { seedAndRecallDemoMemory } from "../src/tools/ledgerHandlers.js";

describe("first-run demo seed idempotence", () => {
  beforeEach(() => {
    saveLedger.mockClear();
    getLedgerEntries.mockReset();
  });

  it("inserts and renders when no demo row exists", async () => {
    // First call: existence probe finds nothing, read-back finds the insert.
    getLedgerEntries
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ summary: "Prism saved this memory during your first session to demonstrate recall.", todos: ["t"] }]);

    const block = await seedAndRecallDemoMemory("conv-1");
    expect(saveLedger).toHaveBeenCalledTimes(1);
    expect(block).toContain("recalled it from disk");
  });

  it("does NOT insert a second row when one already exists — and still renders it", async () => {
    const row = { summary: "Prism saved this memory during your first session to demonstrate recall.", todos: [] };
    getLedgerEntries.mockResolvedValue([row]);

    const block = await seedAndRecallDemoMemory("conv-2");
    expect(saveLedger).not.toHaveBeenCalled();
    // The losing racer still shows the winner's row — one demo either way.
    expect(block).toContain("recalled it from disk");
  });

  it("returns null instead of throwing when storage fails", async () => {
    getLedgerEntries.mockRejectedValue(new Error("disk on fire"));
    await expect(seedAndRecallDemoMemory("conv-3")).resolves.toBeNull();
  });
});
