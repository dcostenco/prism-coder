#!/usr/bin/env node
// Thin shim — delegates to prism-mcp-server's compiled server entry point.
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const require = createRequire(import.meta.url);

// Resolve prism-mcp-server relative to this package's node_modules
let serverPath;
try {
  serverPath = require.resolve('prism-mcp-server/dist/server.js');
} catch {
  process.stderr.write(
    'prism-coder: could not resolve prism-mcp-server. Run: npm install\n'
  );
  process.exit(1);
}

await import(serverPath);
