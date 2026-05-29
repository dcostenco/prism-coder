import { type Tool } from "@modelcontextprotocol/sdk/types.js";

export const KNOWLEDGE_INGEST_TOOL: Tool = {
  name: "knowledge_ingest",
  description:
    "Ingest source code or documentation into the knowledge graph. " +
    "Feed your codebase to Prism so knowledge_search can retrieve it at inference time. " +
    "Accepts raw source code, file paths, or a git repo URL. " +
    "The content is chunked, Q&A pairs are generated, and stored in the knowledge graph. " +
    "Use this when the user says 'learn this code', 'index my repo', or 'ingest this file'.",
  inputSchema: {
    type: "object",
    properties: {
      project: {
        type: "string",
        description: "Project identifier for the knowledge namespace (e.g. 'my-backend', 'prism-aac').",
      },
      content: {
        type: "string",
        description: "Raw source code or documentation text to ingest. Max 50,000 chars.",
      },
      file_path: {
        type: "string",
        description: "Local file path to read and ingest. Alternative to providing content directly.",
      },
      source_label: {
        type: "string",
        description: "Human-readable label for the source (e.g. 'auth-middleware', 'payment-flow'). Used in search results.",
      },
      chunk_size: {
        type: "number",
        description: "Characters per chunk (default: 4000). Smaller chunks = more granular Q&A.",
        default: 4000,
      },
    },
    required: ["project"],
  },
};
