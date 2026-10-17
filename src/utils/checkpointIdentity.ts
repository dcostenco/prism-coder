/** Bounded read-only artifact identity, not serving/cancellation qualification. */
import { constants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MAX_MANIFEST_BYTES = 1024 ** 2;
const MAX_METADATA_BYTES = 1024 ** 2;
const MAX_HEADER_BYTES = 4 * 1024 ** 2;
const READ_CHUNK_BYTES = 1024 ** 2;
const MAX_BUDGET_MS = 90 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}\/[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const REVISION = /^[a-f0-9]{40}$/;
const REQUIRED_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const LOADABLE_EXTENSION = /\.(?:safetensors|json|jinja|py|bin|pt|pkl|so|dylib|model|tiktoken)$/i;
const WEIGHT_EXTENSION = /\.safetensors$/i;
const DTYPE_BYTES: Readonly<Record<string, number>> = Object.freeze({ BOOL: 1, I8: 1, U8: 1, I16: 2, U16: 2, I32: 4, U32: 4,
    I64: 8, U64: 8, F16: 2, BF16: 2, F32: 4, F64: 8, F8_E4M3: 1, F8_E5M2: 1 });
const AFFINE_BITS = [2, 3, 4, 5, 6, 8];
const QUANT_MODES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({ mxfp4: [32, 4], nvfp4: [16, 4], mxfp8: [32, 8] });
const QUANT_FIELDS = ["bits", "group_size", "mode"];
type ArtifactFile = { name: string; source_name: string; bytes: number; sha256: string };
type Manifest = { version: 1; source_repository: string; source_revision: string; logical_model: string;
    model_type: string; format: "mlx" | "safetensors"; files: ArtifactFile[] };
export interface CheckpointOptions { root: string; manifestJson: string; pinnedManifestSha256: string; budgetMs?: number; signal?: AbortSignal }
const digest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const exact = (value: any, fields: readonly string[]): boolean => !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(key => Object.hasOwn(value, key));
const stamp = (s: any) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String).join(":");
function invalid(): never { throw new Error("checkpoint_identity_invalid"); }
function quantizationDeclaration(value: any): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isInteger(value.bits) || !Number.isInteger(value.group_size)) return false;
    const mode = value.mode === undefined ? "affine" : value.mode;
    if (mode === "affine") return AFFINE_BITS.includes(value.bits) && [32, 64, 128].includes(value.group_size);
    return typeof mode === "string" && Object.hasOwn(QUANT_MODES, mode) && QUANT_MODES[mode][0] === value.group_size && QUANT_MODES[mode][1] === value.bits;
}
function jsonBytes(bytes: Buffer): any {
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { invalid(); }
}

/** `pinnedManifestSha256` belongs to trusted operator configuration, never a
 * sibling caller-editable checksum or public MCP argument. No file is executed. */
