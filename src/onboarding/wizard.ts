/**
 * v12.1: Interactive Setup Wizard — First-Run Onboarding
 *
 * Provides a guided setup experience for new Prism users through
 * the Mind Palace Dashboard. Replaces the 1,785-line README wall
 * with a step-by-step wizard that gets users productive in 3 minutes.
 *
 * Wizard Steps:
 *   1. Welcome & Project Setup     — create first project, pick storage backend
 *   2. IDE Configuration           — generate MCP config for Claude Desktop / Cursor
 *   3. First Memory Save           — guided session_save_ledger call
 *   4. Search & Recall             — demonstrate knowledge_search
 *   5. Advanced Features Tour      — Dark Factory, Hivemind, Scholar (optional)
 *
 * State is persisted in prism-config.db so the wizard can be resumed.
 */

import { debugLog } from "../utils/logger.js";

// ─── Types ───────────────────────────────────────────────────

export type WizardStep =
    | "welcome"
    | "storage"
    | "project"
    | "ide_config"
    | "first_save"
    | "first_search"
    | "advanced_tour"
    | "complete";

export interface WizardState {
    currentStep: WizardStep;
    completedSteps: WizardStep[];
    projectName?: string;
    storageBackend?: "local" | "supabase";
    ideClient?: "claude_desktop" | "cursor" | "windsurf" | "vscode" | "other";
    startedAt: string;
    completedAt?: string;
    version: string;
}

export interface WizardStepContent {
    step: WizardStep;
    title: string;
    description: string;
    instructions: string[];
    codeSnippet?: string;
    nextStep: WizardStep | null;
    progress: number; // 0-100
}

// ─── Step Definitions ────────────────────────────────────────

const STEP_ORDER: WizardStep[] = [
    "welcome",
    "storage",
    "project",
    "ide_config",
    "first_save",
    "first_search",
    "advanced_tour",
    "complete",
];

function getStepProgress(step: WizardStep): number {
    const idx = STEP_ORDER.indexOf(step);
    return Math.round((idx / (STEP_ORDER.length - 1)) * 100);
}

function getNextStep(current: WizardStep): WizardStep | null {
    const idx = STEP_ORDER.indexOf(current);
    return idx < STEP_ORDER.length - 1 ? STEP_ORDER[idx + 1] : null;
}

// ─── Step Content Generators ─────────────────────────────────

function getWelcomeContent(): WizardStepContent {
    return {
        step: "welcome",
        title: "👋 Welcome to Prism — The Mind Palace for AI Agents",
        description:
            "Prism gives your AI agents persistent memory across sessions. " +
            "This wizard will get you set up in under 3 minutes.",
        instructions: [
            "Choose your storage backend (local SQLite or Supabase cloud)",
            "Create your first project",
            "Configure your IDE (Claude Desktop, Cursor, etc.)",
            "Save your first memory and search it back",
        ],
        nextStep: "storage",
        progress: 0,
    };
}

function getStorageContent(): WizardStepContent {
    return {
        step: "storage",
        title: "💾 Choose Storage Backend",
        description:
            "Prism supports two storage backends. Choose based on your needs:",
        instructions: [
            "**Local SQLite** (recommended for getting started): Zero config, free, HIPAA-compliant, works offline. Data stays on your machine.",
            "**Supabase Cloud**: Team sync, cross-device access, pgvector semantic search. Requires a Supabase account (free tier available).",
            "You can switch backends later without data loss using `prism export`.",
        ],
        codeSnippet: `# Local SQLite (default — no config needed)
PRISM_STORAGE=local

# Supabase Cloud
PRISM_STORAGE=supabase
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key`,
        nextStep: "project",
        progress: 14,
    };
}

function getProjectContent(projectName?: string): WizardStepContent {
    const name = projectName || "my-first-project";
    return {
        step: "project",
        title: "📁 Create Your First Project",
        description:
            "Projects organize your AI agent's memories. Each project gets its own session ledger, handoff state, and search index.",
        instructions: [
            `Create a project called "${name}" by saving your first session`,
            "Projects are created automatically when you save a ledger entry",
            "You can have unlimited projects (each is isolated)",
        ],
        codeSnippet: `// Your AI agent calls this MCP tool:
session_save_ledger({
  project: "${name}",
  conversation_id: "setup-wizard",
  summary: "Initial project setup via Prism wizard"
})`,
        nextStep: "ide_config",
        progress: 29,
    };
}

function getIDEConfigContent(
    client: string = "claude_desktop"
): WizardStepContent {
    const configs: Record<string, string> = {
        claude_desktop: `{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp@latest"],
      "env": {
        "BRAVE_API_KEY": "your-brave-key"
      }
    }
  }
}`,
        cursor: `{
  "mcpServers": {
    "prism-mcp": {
      "command": "npx",
      "args": ["-y", "prism-mcp@latest"],
      "env": {
        "BRAVE_API_KEY": "your-brave-key"
      }
    }
  }
}`,
    };

    return {
        step: "ide_config",
        title: "⚙️ Configure Your IDE",
        description:
            "Add Prism as an MCP server in your AI coding tool's configuration.",
        instructions: [
            "Copy the config below into your IDE's MCP configuration file",
            "For Claude Desktop: ~/Library/Application Support/Claude/claude_desktop_config.json",
            "For Cursor: .cursor/mcp.json in your workspace",
            "Restart your IDE to pick up the new MCP server",
        ],
        codeSnippet: configs[client] || configs.claude_desktop,
        nextStep: "first_save",
        progress: 43,
    };
}

