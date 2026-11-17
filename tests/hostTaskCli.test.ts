import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readHostTaskInput, runHostTaskCli } from "../src/hostTaskCli.js";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "prism-host-cli-")); });
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }); });
const source = async function* (bytes: Uint8Array) { yield bytes; };
describe("host CLI packet input", () => {
    it("requires explicit host review before reading a file or entering execution", async () => {
        await expect(runHostTaskCli(join(dir, "not-created.json"), false)).rejects.toThrow("host_review_required");
    });
    it("reads one exact private JSON packet from file or stdin", async () => {
        const text = '{"host_task":{"fixture":"unchanged bytes"}}';
        const file = join(dir, "packet.json"); writeFileSync(file, text, { mode: 0o600 });
        expect(await readHostTaskInput(file)).toEqual(JSON.parse(text));
        expect(await readHostTaskInput("-", source(Buffer.from(text)))).toEqual(JSON.parse(text));
    });
    it("rejects readable-by-others files and symlinks", async () => {
        const file = join(dir, "packet.json"); writeFileSync(file, "{}", { mode: 0o600 });
        chmodSync(file, 0o644); await expect(readHostTaskInput(file)).rejects.toThrow("unsafe_input_file");
        chmodSync(file, 0o600); const link = join(dir, "packet-link.json"); symlinkSync(file, link);
        await expect(readHostTaskInput(link)).rejects.toThrow();
    });
    it("refuses malformed JSON and code fences without echoing the private input", async () => {
        for (const text of ['{"private input":', '```json\n{}\n```', '{}\n{}']) {
            await expect(readHostTaskInput("-", source(Buffer.from(text)))).rejects.toThrow(/^host_task_invalid_json$/);
        }
    });
    it("refuses invalid UTF8 before parsing", async () => {
        await expect(readHostTaskInput("-", source(Buffer.from([0xff])))).rejects.toThrow("invalid_utf8");
    });
    it("refuses duplicate keys including escaped spellings while preserving strings as data", async () => {
        for (const text of ['{"prompt":"safe","prompt":"different"}', '{"task":{"prompt":"safe","pr\\u006fmpt":"different"}}']) {
            await expect(readHostTaskInput("-", source(Buffer.from(text)))).rejects.toThrow("host_task_duplicate_key");
        }
        const data = { rows: [{ prompt: "first" }, { prompt: "second" }], text: 'data contains "prompt": "value", not a field' };
        expect(await readHostTaskInput("-", source(Buffer.from(JSON.stringify(data))))).toEqual(data);
    });
});
