
import { spawn } from 'child_process';

async function checkSchema(packageName, version) {
    return new Promise((resolve) => {
        // Construct npx command
        const cmd = 'npx';
        const args = ['-y', `${packageName}@${version}`];

        // Start process
        const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });

        let buffer = '';

        // Send initialization request
        const initReq = {
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
                protocolVersion: "2024-11-05",
                capabilities: {},
                clientInfo: { name: "test-client", version: "1.0" }
            }
        };

        proc.stdin.write(JSON.stringify(initReq) + '\n');

        proc.stdout.on('data', (data) => {
            buffer += data.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep incomplete line

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const msg = JSON.parse(line);
                    if (msg.id === 1) {
                        // Initialized, now fetch tools
                        const toolsReq = {
                            jsonrpc: "2.0",
                            id: 2,
                            method: "tools/list"
                        };
                        proc.stdin.write(JSON.stringify(toolsReq) + '\n');
                        // Notification initialized
                        proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + '\n');
                    } else if (msg.id === 2) {
                        // Got tools
                        resolve(msg.result);
                        proc.kill();
                    }
                } catch (e) {
                    // ignore parsing errors for partial lines
                }
            }
        });

        setTimeout(() => {
            proc.kill();
            resolve(null);
        }, 10000); // 10s timeout
    });
}

async function run() {
    console.log("Checking MCP schemas...");

    // Check camoufox 1.1.0 (schema compatible with Claude Code VS Code tool validator)
    console.log("Checking camoufox 1.1.0...");
    const c11 = await checkSchema("camoufox-mcp-server", "1.1.0");
    if (c11) {
        // Look for browse tool schema
        const browse = c11.tools.find(t => t.name === "mcp__camoufox__browse" || t.name === "browse" || t.name === "camoufox_browse");
        if (browse) {
            console.log("Camoufox 1.1.0 'browse' schema:", JSON.stringify(browse.inputSchema, null, 2));
        } else {
            console.log("Camoufox 1.1.0 'browse' tool not found. Tools: " + c11.tools.map(t => t.name));
        }
    }
}

run();
