/**
 * v12.4: GitHub Actions CI/CD Pipeline Generator
 *
 * Generates GitHub Actions YAML workflows from Prism project configuration.
 * Supports test suite integration, automated deployments, and custom triggers.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export interface PipelineConfig {
    project: string;
    triggers: PipelineTrigger[];
    jobs: PipelineJob[];
    env?: Record<string, string>;
    concurrency?: { group: string; cancelInProgress: boolean };
}

export interface PipelineTrigger {
    type: "push" | "pull_request" | "schedule" | "workflow_dispatch" | "release";
    branches?: string[];
    paths?: string[];
    cron?: string;
    tags?: string[];
}

export interface PipelineJob {
    name: string;
    runsOn: string;
    steps: PipelineStep[];
    needs?: string[];
    condition?: string;
    timeout?: number;
    env?: Record<string, string>;
}

export interface PipelineStep {
    name: string;
    uses?: string;         // GitHub Action reference
    run?: string;          // Shell command
    with?: Record<string, string>;
    env?: Record<string, string>;
    condition?: string;
}

export interface GeneratedWorkflow {
    filename: string;
    yaml: string;
    description: string;
}

// ─── Preset Templates ───────────────────────────────────────

const PRESETS: Record<string, PipelineConfig> = {
    "node-test": {
        project: "",
        triggers: [
            { type: "push", branches: ["main"] },
            { type: "pull_request", branches: ["main"] },
        ],
        jobs: [
            {
                name: "test",
                runsOn: "ubuntu-latest",
                steps: [
                    { name: "Checkout", uses: "actions/checkout@v4" },
                    { name: "Setup Node", uses: "actions/setup-node@v4", with: { "node-version": "20" } },
                    { name: "Install", run: "npm ci" },
                    { name: "Lint", run: "npm run lint --if-present" },
                    { name: "Type Check", run: "npx tsc --noEmit" },
                    { name: "Test", run: "npm test --if-present" },
                ],
            },
        ],
    },
    "npm-publish": {
        project: "",
        triggers: [
            { type: "release", tags: ["v*"] },
        ],
        jobs: [
            {
                name: "publish",
                runsOn: "ubuntu-latest",
                steps: [
                    { name: "Checkout", uses: "actions/checkout@v4" },
                    { name: "Setup Node", uses: "actions/setup-node@v4", with: { "node-version": "20", "registry-url": "https://registry.npmjs.org" } },
                    { name: "Install", run: "npm ci" },
                    { name: "Build", run: "npm run build" },
                    { name: "Publish", run: "npm publish", env: { NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}" } },
                ],
            },
        ],
    },
    "python-test": {
        project: "",
        triggers: [
            { type: "push", branches: ["main"] },
            { type: "pull_request", branches: ["main"] },
        ],
        jobs: [
            {
                name: "test",
                runsOn: "ubuntu-latest",
                steps: [
                    { name: "Checkout", uses: "actions/checkout@v4" },
                    { name: "Setup Python", uses: "actions/setup-python@v5", with: { "python-version": "3.12" } },
                    { name: "Install", run: "pip install -e '.[dev]'" },
                    { name: "Lint", run: "ruff check ." },
                    { name: "Test", run: "pytest -v" },
                ],
            },
        ],
    },
};

// ─── YAML Generator ──────────────────────────────────────────

function indent(level: number): string {
    return "  ".repeat(level);
}

function renderTriggers(triggers: PipelineTrigger[]): string {
    const lines: string[] = ["on:"];

    for (const trigger of triggers) {
        switch (trigger.type) {
            case "push":
                lines.push(`${indent(1)}push:`);
                if (trigger.branches?.length) {
                    lines.push(`${indent(2)}branches: [${trigger.branches.map(b => `"${b}"`).join(", ")}]`);
                }
                if (trigger.paths?.length) {
                    lines.push(`${indent(2)}paths:`);
                    for (const p of trigger.paths) lines.push(`${indent(3)}- "${p}"`);
                }
                break;

            case "pull_request":
                lines.push(`${indent(1)}pull_request:`);
                if (trigger.branches?.length) {
                    lines.push(`${indent(2)}branches: [${trigger.branches.map(b => `"${b}"`).join(", ")}]`);
                }
                break;

            case "schedule":
                lines.push(`${indent(1)}schedule:`);
                lines.push(`${indent(2)}- cron: "${trigger.cron || "0 0 * * *"}"`);
                break;

            case "workflow_dispatch":
                lines.push(`${indent(1)}workflow_dispatch:`);
                break;

            case "release":
                lines.push(`${indent(1)}release:`);
                lines.push(`${indent(2)}types: [published]`);
                break;
        }
    }

    return lines.join("\n");
}

function renderStep(step: PipelineStep, level: number): string {
    const lines: string[] = [];
    lines.push(`${indent(level)}- name: "${step.name}"`);

    if (step.condition) {
        lines.push(`${indent(level + 1)}if: ${step.condition}`);
    }
    if (step.uses) {
        lines.push(`${indent(level + 1)}uses: ${step.uses}`);
    }
    if (step.run) {
        if (step.run.includes("\n")) {
            lines.push(`${indent(level + 1)}run: |`);
            for (const line of step.run.split("\n")) {
                lines.push(`${indent(level + 2)}${line}`);
            }
        } else {
            lines.push(`${indent(level + 1)}run: ${step.run}`);
        }
    }
    if (step.with && Object.keys(step.with).length > 0) {
        lines.push(`${indent(level + 1)}with:`);
        for (const [k, v] of Object.entries(step.with)) {
            lines.push(`${indent(level + 2)}${k}: "${v}"`);
        }
    }
    if (step.env && Object.keys(step.env).length > 0) {
        lines.push(`${indent(level + 1)}env:`);
        for (const [k, v] of Object.entries(step.env)) {
            lines.push(`${indent(level + 2)}${k}: ${v}`);
        }
    }

    return lines.join("\n");
}

/**
 * Generate a GitHub Actions YAML workflow from a pipeline config.
 */