export async function verifyCheckpoint(options: CheckpointOptions) {
    const started = performance.now(), budget = options.budgetMs ?? MAX_BUDGET_MS;
    if (!Number.isInteger(budget) || budget < 1 || budget > MAX_BUDGET_MS) invalid();
    const check = () => {
        if (options.signal?.aborted || performance.now() - started >= budget) throw new Error("checkpoint_identity_stopped");
    };
    check();
    if (typeof options.manifestJson !== "string" || Buffer.byteLength(options.manifestJson) > MAX_MANIFEST_BYTES
        || typeof options.pinnedManifestSha256 !== "string" || !SHA256.test(options.pinnedManifestSha256)
        || digest(options.manifestJson) !== options.pinnedManifestSha256) invalid();
    let m: Manifest;
    try { m = JSON.parse(options.manifestJson); } catch { invalid(); }
    if (!exact(m, ["version", "source_repository", "source_revision", "logical_model", "model_type", "format", "files"])
        || m.version !== 1 || typeof m.source_repository !== "string" || !REPOSITORY.test(m.source_repository)
        || typeof m.source_revision !== "string" || !REVISION.test(m.source_revision)
        || !["2b", "4b", "9b", "27b", "Flash-Next"].includes(m.logical_model)
        || typeof m.model_type !== "string" || !NAME.test(m.model_type) || !["mlx", "safetensors"].includes(m.format)
        || !Array.isArray(m.files) || m.files.length < 4 || m.files.length > 2048) invalid();
    const names = new Set<string>(), sources = new Set<string>();
    for (const f of m.files) {
        if (!exact(f, ["name", "source_name", "bytes", "sha256"]) || typeof f.name !== "string" || !NAME.test(f.name)
            || typeof f.source_name !== "string" || !NAME.test(f.source_name) || !Number.isSafeInteger(f.bytes) || f.bytes < 1
            || typeof f.sha256 !== "string" || !SHA256.test(f.sha256) || names.has(f.name.toLowerCase()) || sources.has(f.source_name.toLowerCase())) invalid();
        names.add(f.name.toLowerCase()); sources.add(f.source_name.toLowerCase());
    }
    if (!REQUIRED_FILES.every(name => names.has(name))) invalid();
    const weights = m.files.filter(f => WEIGHT_EXTENSION.test(f.name));
    if (!weights.length || (weights.length > 1 && !names.has("model.safetensors.index.json"))) invalid();
    for (const f of m.files.filter(f => ["config.json", "tokenizer_config.json", "model.safetensors.index.json"].includes(f.name.toLowerCase()))) {
        if (f.bytes > MAX_METADATA_BYTES) invalid();
    }
    check();
    const root = await realpath(options.root); check();
    const rootBefore = await stat(root, { bigint: true }); check();
    if (!rootBefore.isDirectory()) invalid();
    const verifyInventory = async () => {
        const listed = (await readdir(root)).filter(name => LOADABLE_EXTENSION.test(name)).sort(); check();
        if (JSON.stringify(listed) !== JSON.stringify(m.files.filter(f => LOADABLE_EXTENSION.test(f.name)).map(f => f.name).sort())) invalid();
    };
    await verifyInventory();
    const tensorOwners = new Map<string, string>(), fileStamps: { name: string; stamp: string }[] = [];
    let config: any, index: any;
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    for (const f of m.files) {
        check();
        const metadataName = f.name.toLowerCase();
        const path = join(root, f.name);
        const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
            check();
            const before = await fd.stat({ bigint: true }); check();
            if (!before.isFile() || before.size !== BigInt(f.bytes)) invalid();
            if (WEIGHT_EXTENSION.test(f.name)) {
                const prefix = Buffer.alloc(8);
                const prefixRead = await fd.read(prefix, 0, 8, 0); check();
                if (prefixRead.bytesRead !== 8) invalid();
                const length = prefix.readBigUInt64LE();
                if (length < 2 || length > BigInt(MAX_HEADER_BYTES) || length + 8n > before.size) invalid();
                const header = Buffer.alloc(Number(length));
                const headerRead = await fd.read(header, 0, header.length, 8); check();
                if (headerRead.bytesRead !== header.length) invalid();
                const tensors = jsonBytes(header);
                if (!tensors || typeof tensors !== "object" || Array.isArray(tensors)) invalid();
                const intervals: [number, number][] = [];
                for (const [name, raw] of Object.entries(tensors)) {
                    if (name === "__metadata__") {
                        if (!raw || typeof raw !== "object" || Array.isArray(raw) || !Object.values(raw).every(v => typeof v === "string")) invalid();
                        continue;
                    }
                    const t = raw as any;
                    if (!exact(t, ["dtype", "shape", "data_offsets"]) || typeof t.dtype !== "string" || !Object.hasOwn(DTYPE_BYTES, t.dtype)
                        || !Array.isArray(t.shape) || t.shape.length > 32 || !t.shape.every((n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0)
                        || !Array.isArray(t.data_offsets) || t.data_offsets.length !== 2 || !t.data_offsets.every(Number.isSafeInteger)
                        || t.data_offsets[0] < 0 || t.data_offsets[1] < t.data_offsets[0]
                        || BigInt(t.data_offsets[1]) > before.size - length - 8n || tensorOwners.has(name)) invalid();
                    const bytes = t.shape.reduce((n: bigint, dim: number) => n * BigInt(dim), BigInt(DTYPE_BYTES[t.dtype]));
                    if (bytes !== BigInt(t.data_offsets[1] - t.data_offsets[0])) invalid();
                    intervals.push(t.data_offsets); tensorOwners.set(name, f.name);
                }
                intervals.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
                let end = 0;
                for (const [start, next] of intervals) { if (start !== end) invalid(); end = next; }
                if (BigInt(end) !== before.size - length - 8n) invalid();
            }
            const hash = createHash("sha256"), metadata: Buffer[] = [];
            let position = 0;
            while (position < f.bytes) {
                check();
                const read = await fd.read(chunk, 0, Math.min(chunk.length, f.bytes - position), position); check();
                if (!read.bytesRead) invalid();
                const bytes = chunk.subarray(0, read.bytesRead); hash.update(bytes);
                if (metadataName === "config.json" || metadataName === "model.safetensors.index.json") metadata.push(Buffer.from(bytes));
                position += read.bytesRead;
            }
            if (hash.digest("hex") !== f.sha256) invalid();
            const after = await fd.stat({ bigint: true }); check();
            const current = await lstat(path, { bigint: true }); check();
            if (!current.isFile()) invalid();
            if (stamp(before) !== stamp(after) || stamp(after) !== stamp(current)) invalid();
            fileStamps.push({ name: f.name, stamp: stamp(after) });
            if (metadata.length) {
                const parsed = jsonBytes(Buffer.concat(metadata));
                if (metadataName === "config.json") config = parsed; else index = parsed;
            }
        } finally { await fd.close(); }
    }
    check();
    if (!config || config.model_type !== m.model_type || (m.format === "mlx" && (!quantizationDeclaration(config.quantization)
        || Object.entries(config.quantization).some(([key, value]) => !QUANT_FIELDS.includes(key)
            && (!quantizationDeclaration(value) || Object.keys(value as object).some(key => !QUANT_FIELDS.includes(key))))))) invalid();
    if (index !== undefined) {
        if (!index || !index.weight_map || typeof index.weight_map !== "object" || Array.isArray(index.weight_map)
            || Object.keys(index.weight_map).length !== tensorOwners.size
            || ![...tensorOwners].every(([name, file]) => index.weight_map[name] === file)) invalid();
    }
    await verifyInventory();
    for (const file of fileStamps) {
        const current = await lstat(join(root, file.name), { bigint: true }); check();
        if (!current.isFile() || stamp(current) !== file.stamp) invalid();
    }
    const rootAfter = await stat(root, { bigint: true }); check();
    if (stamp(rootBefore) !== stamp(rootAfter)) invalid();
    return { status: "verified_artifact" as const, source_repository: m.source_repository, source_revision: m.source_revision,
        logical_model: m.logical_model, model_type: m.model_type, format: m.format, files_count: m.files.length,
        weight_bytes: weights.reduce((total, f) => total + f.bytes, 0), checkpoint_sha256: options.pinnedManifestSha256,
        file_stamps: fileStamps, generation_enabled: false as const, serving_qualified: false as const,
        evidence_scope: "physical_artifact_hashes_only" as const };
}
