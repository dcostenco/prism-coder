/**
 * Production wiring for model convergence — real Ollama, real registry.
 *
 * Kept out of cli.ts so the pure logic (utils/modelConverge.ts) stays
 * testable with injected deps, and out of utils/ because this half owns
 * process spawning. `ollama pull` runs with inherited stdio deliberately:
 * a multi-GB download with no progress bar reads as a hang, and ollama's
 * own progress output is better than anything we would reimplement.
 *
 * Adversarial review 2026-08-18 (pre-20.14.0), two findings fixed here:
 *
 * 1. SPLIT-BRAIN DAEMON TARGETING: listTags read /api/tags from
 *    PRISM_LOCAL_LLM_URL while the spawned `ollama` CLI targeted whatever
 *    OLLAMA_HOST the user's shell had (default localhost). On a machine
 *    with a remote Ollama, convergence read tags from one daemon and
 *    pulled/re-aliased against another. The spawn env now pins OLLAMA_HOST
 *    to the SAME url the tags came from — one daemon, one truth.
 *
 * 2. SILENT MULTI-GB DOWNLOADS: connect gave no warning before pulling.
 *    Measured the day this shipped: the registry 27b had just changed
 *    bytes, so every 27b holder's first converge pulls ~16 GB. The plan
 *    is now announced up front, with the --no-models escape hatch named,
 *    before any network transfer starts.
 */
import { spawn } from "node:child_process";
import { convergeModels, type TierOutcome, MODEL_NAMESPACE, LOCAL_PREFIX, CONVERGE_TIERS } from "./utils/modelConverge.js";

const OLLAMA_URL = process.env.PRISM_LOCAL_LLM_URL || "http://localhost:11434";

/**
 * Env for spawned `ollama` processes. OLLAMA_HOST is pinned to the same
 * daemon /api/tags was read from — never the shell's ambient value — so
 * list, pull, and cp can never disagree about which Ollama they act on.
 * Exported for tests.
 */
export function convergeEnv(base: NodeJS.ProcessEnv, ollamaUrl: string = OLLAMA_URL): NodeJS.ProcessEnv {
    return { ...base, OLLAMA_HOST: ollamaUrl };
}

function runOllama(args: string[], inheritStdio: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("ollama", args, {
            stdio: inheritStdio ? "inherit" : "ignore",
            env: convergeEnv(process.env),
        });
        child.on("error", (err) => reject(new Error(`ollama ${args[0]}: ${err.message}`)));
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ollama ${args.join(" ")} exited ${code}`));
        });
    });
}

export async function runOllamaConverge(opts: { dryRun?: boolean } = {}): Promise<TierOutcome[]> {
    // Announce the plan BEFORE any network transfer: which tiers are
    // installed (and will be checked), that pulls can be large, and how to
    // opt out. A 16 GB download must never be the first sign convergence
    // is running.
    let installedTiers: string[] = [];
    try {
        const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
        if (res.ok) {
            const data = (await res.json()) as { models?: Array<{ name: string }> };
            const names = new Set((data.models ?? []).map((m) => m.name));
            installedTiers = CONVERGE_TIERS.filter(
                (t) => names.has(`${MODEL_NAMESPACE}:${t}`) || names.has(`${LOCAL_PREFIX}:${t}`),
            );
        }
    } catch {
        // convergeModels handles the unreachable case with its own message
    }
    if (installedTiers.length > 0) {
        console.log(
            `\nConverging ${installedTiers.length} installed model tier(s) [${installedTiers.join(", ")}] against the registry.`,
        );
        console.log(
            "  Updated models download in full (can be multiple GB). Skip with: prism connect --no-models",
        );
    } else {
        console.log("\nConverging local models against the registry…");
    }

    const outcomes = await convergeModels({
        listTags: async () => {
            const res = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5_000) });
            if (!res.ok) throw new Error(`Ollama /api/tags HTTP ${res.status}`);
            const data = (await res.json()) as { models?: Array<{ name: string; digest: string }> };
            return (data.models ?? []).map((m) => ({ name: m.name, digest: m.digest }));
        },
        tagFacts: async (name) => {
            const res = await fetch(`${OLLAMA_URL}/api/show`, {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ model: name }), signal: AbortSignal.timeout(5_000),
            });
            if (!res.ok) return null;
            const data = (await res.json()) as { modelfile?: string; parameters?: string };
            const from = /^FROM\s+(\S+)/m.exec(data.modelfile ?? "")?.[1];
            if (!from) return null;
            const pin = /^\s*num_ctx\s+(\d+)\s*$/m.exec(data.parameters ?? "");
            return { weightsBlob: from, pinnedNumCtx: pin ? Number(pin[1]) : null };
        },
        pull: (ref) => runOllama(["pull", ref], true),
        copy: (from, to) => runOllama(["cp", from, to], false),
        log: (line) => console.log(`  ${line}`),
        dryRun: opts.dryRun,
    });

    const failed = outcomes.filter((o) => o.action === "failed" && o.detail !== "ollama_unreachable");
    if (failed.length > 0) {
        console.log(`  ⚠ ${failed.length} tier(s) did not converge — re-run \`prism update-models\` when the network allows`);
    }
    return outcomes;
}