export function generateWorkflow(config: PipelineConfig): GeneratedWorkflow {
    const lines: string[] = [];

    lines.push(`name: ${config.project || "CI"}`);
    lines.push("");
    lines.push(renderTriggers(config.triggers));
    lines.push("");

    if (config.env && Object.keys(config.env).length > 0) {
        lines.push("env:");
        for (const [k, v] of Object.entries(config.env)) {
            lines.push(`${indent(1)}${k}: "${v}"`);
        }
        lines.push("");
    }

    if (config.concurrency) {
        lines.push("concurrency:");
        lines.push(`${indent(1)}group: ${config.concurrency.group}`);
        lines.push(`${indent(1)}cancel-in-progress: ${config.concurrency.cancelInProgress}`);
        lines.push("");
    }

    lines.push("jobs:");
    for (const job of config.jobs) {
        lines.push(`${indent(1)}${job.name.replace(/\s+/g, "-").toLowerCase()}:`);
        lines.push(`${indent(2)}runs-on: ${job.runsOn}`);

        if (job.timeout) {
            lines.push(`${indent(2)}timeout-minutes: ${job.timeout}`);
        }
        if (job.needs?.length) {
            lines.push(`${indent(2)}needs: [${job.needs.join(", ")}]`);
        }
        if (job.condition) {
            lines.push(`${indent(2)}if: ${job.condition}`);
        }
        if (job.env && Object.keys(job.env).length > 0) {
            lines.push(`${indent(2)}env:`);
            for (const [k, v] of Object.entries(job.env)) {
                lines.push(`${indent(3)}${k}: "${v}"`);
            }
        }

        lines.push(`${indent(2)}steps:`);
        for (const step of job.steps) {
            lines.push(renderStep(step, 3));
        }
        lines.push("");
    }

    const yaml = lines.join("\n");
    return {
        filename: `.github/workflows/${config.project || "ci"}.yml`,
        yaml,
        description: `CI/CD workflow for ${config.project || "project"}`,
    };
}

/**
 * Generate a workflow from a preset template.
 */
export function generateFromPreset(
    preset: string,
    project: string,
): GeneratedWorkflow | null {
    const config = PRESETS[preset];
    if (!config) {
        debugLog(`CI Pipeline: Unknown preset '${preset}'. Available: ${Object.keys(PRESETS).join(", ")}`);
        return null;
    }

    return generateWorkflow({ ...config, project });
}

/**
 * List available preset templates.
 */
export function listPresets(): Array<{ name: string; description: string }> {
    return [
        { name: "node-test", description: "Node.js CI: lint, type-check, test" },
        { name: "npm-publish", description: "npm publish on release tag" },
        { name: "python-test", description: "Python CI: ruff lint, pytest" },
    ];
}

debugLog("v12.4: CI pipeline generator loaded");
