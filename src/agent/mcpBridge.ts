/**
 * MCP Bridge — Connect external MCP servers to the Prism Agent Terminal
 * ======================================================================
 *
 * Allows `prism prompt` to discover and connect to MCP servers configured
 * in standard config files (.cursor/mcp.json, .vscode/mcp.json) or via
 * manual `prism prompt --mcp <command>`.
 *
 * Connected MCP server tools are automatically injected into Gemini's
 * function declarations so the AI can call them during conversation.
 *
 * Config format (standard MCP convention):
 * ```json
 * {
 *   "mcpServers": {
 *     "my-server": {
 *       "command": "node",
 *       "args": ["path/to/server.js"],
 *       "env": { "API_KEY": "..." }
 *     }
 *   }
 * }
 * ```
 */

import * as fs from "fs";
import * as path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { FunctionDeclaration } from "@google/generative-ai";
import { SchemaType } from "@google/generative-ai";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface McpServerConfig {
    command: string;
    args?: string[];
    env?: Record<string, string>;
}

interface McpServerConnection {
    name: string;
    client: Client;
    transport: StdioClientTransport;
    tools: McpToolInfo[];
}

interface McpToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// MCP Bridge
// ---------------------------------------------------------------------------

export class McpBridge {
    private connections: Map<string, McpServerConnection> = new Map();

    /**
     * Connect to an MCP server via stdio.
     */
    async connect(
        serverName: string,
        config: McpServerConfig,
    ): Promise<McpToolInfo[]> {
        // Don't double-connect
        if (this.connections.has(serverName)) {
            const existing = this.connections.get(serverName)!;
            return existing.tools;
        }

        const client = new Client(
            { name: "prism-agent", version: "12.0.0" },
            { capabilities: {} },
        );

        const transport = new StdioClientTransport({
            command: config.command,
            args: config.args || [],
            env: { ...process.env, ...(config.env || {}) } as Record<string, string>,
        });

        await client.connect(transport);

        // Discover tools
        const toolsResult = await client.listTools();
        const tools: McpToolInfo[] = toolsResult.tools.map((t) => ({
            name: t.name,
            description: t.description || "",
            inputSchema: t.inputSchema as Record<string, unknown>,
        }));

        this.connections.set(serverName, { name: serverName, client, transport, tools });
        return tools;
    }

    /**
     * Call a tool on a connected MCP server.
     */
    async callTool(
        toolName: string,
        args: Record<string, unknown>,
    ): Promise<string> {
        // Find which server owns this tool
        for (const conn of this.connections.values()) {
            const tool = conn.tools.find((t) => t.name === toolName);
            if (!tool) continue;

            const result = await conn.client.callTool({
                name: toolName,
                arguments: args,
            });

            if (result.isError) {
                const errText = (result.content as Array<{ type: string; text?: string }>)
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n");
                return `Error: ${errText || "Tool returned an error"}`;
            }

            // Extract text content
            const texts = (result.content as Array<{ type: string; text?: string }>)
                .filter((c) => c.type === "text")
                .map((c) => c.text || "");
            return texts.join("\n") || "(no output)";
        }

        return `Error: No MCP server has tool "${toolName}"`;
    }

    /**
     * Get all tools from all connected servers as Gemini FunctionDeclarations.
     * Prefixes tool names with server name to avoid collisions.
     */
    getGeminiFunctionDeclarations(): FunctionDeclaration[] {
        const declarations: FunctionDeclaration[] = [];

        for (const conn of this.connections.values()) {
            for (const tool of conn.tools) {
                // Convert JSON Schema to Gemini's FunctionDeclaration format
                declarations.push({
                    name: tool.name,
                    description: `[MCP:${conn.name}] ${tool.description}`,
                    parameters: convertJsonSchemaToGemini(tool.inputSchema),
                });
            }
        }

        return declarations;
    }

    /**
     * Check if a tool name belongs to an MCP server.
     */
    hasToolName(toolName: string): boolean {
        for (const conn of this.connections.values()) {
            if (conn.tools.some((t) => t.name === toolName)) return true;
        }
        return false;
    }

