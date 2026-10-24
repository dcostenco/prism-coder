import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", () => ({ execSync: vi.fn() }));
vi.mock("os", () => ({ freemem: vi.fn(() => 123) }));
import { execSync } from "child_process";
import { freemem } from "os";

const snapshot = (free = "10", inactive = "100", speculative = "20", purgeable = "100") =>
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${free}.\nPages inactive: ${inactive}.\nPages speculative: ${speculative}.\nPages purgeable: ${purgeable}.\n`;

describe("available memory estimate", () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        vi.stubGlobal("process", { ...process, platform: "darwin" });
        vi.spyOn(Date, "now").mockReturnValue(10000);
        vi.mocked(execSync).mockReturnValue(snapshot());
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    it("does not count purgeable pages again when they overlap inactive pages", async () => {
        const memory = await import("../../src/utils/availableMemory.js");
        expect(memory.getAvailableMemoryBytes()).toBe(130 * 16384);
    });

    it("counts speculative pages once from printed vm_stat free and accepts zero", async () => {
        const { parseDarwinMemoryEstimate: parse } = await import("../../src/utils/availableMemory.js");
        expect(parse(snapshot("0", "0", "3"))).toBe(3 * 16384);
        expect(parse(snapshot("0", "0", "0"))).toBe(0);
        expect(parse(snapshot().replaceAll("\n", "\r\n"))).toBe(130 * 16384);
        expect(parse(snapshot().replace("16384", "4096"))).toBe(130 * 4096);
    });

    it.each([
        snapshot().replace(/^.*\n/, ""),
        snapshot().replace("16384", "0"),
        snapshot().replace("16384", "9007199254740992"),
        snapshot().replace("Pages inactive: 100.\n", ""),
        snapshot() + "Pages free: 999.\n",
        snapshot() + snapshot(),
        ...["-1", "1.5", "1e3", "NaN", "1junk", "9007199254740992"].map(value => snapshot(value)),
        snapshot("9007199254740991", "1", "0"),
        snapshot("9007199254740991", "0", "0"),
    ])("rejects incomplete, duplicate, malformed or unsafe snapshots: %s", async value => {
        const { parseDarwinMemoryEstimate: parse } = await import("../../src/utils/availableMemory.js");
        expect(parse(value)).toBeNull();
    });

    it("falls back on malformed input and command errors, with the existing one second cache", async () => {
        const { getAvailableMemoryBytes: read } = await import("../../src/utils/availableMemory.js");
        vi.mocked(execSync).mockReturnValue("Pages free: 99.");
        expect(read()).toBe(123);
        vi.mocked(execSync).mockReturnValue(snapshot());
        expect(read()).toBe(123);
        expect(execSync).toHaveBeenCalledTimes(1);
        vi.mocked(Date.now).mockReturnValue(11000);
        expect(read()).toBe(130 * 16384);
        vi.mocked(Date.now).mockReturnValue(12000);
        vi.mocked(execSync).mockImplementation(() => { throw new Error("unavailable"); });
        expect(read()).toBe(123);
    });

    it("keeps a valid zero without falling back to a larger number", async () => {
        vi.mocked(execSync).mockReturnValue(snapshot("0", "0", "0"));
        const { getAvailableMemoryBytes: read } = await import("../../src/utils/availableMemory.js");
        expect(read()).toBe(0);
        expect(freemem).not.toHaveBeenCalled();
    });

    it("preserves the non-macOS path", async () => {
        vi.stubGlobal("process", { ...process, platform: "linux" });
        const { getAvailableMemoryBytes: read } = await import("../../src/utils/availableMemory.js");
        expect(read()).toBe(123);
        expect(execSync).not.toHaveBeenCalled();
    });
});
