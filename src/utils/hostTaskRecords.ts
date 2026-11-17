/** Hash-only, owner-local preparation records. These records alone never authorize MCP execution. */
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

export type HostTaskKind = "prism_infer" | "query_memory_natural";
export interface HostTaskRecord {
    version: 1; id: string; kind: HostTaskKind;
    request_sha256: string; task_sha256: string; environment_sha256: string;
    created_at: number; expires_at: number;
}
export const HOST_TASK_TTL_MS = 300_000;
const MAX_RECORD_BYTES = 4096, MAX_PENDING = 256;
const ID = /^[a-f0-9]{48}$/, DIGEST = /^[a-f0-9]{64}$/;
interface Options { directory: string; now?: () => number }
type Binding = Pick<HostTaskRecord, "kind" | "request_sha256" | "task_sha256" | "environment_sha256">;
const fail = (): never => { throw new Error("host_task_record_invalid"); };
function uid(): number { const value = process.getuid?.(); return value === undefined ? fail() : value; }
function validate(value: unknown): asserts value is HostTaskRecord {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail();
    const r = value as HostTaskRecord;
    if (Object.keys(r).sort().join(",") !== "created_at,environment_sha256,expires_at,id,kind,request_sha256,task_sha256,version"
        || r.version !== 1 || !ID.test(r.id) || !["prism_infer", "query_memory_natural"].includes(r.kind)
        || ![r.request_sha256, r.task_sha256, r.environment_sha256].every(x => typeof x === "string" && DIGEST.test(x))
        || !Number.isSafeInteger(r.created_at) || r.created_at < 0 || !Number.isSafeInteger(r.expires_at)
        || r.expires_at - r.created_at !== HOST_TASK_TTL_MS) fail();
}
function privateDirectory(path: string, create: boolean): void {
    if (create) mkdirSync(path, { recursive: true, mode: 0o700 });
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o700) fail();
}
function root(options: Options, create: boolean): void {
    const parent = dirname(options.directory);
    if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o022) !== 0) fail();
    privateDirectory(options.directory, create);
}
function read(path: string): HostTaskRecord {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size < 1 || stat.size > MAX_RECORD_BYTES) fail();
        const bytes = readFileSync(fd);
        if (bytes.length > MAX_RECORD_BYTES) fail();
        const text = bytes.toString("utf8"); if (!Buffer.from(text).equals(bytes)) fail();
        const value: unknown = JSON.parse(text); validate(value); return value;
    } finally { closeSync(fd); }
}
function same(a: HostTaskRecord, b: HostTaskRecord): boolean {
    return Object.keys(a).every(key => a[key as keyof HostTaskRecord] === b[key as keyof HostTaskRecord]);
}
function write(path: string, record: HostTaskRecord): void {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); }
    finally { closeSync(fd); }
}
function syncDirectory(path: string): void {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Only validated expired records created by this protocol are retired. */
function retireExpired(options: Options, now: number): number {
    let pending = 0;
    for (const name of readdirSync(options.directory)) {
        if (!/^[a-f0-9]{48}\.json$/.test(name)) continue;
        const path = join(options.directory, name);
        let record: HostTaskRecord;
        try { record = read(path); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
        if (record.id + ".json" !== name) fail();
        if (record.expires_at <= now) {
            const used = join(options.directory, record.id + ".used");
            try { const spent = read(used); if (!same(spent, record)) fail(); unlinkSync(used); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
            try { unlinkSync(path); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        } else pending++;
    }
    return pending;
}
export function createHostTaskRecord(binding: Binding, options: Options): HostTaskRecord {
    root(options, true);
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) fail();
    if (retireExpired(options, now) >= MAX_PENDING) throw new Error("host_task_pending_limit");
    const record: HostTaskRecord = { version: 1, id: randomBytes(24).toString("hex"), ...binding,
        created_at: now, expires_at: now + HOST_TASK_TTL_MS };
    validate(record); write(join(options.directory, record.id + ".json"), record); syncDirectory(options.directory);
    return record;
}
export function consumeHostTaskRecord(expected: HostTaskRecord, options: Options): void {
    validate(expected); root(options, false);
    const actual = read(join(options.directory, expected.id + ".json"));
    if (!same(actual, expected)) fail();
    const now = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < actual.created_at || now >= actual.expires_at) throw new Error("host_task_expired");
    try { write(join(options.directory, actual.id + ".used"), actual); syncDirectory(options.directory); }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("host_task_already_used");
        throw error;
    }
}
