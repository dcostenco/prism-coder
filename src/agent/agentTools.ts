/**
 * Agent Tools — Local workspace tools for the Prism Agent Terminal
 * =================================================================
 *
 * Provides file system, shell, and memory access tools that the AI agent
 * can invoke during an interactive `prism prompt` session. These are
 * declared as Gemini Function Declarations and executed locally.
 *
 * Mirrors the Synalux VS Code extension's local-tools.ts capabilities
 * but runs in a terminal context (no VS Code API dependency).
 */

import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";
import {
    openUrlCommand,
    fetchUrlCommand,
    listFilesCommand,
    searchFilesCommand,
    resolveCli,
    IS_WINDOWS,
} from "./platformUtils.js";

const execAsync = promisify(exec);

// ---------------------------------------------------------------------------
// Tool Declarations (Gemini Function Calling Schema)
// ---------------------------------------------------------------------------

export const AGENT_TOOL_DECLARATIONS: FunctionDeclaration[] = [
    {
        name: "read_file",
        description:
            "Read the contents of a file. Use when the user asks about code, configs, or any file. Supports optional line range.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                path: {
                    type: SchemaType.STRING,
                    description: "Absolute or relative file path to read",
                },
                start_line: {
                    type: SchemaType.INTEGER,
                    description: "Optional start line (1-indexed)",
                },
                end_line: {
                    type: SchemaType.INTEGER,
                    description: "Optional end line (1-indexed, inclusive)",
                },
            },
            required: ["path"],
        },
    },
    {
        name: "list_files",
        description:
            "List files and directories. Use when the user asks about project structure or wants to find files.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                directory: {
                    type: SchemaType.STRING,
                    description:
                        "Directory path to list (default: current working directory)",
                },
                pattern: {
                    type: SchemaType.STRING,
                    description: "Optional glob pattern filter (e.g., '**/*.ts')",
                },
                max_depth: {
                    type: SchemaType.INTEGER,
                    description: "Maximum directory depth to traverse (default: 3)",
                },
            },
        },
    },
    {
        name: "search_files",
        description:
            "Search for text or patterns across files using ripgrep. Use when the user wants to find where something is defined or used.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: {
                    type: SchemaType.STRING,
                    description: "Text or regex pattern to search for",
                },
                directory: {
                    type: SchemaType.STRING,
                    description: "Directory to search in (default: cwd)",
                },
                file_pattern: {
                    type: SchemaType.STRING,
                    description: "Glob to filter files (e.g., '*.ts')",
                },
                max_results: {
                    type: SchemaType.INTEGER,
                    description: "Maximum results (default: 20)",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "run_command",
        description:
            "Execute a shell command and return stdout/stderr. Use for running tests, builds, git commands, etc. Commands have a 30-second timeout.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                command: {
                    type: SchemaType.STRING,
                    description: "Shell command to execute",
                },
                cwd: {
                    type: SchemaType.STRING,
                    description: "Working directory (default: cwd)",
                },
            },
            required: ["command"],
        },
    },
    {
        name: "write_file",
        description:
            "Create or overwrite a file with the given content. Creates parent directories if needed.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                path: {
                    type: SchemaType.STRING,
                    description: "File path to write to",
                },
                content: {
                    type: SchemaType.STRING,
                    description: "Content to write",
                },
            },
            required: ["path", "content"],
        },
    },
    {
        name: "edit_file",
        description:
            "Apply a targeted search-and-replace edit to a file. Use instead of write_file when making small changes.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                path: {
                    type: SchemaType.STRING,
                    description: "File path to edit",
                },
                search: {
                    type: SchemaType.STRING,
                    description: "Exact text to find and replace",
                },
                replace: {
                    type: SchemaType.STRING,
                    description: "Replacement text",
                },
            },
            required: ["path", "search", "replace"],
        },
    },
    {
        name: "memory_search",
        description:
            "Search the user's Prism memory (past sessions, decisions, TODOs). Use when the user asks about previous work or project history.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                query: {
                    type: SchemaType.STRING,
                    description: "Search query",
                },
                project: {
                    type: SchemaType.STRING,
                    description: "Project to search within",
                },
                limit: {
                    type: SchemaType.INTEGER,
                    description: "Max results (default: 5)",
                },
            },
            required: ["query"],
        },
    },
    {
        name: "open_url",
        description:
            "Open a URL in the user's default browser.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                url: {
                    type: SchemaType.STRING,
                    description: "URL to open",
                },
            },
            required: ["url"],
        },
    },
    {
        name: "fetch_url",
        description:
            "Fetch the text content of a web page and return it. Use when the user wants you to read, summarize, or analyze a web page.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                url: {
                    type: SchemaType.STRING,
                    description: "The URL to fetch content from",
                },
            },
            required: ["url"],
        },
    },
    {
        name: "supabase_cli",
        description:
            "Execute Supabase CLI commands (e.g., status, diff, push, db pull). Always use this for Supabase database management.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                args: {
                    type: SchemaType.STRING,
                    description: 'The arguments to pass to the supabase CLI (e.g., "db pull", "status")',
                },
            },
            required: ["args"],
        },
    },
    {
        name: "stripe_cli",
        description:
            "Execute Stripe CLI commands (e.g., listen, trigger, login). Always use this for Stripe operations.",
        parameters: {
            type: SchemaType.OBJECT,
            properties: {
                args: {
                    type: SchemaType.STRING,
                    description: 'The arguments to pass to the stripe CLI (e.g., "listen --forward-to localhost:3000/api/webhook")',
                },
            },
            required: ["args"],
        },
    },
];

