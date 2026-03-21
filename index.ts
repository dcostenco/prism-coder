#!/usr/bin/env node
import { startServer, createSandboxServer } from "./src/server.js";

// Re-export for Smithery capability scanning
export { createSandboxServer };

const isDebug = process.env.PRISM_DEBUG === "true";

if (isDebug) {
  console.error("Starting Brave-Gemini Research MCP Server...");
  console.error(`Environment variables:
  NODE_ENV: ${process.env.NODE_ENV}
  BRAVE_API_KEY: ${process.env.BRAVE_API_KEY ? "Present" : "Missing"}
  BRAVE_ANSWERS_API_KEY: ${process.env.BRAVE_ANSWERS_API_KEY ? "Present" : "Missing"}
  GOOGLE_API_KEY: ${process.env.GOOGLE_API_KEY ? "Present" : "Missing"}
`);
}

// Add more responsive signal handling
process.on('SIGINT', () => {
  console.error('Received SIGINT signal, shutting down gracefully');
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Run the server
startServer().then(() => {
  if (isDebug) console.error("Brave-Gemini Research MCP Server started successfully");
}).catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
