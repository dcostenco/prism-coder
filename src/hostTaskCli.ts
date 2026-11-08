import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { executeApprovedHostTask, MAX_HOST_TASK_BYTES } from "./utils/hostTasks.js";

/** JSON.parse validates syntax first; this scan rejects ambiguous duplicate keys. */
function rejectDuplicateKeys(text: string): void {
    const stack: Array<{ object: boolean; key: boolean; seen: Set<string> }> = [];
    for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)) {
        const token = match[0];
        if (token === "{" || token === "[") {
            if (stack.length >= 100) throw new Error("host_task_too_deep");
            stack.push({ object: token === "{", key: token === "{", seen: new Set() });
        } else if (token === "}" || token === "]") stack.pop();
        else {
            const top = stack.at(-1);
            if (token === "," && top?.object) top.key = true;
            if (token.startsWith('"') && top?.object && top.key) {
                const key: string = JSON.parse(token);
                if (top.seen.has(key)) throw new Error("host_task_duplicate_key");
                top.seen.add(key); top.key = false;
            }
        }
    }
}

/** Read a host-owned packet without following symlinks or accepting extra stream bytes. */
export async function readHostTaskInput(file: string, stdin: AsyncIterable<Uint8Array> = process.stdin): Promise<unknown> {
    let bytes: Buffer;
    if (file === "-") {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of stdin) {
            const value = Buffer.from(chunk); size += value.length;
            if (size > MAX_HOST_TASK_BYTES) throw new Error("host_task_too_large");
            chunks.push(value);
        }
        bytes = Buffer.concat(chunks);
    } else {
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            const stat = fstatSync(fd), uid = process.getuid?.();
            if (uid === undefined || !stat.isFile() || stat.uid !== uid || (stat.mode & 0o077) !== 0 || stat.nlink !== 1
                || stat.size < 1 || stat.size > MAX_HOST_TASK_BYTES) throw new Error("host_task_unsafe_input_file");
            const chunks: Buffer[] = []; let size = 0;
            for (;;) {
                const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_HOST_TASK_BYTES + 1 - size));
                const count = readSync(fd, chunk, 0, chunk.length, null);
                if (count === 0) break;
                size += count; if (size > MAX_HOST_TASK_BYTES) throw new Error("host_task_too_large");
                chunks.push(chunk.subarray(0, count));
            }
            bytes = Buffer.concat(chunks);
        } finally { closeSync(fd); }
    }
    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) throw new Error("host_task_invalid_utf8");
    let value: unknown;
    try { value = JSON.parse(text); }
    catch { throw new Error("host_task_invalid_json"); }
    rejectDuplicateKeys(text);
    return value;
}

export async function runHostTaskCli(file: string, approve: boolean): Promise<unknown> {
    if (!approve) throw new Error("host_review_required: review the full task and pass --approve only for permitted, resolved work");
    const input = await readHostTaskInput(file);
    return executeApprovedHostTask(input, async (kind, request) => {
        if (kind === "prism_infer") {
            const { prismInferHandler } = await import("./tools/prismInferHandler.js");
            return prismInferHandler(request);
        }
        const { queryMemoryNaturalHandler } = await import("./tools/queryMemoryNaturalHandler.js");
        return queryMemoryNaturalHandler(request);
    });
}
