/**
 * Terminal UI — ANSI Color Formatting for Prism Agent Terminal
 * =============================================================
 *
 * Provides rich terminal output matching the Synalux VS Code extension's
 * purple/cyan/green color scheme. Uses ANSI escape codes for colors,
 * bold, dim, italic, and underline formatting.
 */

// ---------------------------------------------------------------------------
// ANSI Escape Codes
// ---------------------------------------------------------------------------

const ESC = '\x1b[';

export const c = {
    // Reset
    reset: `${ESC}0m`,

    // Styles
    bold: `${ESC}1m`,
    dim: `${ESC}2m`,
    italic: `${ESC}3m`,
    underline: `${ESC}4m`,

    // Brand colors (256-color mode)
    purple: `${ESC}38;5;141m`,       // Primary brand — headers, prompts
    cyan: `${ESC}38;5;81m`,          // Tools, actions
    green: `${ESC}38;5;114m`,        // Success, code
    yellow: `${ESC}38;5;221m`,       // Warnings
    red: `${ESC}38;5;203m`,          // Errors
    blue: `${ESC}38;5;75m`,          // Info, links
    white: `${ESC}38;5;255m`,        // AI response text
    gray: `${ESC}38;5;245m`,         // Dim text, timestamps
    orange: `${ESC}38;5;215m`,       // Highlights

    // Backgrounds
    bgPurple: `${ESC}48;5;141m`,
    bgCyan: `${ESC}48;5;81m`,
    bgDim: `${ESC}48;5;236m`,
};

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