    /**
     * List all connected servers and their tools.
     */
    listServers(): Array<{ name: string; toolCount: number; tools: string[] }> {
        return Array.from(this.connections.values()).map((c) => ({
            name: c.name,
            toolCount: c.tools.length,
            tools: c.tools.map((t) => t.name),
        }));
    }

    /**
     * Disconnect all servers gracefully.
     */
    async disconnectAll(): Promise<void> {
        for (const conn of this.connections.values()) {
            try {
                await conn.client.close();
            } catch {
                // Ignore cleanup errors
            }
        }
        this.connections.clear();
    }
}

// ---------------------------------------------------------------------------
// Config Discovery
// ---------------------------------------------------------------------------

/**
 * Search for MCP server configurations in standard locations.
 * Returns merged config from all discovered files.
 */
export function discoverMcpConfigs(
    cwd: string = process.cwd(),
): Record<string, McpServerConfig> {
    const configs: Record<string, McpServerConfig> = {};

    // Search paths in order of priority (later overrides earlier)
    const searchPaths = [
        // Global configs
        path.join(process.env.HOME || "~", ".cursor", "mcp.json"),
        path.join(process.env.HOME || "~", ".vscode", "mcp.json"),
        // Project-level configs (higher priority)
        path.join(cwd, ".cursor", "mcp.json"),
        path.join(cwd, ".vscode", "mcp.json"),
        path.join(cwd, "mcp.json"),
    ];

    for (const configPath of searchPaths) {
        try {
            if (!fs.existsSync(configPath)) continue;

            const raw = fs.readFileSync(configPath, "utf-8");
            const parsed = JSON.parse(raw);

            // Support both { mcpServers: {...} } and { servers: {...} } formats
            const servers = parsed.mcpServers || parsed.servers || {};

            for (const [name, config] of Object.entries(servers)) {
                const c = config as McpServerConfig;
                if (c.command) {
                    configs[name] = c;
                }
            }
        } catch {
            // Skip invalid config files
        }
    }

    return configs;
}

// ---------------------------------------------------------------------------
// Schema Conversion
// ---------------------------------------------------------------------------

/**
 * Convert a JSON Schema object to Gemini's FunctionDeclaration parameters format.
 * Gemini uses its own SchemaType enum instead of standard JSON Schema type strings.
 */
function convertJsonSchemaToGemini(
    schema: Record<string, unknown>,
): FunctionDeclaration["parameters"] {
    if (!schema || typeof schema !== "object") {
        return { type: SchemaType.OBJECT, properties: {} };
    }

    const properties: Record<string, unknown> = {};
    const schemaProps = (schema.properties || {}) as Record<string, Record<string, unknown>>;

    for (const [key, prop] of Object.entries(schemaProps)) {
        properties[key] = convertPropertyToGemini(prop);
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic JSON Schema conversion
    return {
        type: SchemaType.OBJECT,
        properties,
        required: (schema.required as string[]) || [],
    } as any;
}

function convertPropertyToGemini(
    prop: Record<string, unknown>,
): Record<string, unknown> {
    const typeMap: Record<string, SchemaType> = {
        string: SchemaType.STRING,
        number: SchemaType.NUMBER,
        integer: SchemaType.INTEGER,
        boolean: SchemaType.BOOLEAN,
        array: SchemaType.ARRAY,
        object: SchemaType.OBJECT,
    };

    const result: Record<string, unknown> = {
        type: typeMap[prop.type as string] || SchemaType.STRING,
    };

    if (prop.description) result.description = prop.description;
    if (prop.enum) result.enum = prop.enum;

    // Handle array items
    if (prop.type === "array" && prop.items) {
        result.items = convertPropertyToGemini(prop.items as Record<string, unknown>);
    }

    // Handle nested objects
    if (prop.type === "object" && prop.properties) {
        const nestedProps: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(prop.properties as Record<string, Record<string, unknown>>)) {
            nestedProps[k] = convertPropertyToGemini(v);
        }
        result.properties = nestedProps;
    }

    return result;
}