// ---------------------------------------------------------------------------
// Tool Executor
// ---------------------------------------------------------------------------

/**
 * Resolve a path — if relative, resolve against cwd.
 */
function resolvePath(filePath: string): string {
    if (path.isAbsolute(filePath)) return filePath;
    return path.resolve(process.cwd(), filePath);
}

/**
 * Execute an agent tool and return the result as a string.
 */
export async function executeAgentTool(
    toolName: string,
    args: Record<string, unknown>,
    project?: string,
): Promise<string> {
    switch (toolName) {
        // ─── read_file ─────────────────────────────────────────────
        case "read_file": {
            const filePath = resolvePath(args.path as string);
            if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

            const content = fs.readFileSync(filePath, "utf-8");
            const lines = content.split("\n");

            const start = Math.max(1, (args.start_line as number) || 1);
            const end = Math.min(lines.length, (args.end_line as number) || lines.length);
            const slice = lines.slice(start - 1, end);

            // Add line numbers
            const numbered = slice.map((l, i) => `${start + i}: ${l}`).join("\n");
            return `File: ${filePath} (${lines.length} lines total, showing ${start}-${end})\n\n${numbered}`;
        }

        // ─── list_files ────────────────────────────────────────────
        case "list_files": {
            const dir = resolvePath((args.directory as string) || ".");
            if (!fs.existsSync(dir)) return `Error: Directory not found: ${dir}`;

            const maxDepth = (args.max_depth as number) || 3;
            const pattern = args.pattern as string | undefined;

            const cmd = listFilesCommand(dir, maxDepth, pattern);

            try {
                const { stdout } = await execAsync(cmd, { timeout: 10000, shell: IS_WINDOWS ? "powershell.exe" : undefined });
                const entries = stdout.trim().split("\n").filter(Boolean);
                return `Directory: ${dir}\n${entries.length} items found:\n\n${entries.join("\n")}`;
            } catch {
                // Fallback to Node.js readdir
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                const lines = entries
                    .slice(0, 50)
                    .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
                return `Directory: ${dir}\n${lines.join("\n")}`;
            }
        }

        // ─── search_files ──────────────────────────────────────────
        case "search_files": {
            const query = args.query as string;
            const dir = resolvePath((args.directory as string) || ".");
            const maxResults = (args.max_results as number) || 20;
            const filePattern = args.file_pattern as string | undefined;

            const cmd = searchFilesCommand(query, dir, maxResults, filePattern);

            try {
                const { stdout } = await execAsync(cmd, { timeout: 15000 });
                if (!stdout.trim()) return `No matches found for "${query}" in ${dir}`;
                return `Search: "${query}" in ${dir}\n\n${stdout.trim()}`;
            } catch {
                return `No matches found for "${query}" in ${dir}`;
            }
        }

        // ─── run_command ───────────────────────────────────────────
        case "run_command": {
            const command = args.command as string;
            const cwd = resolvePath((args.cwd as string) || ".");

            // Safety: block obviously dangerous commands
            const blocked = ["rm -rf /", "mkfs", "dd if=", ":(){"];
            if (blocked.some((b) => command.includes(b))) {
                return "Error: Command blocked for safety reasons.";
            }

            try {
                const { stdout, stderr } = await execAsync(command, {
                    cwd,
                    timeout: 30000,
                    maxBuffer: 1024 * 1024,
                    env: { ...process.env, PAGER: "cat" },
                });

                let result = "";
                if (stdout.trim()) result += `stdout:\n${stdout.trim()}\n`;
                if (stderr.trim()) result += `stderr:\n${stderr.trim()}\n`;
                if (!result) result = "(command completed with no output)";
                return result;
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string; message?: string };
                let msg = `Command failed: ${command}\n`;
                if (e.stdout) msg += `stdout:\n${e.stdout}\n`;
                if (e.stderr) msg += `stderr:\n${e.stderr}\n`;
                if (e.message && !e.stderr) msg += `error: ${e.message}`;
                return msg;
            }
        }

        // ─── write_file ────────────────────────────────────────────
        case "write_file": {
            const filePath = resolvePath(args.path as string);
            const content = args.content as string;

            // Create parent dirs
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, content, "utf-8");
            return `✅ Written ${content.length} chars to ${filePath}`;
        }

        // ─── edit_file ─────────────────────────────────────────────
        case "edit_file": {
            const filePath = resolvePath(args.path as string);
            if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;

            const original = fs.readFileSync(filePath, "utf-8");
            const search = args.search as string;
            const replace = args.replace as string;

            if (!original.includes(search)) {
                return `Error: Search text not found in ${filePath}`;
            }

            const updated = original.replace(search, replace);
            fs.writeFileSync(filePath, updated, "utf-8");
            return `✅ Edited ${filePath} — replaced ${search.length} chars`;
        }

        // ─── memory_search ─────────────────────────────────────────
        case "memory_search": {
            const { knowledgeSearchHandler } = await import(
                "../tools/graphHandlers.js"
            );
            const result = await knowledgeSearchHandler({
                query: args.query as string,
                project: (args.project as string) || project || "prism-mcp",
                limit: (args.limit as number) || 5,
            });

            const text =
                result.content?.[0] && "text" in result.content[0]
                    ? result.content[0].text
                    : "No results found.";
            return text;
        }

        // ─── open_url ──────────────────────────────────────────────
        case "open_url": {
            const url = args.url as string;
            try {
                await execAsync(openUrlCommand(url));
                return `✅ Opened ${url} in default browser`;
            } catch {
                return `Error: Failed to open ${url}`;
            }
        }

        // ─── fetch_url ─────────────────────────────────────────────
        case "fetch_url": {
            const fetchUrl = args.url as string;
            if (!fetchUrl?.match(/^https?:\/\//i)) {
                return "Error: Invalid URL. Must start with http:// or https://";
            }
            try {
                const cmd = fetchUrlCommand(fetchUrl);
                const { stdout } = await execAsync(
                    cmd,
                    {
                        timeout: 20000,
                        maxBuffer: 1024 * 1024,
                        shell: IS_WINDOWS ? "powershell.exe" : undefined,
                    },
                );
                const text = stdout.trim().slice(0, 8000);
                return `Content from ${fetchUrl}:\n\n${text}${text.length >= 8000 ? "\n\n... (truncated)" : ""}`;
            } catch (err: unknown) {
                const e = err as { message?: string };
                return `Error: Failed to fetch ${fetchUrl} — ${e.message?.slice(0, 200) || "unknown error"}`;
            }
        }

        // ─── supabase_cli ──────────────────────────────────────────
        case "supabase_cli": {
            const sbArgs = args.args as string;
            const sbBin = resolveCli("supabase");
            try {
                const { stdout } = await execAsync(`${sbBin} ${sbArgs}`, {
                    cwd: process.cwd(),
                    timeout: 60000,
                    maxBuffer: 1024 * 512,
                    env: { ...process.env, PAGER: "cat" },
                });
                return `supabase ${sbArgs}:\n${stdout.trim().slice(0, 5000)}`;
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string };
                let msg = `supabase ${sbArgs} failed:\n`;
                if (e.stdout) msg += e.stdout.slice(0, 3000);
                if (e.stderr) msg += `\nstderr: ${e.stderr.slice(0, 1000)}`;
                return msg;
            }
        }

        // ─── stripe_cli ───────────────────────────────────────────
        case "stripe_cli": {
            const stripeArgs = args.args as string;
            const stripeBin = resolveCli("stripe");
            try {
                const { stdout } = await execAsync(`${stripeBin} ${stripeArgs}`, {
                    cwd: process.cwd(),
                    timeout: 60000,
                    maxBuffer: 1024 * 512,
                    env: { ...process.env, PAGER: "cat" },
                });
                return `stripe ${stripeArgs}:\n${stdout.trim().slice(0, 5000)}`;
            } catch (err: unknown) {
                const e = err as { stdout?: string; stderr?: string };
                let msg = `stripe ${stripeArgs} failed:\n`;
                if (e.stdout) msg += e.stdout.slice(0, 3000);
                if (e.stderr) msg += `\nstderr: ${e.stderr.slice(0, 1000)}`;
                return msg;
            }
        }

        default:
            return `Error: Unknown tool \"${toolName}\"`;
    }
}
