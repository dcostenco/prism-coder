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

/** Build the input prompt string — clean prompt for the text input line */
export function buildPromptStr(): string {
    return `${c.purple}${c.bold}❯${c.reset} `;
}

/** Action button definitions with known column positions */
export const ACTION_BUTTONS = [
    { icon: '📂', label: 'Image', cmd: '/image' },
    { icon: '📎', label: 'Paste', cmd: '/paste' },
    { icon: '🎤', label: 'Voice', cmd: '/voice' },
    { icon: '💬', label: 'Speak', cmd: '/speak' },
    { icon: '🔍', label: 'Search', cmd: '/search' },
    { icon: '📋', label: 'TODOs', cmd: '/todos' },
];

/**
 * Print the clickable action buttons bar above the prompt.
 * Returns the terminal row where buttons were printed (needed for click detection).
 */
export function printActionBar() {
    const parts = ACTION_BUTTONS.map(b =>
        `${c.bgDim} ${b.icon} ${c.cyan}${b.label}${c.reset}${c.bgDim} ${c.reset}`
    );
    console.log(`  ${parts.join(' ')}`);
    console.log(`  ${c.dim}☝ click a button above · / + Tab for all commands${c.reset}`);
    console.log('');
}

/**
 * Calculate column ranges for each button for click detection.
 * Returns array of { startCol, endCol, cmd } for hit-testing.
 */
export function getButtonHitZones(): Array<{ startCol: number; endCol: number; cmd: string }> {
    // Buttons are rendered starting at col 2 (2 spaces indent): " [icon label] [icon label] ..."
    // Each button is: space + icon(2 display cols) + space + label + space
    // Note: emoji icons are 2 cols wide in terminal
    let col = 2; // Start after "  " indent
    const zones: Array<{ startCol: number; endCol: number; cmd: string }> = [];

    for (const btn of ACTION_BUTTONS) {
        const startCol = col;
        // Format: " icon label " — space(1) + icon(2) + space(1) + label(N) + space(1) + gap(1)
        const width = 1 + 2 + 1 + btn.label.length + 1;
        const endCol = startCol + width;
        zones.push({ startCol, endCol, cmd: btn.cmd });
        col = endCol + 1; // +1 for the space between buttons
    }

    return zones;
}

// ── Mouse tracking ──────────────────────────────────────────────────────

/** Enable X10 mouse click reporting — terminal sends click coords to stdin */
export function enableMouseTracking() {
    process.stdout.write('\x1b[?1000h'); // X10 mouse tracking (click only)
    process.stdout.write('\x1b[?1006h'); // SGR extended mode (for wide terminals)
}

/** Disable mouse tracking — restore normal terminal input */
export function disableMouseTracking() {
    process.stdout.write('\x1b[?1006l');
    process.stdout.write('\x1b[?1000l');
}

/**
 * Parse SGR mouse event from stdin data.
 * SGR format: \x1b[<button;col;rowM (press) or \x1b[<button;col;rowm (release)
 * Returns { button, col, row, isPress } or null if not a mouse event.
 */
export function parseMouseEvent(data: string): { button: number; col: number; row: number; isPress: boolean } | null {
    // SGR extended format: ESC [ < Cb ; Cx ; Cy M/m
    const match = data.match(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/);
    if (match) {
        return {
            button: parseInt(match[1], 10),
            col: parseInt(match[2], 10),
            row: parseInt(match[3], 10),
            isPress: match[4] === 'M',
        };
    }

    // X10 basic format: ESC [ M Cb Cx Cy (3 raw bytes after M)
    const x10Match = data.match(/\x1b\[M(.)(.)(.)/);
    if (x10Match) {
        return {
            button: x10Match[1].charCodeAt(0) - 32,
            col: x10Match[2].charCodeAt(0) - 32,
            row: x10Match[3].charCodeAt(0) - 32,
            isPress: true,
        };
    }

    return null;
}

/**
 * Install mouse click handler on the readline interface.
 * Intercepts mouse events and dispatches matching button commands.
 * Returns a cleanup function to remove the handler.
 */
export function installMouseHandler(
    rl: any,
    buttonRowOffset: number, // How many rows above current cursor the buttons are
    onAction: (cmd: string) => void,
): () => void {
    const zones = getButtonHitZones();

    const handler = (data: Buffer) => {
        const str = data.toString();
        const event = parseMouseEvent(str);
        if (!event || !event.isPress || event.button !== 0) return; // Only left clicks

        // Get current cursor row to calculate relative button row
        // The button bar is `buttonRowOffset` rows above the current cursor
        // We use the click row directly — the terminal sends absolute rows
        // Since we can't easily know the absolute row of the buttons,
        // we check if the click col matches any button zone regardless of row
        // This is a pragmatic simplification since the button bar is always visible
        for (const zone of zones) {
            if (event.col >= zone.startCol && event.col <= zone.endCol) {
                disableMouseTracking();
                onAction(zone.cmd);
                return;
            }
        }
    };

    process.stdin.on('data', handler);

    return () => {
        process.stdin.removeListener('data', handler);
        disableMouseTracking();
    };
}

/** Show readline-based action menu as fallback */
export function showActionMenu(rl: any): Promise<string | null> {
    return new Promise((resolve) => {
        console.log(`\n  ${c.bold}${c.purple}⚡ Actions${c.reset}`);
        for (let i = 0; i < ACTION_BUTTONS.length; i++) {
            const item = ACTION_BUTTONS[i];
            console.log(`  ${c.cyan}${c.bold}${i + 1}${c.reset} ${item.icon}  ${item.label}`);
        }
        console.log('');

        rl.question(`  ${c.dim}Select (1-${ACTION_BUTTONS.length}) or Enter to cancel:${c.reset} `, (answer: string) => {
            const num = parseInt(answer.trim(), 10);
            if (num >= 1 && num <= ACTION_BUTTONS.length) {
                resolve(ACTION_BUTTONS[num - 1].cmd);
            } else {
                resolve(null);
            }
        });
    });
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
