# Contributing to Prism MCP

Thanks for your interest in contributing to Prism MCP! 🧠

## Getting Started

1. **Fork** the repository
2. **Clone** your fork: `git clone https://github.com/YOUR_USERNAME/prism-mcp.git`
3. **Install** dependencies: `npm install`
4. **Build**: `npm run build`
5. **Test**: `npm test`

## Development

```bash
# Build TypeScript
npm run build

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Start the server
npm start
```

## Project Structure

```
src/
├── server.ts                 # MCP server entry point
├── config.ts                 # Environment variable configuration
├── backgroundScheduler.ts    # Background maintenance tasks
├── dashboard/                # Mind Palace web dashboard
│   ├── server.ts             # Dashboard HTTP server
│   ├── ui.ts                 # Dashboard UI template
│   └── graphRouter.ts        # Graph metrics API routes
├── storage/                  # Storage backends
│   ├── interface.ts          # Storage interface definition
│   ├── sqlite.ts             # SQLite implementation
│   └── supabase.ts           # Supabase implementation
├── tools/                    # MCP tool definitions and handlers
├── utils/                    # Shared utilities
└── observability/            # Metrics and telemetry
```

## Pull Request Process

1. Create a feature branch from `bcba`: `git checkout -b feature/your-feature`
2. Make your changes with clear, descriptive commits
3. Ensure all tests pass: `npm test`
4. Ensure the build succeeds: `npm run build`
5. Open a PR against the `bcba` branch

## Code Style

- TypeScript strict mode
- ES5-compatible inline scripts in the dashboard UI (`src/dashboard/ui.ts`)
- No `console.log` in production code — use `debugLog()` from `src/utils/logger.ts`

## Reporting Bugs

Open a [GitHub Issue](https://github.com/dcostenco/prism-mcp/issues) with:
- Prism version (`npm list prism-mcp-server`)
- Storage backend (SQLite or Supabase)
- Steps to reproduce
- Expected vs actual behavior

## Security

For security vulnerabilities, please see [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