/** Calculate the visible terminal width of a string (strips ANSI, accounts for double-width chars) */
function visibleWidth(str: string): number {
    // Strip ANSI escape codes
    const stripped = str.replace(/\x1b\[[0-9;]*m/g, '');
    let width = 0;
    for (const char of stripped) {
        const cp = char.codePointAt(0) || 0;
        // Surrogate pair / astral plane characters (emoji, symbols) = 2 columns
        if (cp > 0xFFFF) {
            width += 2;
        } else {
            width += 1;
        }
    }
    return width;
}

/** Pad a visible string to a fixed column width */
function padLine(visible: string, targetWidth: number): string {
    const w = visibleWidth(visible);
    const padding = Math.max(0, targetWidth - w);
    return visible + ' '.repeat(padding);
}

/** Print the startup header — compact VS Code-style top bar */
export function printBanner(opts: {
    version: string;
    project: string;
    cwd: string;
    name?: string;
    email?: string;
    plan?: string;
    toolCount: number;
    mcpServers?: number;
    model?: string;
}) {
    console.log('');

    // ─── Top bar: Prism Agent  CLOUD  ✨ Model  👤 user  PLAN ──
    const cloudBadge = `${c.bgCyan}${c.bold} CLOUD ${c.reset}`;
    const modelChip = opts.model ? `${c.bgDim} ✨ ${c.bold}${opts.model} ${c.reset}` : '';
    const userStr = opts.name || opts.email || '';
    const userChip = userStr ? `  ${c.dim}👤${c.reset} ${userStr}` : '';
    const planBadge = opts.plan ? `  ${c.bgPurple}${c.bold} ${opts.plan.toUpperCase()} ${c.reset}` : '';

    console.log(`  ${c.bold}${c.purple}Prism Agent${c.reset}  ${cloudBadge}  ${modelChip}${userChip}${planBadge}`);

    // ─── Sub-bar: project · cwd · tools ───────────────────────
    const cwdShort = opts.cwd.length > 30 ? '...' + opts.cwd.slice(-27) : opts.cwd;
    const mcpStr = opts.mcpServers ? `  ${c.dim}·${c.reset}  ${opts.mcpServers} MCP` : '';
    console.log(`  ${c.dim}📂 ${opts.project}  ·  📁 ${cwdShort}  ·  🔧 ${opts.toolCount} tools${mcpStr}${c.reset}`);
    console.log('');
}

/** Build the input prompt string with action buttons — VS Code-style bottom bar */
export function buildPromptStr(): string {
    // Action buttons: [+] [📎] [🎤] [💬]
    const btn = (icon: string) => `${c.dim}[${c.reset}${icon}${c.dim}]${c.reset}`;
    return `${btn('+')} ${btn('📎')} ${btn('🎤')} ${btn('💬')}  ${c.purple}${c.bold}❯${c.reset} `;
}

/** Print action buttons legend */
export function printActionLegend() {
    console.log(`  ${c.dim}[+] /image  [📎] /paste  [🎤] /voice  [💬] /speak  — /help for all${c.reset}`);
    console.log('');
}

/** Format a tool call for display */
export function formatToolCall(name: string, args: Record<string, unknown>): string {
    const argsStr = JSON.stringify(args);
    const truncated = argsStr.length > 80 ? argsStr.substring(0, 77) + '...' : argsStr;
    return `  ${c.cyan}${c.bold}⚡ ${name}${c.reset}${c.dim}(${truncated})${c.reset}`;
}

/** Format a tool result summary */
export function formatToolResult(name: string, success: boolean): string {
    return success
        ? `  ${c.green}✓${c.reset} ${c.dim}${name} completed${c.reset}`
        : `  ${c.red}✗${c.reset} ${c.dim}${name} failed${c.reset}`;
}

/** Format an AI response */
export function formatResponse(text: string): string {
    // Highlight code blocks with green
    let formatted = text.replace(
        /```(\w+)?\n([\s\S]*?)```/g,
        (_, lang, code) => `${c.dim}┌─ ${lang || 'code'} ──${c.reset}\n${c.green}${code.trimEnd()}${c.reset}\n${c.dim}└──────${c.reset}`,
    );

    // Highlight inline code with cyan
    formatted = formatted.replace(
        /`([^`]+)`/g,
        `${c.cyan}$1${c.reset}`,
    );

    // Highlight bold with white bold
    formatted = formatted.replace(
        /\*\*([^*]+)\*\*/g,
        `${c.bold}${c.white}$1${c.reset}`,
    );

    return `\n${formatted}\n`;
}

/** Format an error */
export function formatError(message: string): string {
    return `\n${c.red}${c.bold}✗ Error:${c.reset} ${c.red}${message}${c.reset}\n`;
}

/** Format a success message */
export function formatSuccess(message: string): string {
    return `${c.green}✓${c.reset} ${message}`;
}

/** Format a warning */
export function formatWarning(message: string): string {
    return `${c.yellow}⚠${c.reset} ${c.yellow}${message}${c.reset}`;
}

/** Format the help menu */
export function printHelp() {
    console.log('');
    console.log(`  ${c.bold}${c.purple}Commands:${c.reset}`);
    console.log(`  ${c.cyan}/image ${c.dim}<path> [question]${c.reset}  — Analyze an image`);
    console.log(`  ${c.cyan}/voice ${c.dim}[seconds]${c.reset}          — Record & transcribe speech`);
    console.log(`  ${c.cyan}/camera ${c.dim}[question]${c.reset}        — Capture photo & analyze`);
    console.log(`  ${c.cyan}/speak${c.reset}                    — Toggle text-to-speech`);
    console.log(`  ${c.cyan}/paste${c.reset}                    — Paste clipboard image`);
    console.log(`  ${c.cyan}/search ${c.dim}<query>${c.reset}            — Search Prism memory`);
    console.log(`  ${c.cyan}/todos${c.reset}                    — Show open TODOs`);
    console.log(`  ${c.cyan}/context${c.reset}                  — Show loaded context`);
    console.log(`  ${c.cyan}/tools${c.reset}                    — List available tools`);
    console.log(`  ${c.cyan}/exit${c.reset}                     — Quit`);
    console.log('');
}

/** Format MCP connection status */
export function formatMcpConnect(name: string, tools: string[], success: boolean): string {
    if (success) {
        return `  ${c.green}✓${c.reset} ${c.bold}${name}${c.reset} ${c.dim}— ${tools.length} tool(s):${c.reset} ${c.cyan}${tools.join(', ')}${c.reset}`;
    }
    return `  ${c.red}✗${c.reset} ${c.bold}${name}${c.reset} ${c.dim}— connection failed${c.reset}`;
}

/** Format context loaded */
export function formatContextLoaded(todoCount: number, keywordCount: number): string {
    return formatSuccess(`Loaded ${c.bold}${todoCount}${c.reset} TODOs, ${c.bold}${keywordCount}${c.reset} keywords`);
}

/** Print thinking indicator */
export function printThinking(): void {
    process.stdout.write(`${c.dim}${c.italic}  thinking...${c.reset}`);
}

/** Clear thinking indicator */
export function clearThinking(): void {
    process.stdout.write('\r\x1b[K');
}