function getFirstSaveContent(): WizardStepContent {
    return {
        step: "first_save",
        title: "💾 Save Your First Memory",
        description:
            "Ask your AI agent to save a session summary. This creates your first persistent memory entry.",
        instructions: [
            'Tell your AI assistant: "Save a session summary about our setup"',
            "The agent will call session_save_ledger automatically",
            "Your memory is now persisted and searchable across future sessions",
        ],
        codeSnippet: `// Example prompt to your AI agent:
"Please save a session summary — we just set up Prism 
and configured it for our project."

// The agent calls:
session_save_ledger({
  project: "my-first-project",
  conversation_id: "setup-session",
  summary: "Set up Prism MCP server, configured storage..."
})`,
        nextStep: "first_search",
        progress: 57,
    };
}

function getFirstSearchContent(): WizardStepContent {
    return {
        step: "first_search",
        title: "🔍 Search Your Memories",
        description:
            "In a NEW conversation, try searching for the memory you just saved.",
        instructions: [
            "Start a fresh conversation with your AI agent",
            'Ask: "What did we set up in our last session?"',
            "The agent will call knowledge_search or session_load_context",
            "You should see your saved memory returned!",
        ],
        codeSnippet: `// The agent calls:
session_load_context({
  project: "my-first-project",
  level: "standard"
})
// → Returns your saved summary + any open TODOs`,
        nextStep: "advanced_tour",
        progress: 71,
    };
}

function getAdvancedTourContent(): WizardStepContent {
    return {
        step: "advanced_tour",
        title: "🚀 Advanced Features",
        description:
            "Prism has much more to offer. Here's a quick tour of advanced capabilities:",
        instructions: [
            "**Dark Factory** — Autonomous AI pipelines that run in the background (set PRISM_DARK_FACTORY_ENABLED=true)",
            "**Hivemind** — Multi-agent coordination with role-based access (set PRISM_ENABLE_HIVEMIND=true)",
            "**Auto-Scholar** — Autonomous research agent that discovers and synthesizes papers",
            "**Mind Palace Dashboard** — Web UI at localhost:3080 for managing projects, viewing analytics, and configuring settings",
            "**Visual Memory** — Save screenshots and diagrams with session_save_image",
            "**Data Portability** — Export to Obsidian/Logseq vault format with session_export_memory",
        ],
        nextStep: "complete",
        progress: 86,
    };
}

function getCompleteContent(): WizardStepContent {
    return {
        step: "complete",
        title: "✅ Setup Complete!",
        description:
            "Congratulations! Prism is configured and your first memory is saved. " +
            "Your AI agents now have persistent, searchable memory across all sessions.",
        instructions: [
            "📖 Full documentation: https://github.com/synalux/prism",
            "🎛️ Dashboard: http://localhost:3080 (when server is running)",
            "💬 Community: GitHub Discussions for questions and feedback",
            "🐛 Issues: GitHub Issues for bug reports",
        ],
        nextStep: null,
        progress: 100,
    };
}

// ─── Public API ──────────────────────────────────────────────

/**
 * Get the content for a specific wizard step.
 */
export function getWizardStepContent(
    step: WizardStep,
    state?: Partial<WizardState>
): WizardStepContent {
    switch (step) {
        case "welcome":
            return getWelcomeContent();
        case "storage":
            return getStorageContent();
        case "project":
            return getProjectContent(state?.projectName);
        case "ide_config":
            return getIDEConfigContent(state?.ideClient);
        case "first_save":
            return getFirstSaveContent();
        case "first_search":
            return getFirstSearchContent();
        case "advanced_tour":
            return getAdvancedTourContent();
        case "complete":
            return getCompleteContent();
        default:
            return getWelcomeContent();
    }
}

/**
 * Initialize a new wizard state.
 */
export function createWizardState(): WizardState {
    return {
        currentStep: "welcome",
        completedSteps: [],
        startedAt: new Date().toISOString(),
        version: "12.1.0",
    };
}

/**
 * Advance the wizard to the next step.
 */
export function advanceWizard(state: WizardState): WizardState {
    const nextStep = getNextStep(state.currentStep);
    if (!nextStep) {
        return {
            ...state,
            completedAt: new Date().toISOString(),
        };
    }

    return {
        ...state,
        completedSteps: [...state.completedSteps, state.currentStep],
        currentStep: nextStep,
        completedAt: nextStep === "complete" ? new Date().toISOString() : undefined,
    };
}

/**
 * Check if the wizard has been completed.
 */
export function isWizardComplete(state: WizardState): boolean {
    return state.currentStep === "complete" || !!state.completedAt;
}

/**
 * Get a quick summary of wizard progress.
 */
export function getWizardSummary(state: WizardState): string {
    const content = getWizardStepContent(state.currentStep, state);
    if (isWizardComplete(state)) {
        return "✅ Setup wizard completed. Prism is fully configured.";
    }
    return `🔧 Setup wizard: ${content.progress}% complete — ${content.title}`;
}

debugLog("v12.1: Onboarding wizard module loaded");
