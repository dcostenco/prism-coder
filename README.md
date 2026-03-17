# AI-Driven MCP Server Platform & Vertex AI Integration

> Production-grade **Model Context Protocol (MCP)** infrastructure and **Google Cloud Vertex AI** applications — combining LLM-powered data retrieval, research analysis, and cross-system API orchestration with enterprise search and discovery capabilities.

---

## Overview

This repository contains two complementary AI systems:

1. **MCP Server Platform** — A multi-tool TypeScript/Python server that integrates Large Language Models with heterogeneous data sources through the standardized Model Context Protocol
2. **Vertex AI Applications** — Google Cloud–based AI services including Discovery Engine (Vertex AI Search), Gemini model integration, and Claude-on-Vertex deployment

| Capability | Implementation |
|---|---|
| **MCP Server Architecture** | Multi-tool server with `@modelcontextprotocol/sdk`, structured request handling, and extensible tool registration |
| **Vertex AI Search / Discovery Engine** | Enterprise search index with document ingestion, serving configs, and structured query APIs |
| **LLM Integration** | Claude Desktop, Google Gemini, and Claude-on-Vertex AI with secure prompt patterns |
| **API Orchestration** | Brave Search, Gemini, Gmail, Chrome DevTools Protocol, and GCP Discovery Engine APIs |
| **Data Pipelines** | JavaScript-based extraction transforms over raw JSON/CSV payloads |
| **Security & IP Protection** | GCP Application Default Credentials, OAuth 2.0, encrypted credential management, env-based secrets |
| **Testing & Validation** | Cross-MCP integration tests, Vertex AI verification scripts, schema validation, and benchmarks |

## Architecture

```
┌────────────────────┐        MCP Protocol (stdio)        ┌──────────────────────────┐
│   AI Client        │ ◄───────────────────────────────── │    MCP Server            │
│   (Claude Desktop) │                                    │    (TypeScript + Python)  │
└────────────────────┘                                    └────────────┬─────────────┘
                                                                      │
                    ┌──────────────────┬──────────────────┼──────────────────┬────────────────────┐
                    │                  │                  │                  │                    │
           ┌───────▼────────┐ ┌───────▼───────┐ ┌───────▼────────┐ ┌──────▼──────────┐ ┌───────▼──────────────┐
           │  Brave Search  │ │  Gemini API   │ │  Gmail OAuth   │ │ Chrome DevTools │ │  Vertex AI Search    │
           │  (Web + Local) │ │  (Analysis)   │ │  (Data Pipe)   │ │ (MCP Introspect)│ │  (Discovery Engine)  │
           └────────────────┘ └───────────────┘ └────────────────┘ └─────────────────┘ └──────────────────────┘

                    ┌──────────────────────────────────────────────────────┐
                    │              Google Cloud (Vertex AI)               │
                    │                                                      │
                    │  ┌──────────────┐  ┌─────────────┐  ┌────────────┐  │
                    │  │ Discovery    │  │ Gemini SDK  │  │ Claude on  │  │
                    │  │ Engine /     │  │ (Vertex AI) │  │ Vertex AI  │  │
                    │  │ AI Search    │  │             │  │ (Anthropic)│  │
                    │  └──────────────┘  └─────────────┘  └────────────┘  │
                    └──────────────────────────────────────────────────────┘
```

## Core Components

### 1. MCP Server (`src/`, `index.ts`)

The backbone of the platform — a TypeScript MCP server that registers and exposes multiple tools via the Model Context Protocol standard.

- **Server entry point** with stdio transport binding
- **Modular tool definitions** with JSON Schema parameter validation
- **Request handlers** with structured error handling and response formatting
- **Config management** with environment-variable-driven API key injection

### 2. Vertex AI Applications (`vertex-ai/`)

Integration layer connecting Google Cloud's Vertex AI services with the MCP search pipeline, enabling hybrid retrieval and multi-model analysis:

| Component | Description | GCP Service |
|-----------|-------------|-------------|
| `verify_discovery_engine.ts` | Queries and validates a Discovery Engine search index with structured result parsing | Vertex AI Search / Discovery Engine |
| `test_gemini_vertex.py` | Gemini model invocation via the Vertex AI Python SDK with ADC authentication | Vertex AI Generative Models |
| `test_claude_vertex.py` | Claude model deployment via Anthropic's Vertex AI integration with multi-region failover | Claude on Vertex AI (Model Garden) |

**Key capabilities:**
- **Discovery Engine Search** — Document ingestion, index building, and structured query execution via `@google-cloud/discoveryengine` SDK
- **Multi-model orchestration** — Seamless switching between Gemini and Claude models through the same GCP project
- **Application Default Credentials (ADC)** — Secure, keyless authentication using `gcloud auth application-default login`
- **Multi-region failover** — Automatic region rotation for Claude on Vertex AI (`us-east5`, `us-central1`, `europe-west1`)

### Hybrid Search Pipeline: MCP + Vertex AI Discovery Engine

The platform's core architectural advantage is combining **real-time web search** (via MCP/Brave) with **enterprise-curated search** (via Vertex AI Discovery Engine) in a unified pipeline:

```
Query ──► MCP Server
           ├── brave_web_search ──────────► Real-time web results
           ├── Discovery Engine ──────────► Curated enterprise index
           └── code_mode_transform ───────► Merged, deduplicated, normalized output
                                                   │
                                           gemini_research_paper_analysis
                                                   │
                                           Structured analysis (LLM)
```

**Why a hybrid pipeline?** Each source has distinct strengths — the enhancement comes from combining them, not replacing one with the other:

| Dimension | 🌐 Brave Search (MCP) | 🔍 Discovery Engine (Vertex AI) | 🔀 Hybrid (Combined) |
|-----------|----------------------|----------------------------------|----------------------|
| **Coverage** | Public web — broad, real-time | Curated document index — deep, domain-specific | **Both:** breadth + depth |
| **Result quality** | Keyword-ranked web pages | ML-ranked with semantic understanding | **Deduplicated, best-of-both** |
| **Speed** | **~200ms** (live search) | ~900ms (pre-indexed retrieval) | ~2.4s sequential (both stages) |
| **Context efficiency** | 93% reduction via `code_mode_transform` | 95% reduction (pre-structured data) | 94% overall (71 KB → 4.1 KB) |
| **Token savings** | **~10,074 / query** | **~7,087 / query** | Combined: **~17K tokens saved** |
| **Freshness** | Real-time (seconds old) | Managed re-crawl schedules | Real-time + deep archive |
| **Model routing** | Single Gemini API key | Multi-model (Gemini + Claude) via GCP | Full model flexibility |

The `code_mode_transform` tool is the key performance enabler — it runs sandboxed JavaScript over raw API payloads to extract only the relevant fields before passing data to the LLM, reducing context window usage by **85-95%** (measured via the built-in `benchmark.ts` suite). When combined with Discovery Engine's pre-structured results, the total pipeline achieves significantly lower token consumption compared to raw web scraping approaches.

### Verified Test Results

Benchmark data from [`test_pipeline_benchmark.ts`](vertex-ai/test_pipeline_benchmark.ts) (5 queries × 3 iterations each):

| Metric | 🌐 Brave (MCP) | 🔍 Discovery Engine | Hybrid Total |
|--------|----------------|---------------------|--------------|
| **Avg latency** | 220ms | 1,193ms | ~1.4s (sequential) |
| **Avg raw payload** | 42.4 KB | 28.9 KB | 71.3 KB total input |
| **Avg reduced payload** | 3.0 KB | 1.2 KB | **4.2 KB total** (94% reduction) |
| **Token savings** | ~10,103 | ~7,097 | **~17,200 tokens saved / query** |

End-to-end pipeline results from [`test_hybrid_search_pipeline.ts`](vertex-ai/test_hybrid_search_pipeline.ts):

| Pipeline Stage | Results | Latency | Payload |
|----------------|---------|---------|--------|
| Stage 1: Brave Web Search | 5 results | 520ms | 24.1 KB raw |
| Stage 2: Discovery Engine | 5 results | 1,895ms | 23.1 KB raw |
| Stage 3: Merge & Dedup | **9 unique** (1 duplicate removed) | <1ms | 2.6 KB → 1.4 KB |
| Stage 4: Gemini Analysis | Structured summary | 4,919ms | — |
| **Total Pipeline** | **9 merged results** | **7.3s end-to-end** | **~17K tokens saved** |

> *"The web search results provide practical understanding... the Discovery Engine results delve into specialized and cutting-edge topics from arXiv... Together, the sources provide a holistic perspective, bridging established techniques with advanced research."*
> — Gemini 2.5 Flash analysis output

### Real-World Comparison: Why the Hybrid Pipeline Matters

Results from [`test_realworld_comparison.ts`](vertex-ai/test_realworld_comparison.ts) — 3 real AI/ML queries comparing Brave-only vs Hybrid:

| Real-World Query | Brave Only | Hybrid | DE Added |
|-----------------|------------|--------|----------|
| *RLHF implementation* (AI engineer) | 10 results (2 academic) | 20 results (12 academic) | **+10 unique papers** |
| *INT8 quantization* (ML deployment) | 10 results (4 academic) | 20 results (14 academic) | **+10 unique papers** |
| *RAG architecture* (enterprise dev) | 10 results (0 academic) | 20 results (10 academic) | **+10 unique papers** |

**Key finding:** For the RAG query, Brave returned **zero academic sources** — only vendor docs (AWS, NVIDIA, IBM, Google Cloud). Discovery Engine filled this gap entirely with 10 peer-reviewed papers including the foundational RAG paper by Lewis et al.

| Aggregate Metric | Brave Only | Hybrid | Improvement |
|-----------------|------------|--------|-------------|
| **Avg results / query** | 10 | 20 | **+100%** |
| **Avg academic sources** | 2.0 | 12.0 | **+10 per query** |
| **Source overlap** | — | 0% | Fully complementary |
| **Unique DE contributions** | — | 30 total | 10 per query |

<details>
<summary><strong>Sample output: RAG Architecture query — Brave-only vs Hybrid</strong></summary>

**Brave Search returned** (0 academic sources):
```
[1] 🌐 Retrieval-augmented generation - Wikipedia (en.wikipedia.org)
[2] 🌐 Retrieval-Augmented Generation (RAG) | Pinecone (pinecone.io)
[3] 🌐 Introduction to RAG and Vector Databases (medium.com)
[4] 🌐 What is RAG? - AWS (aws.amazon.com)
[5] 🌐 RAG and vector databases - GitHub (github.com)
[6] 🌐 What is RAG? | Databricks (databricks.com)
[7] 🌐 What is RAG? | NVIDIA (nvidia.com)
[8] 🌐 What is RAG? | IBM (ibm.com)
[9] 🌐 What is RAG? | Confluent (confluent.io)
[10] 🌐 What is RAG? | Google Cloud (cloud.google.com)
```

**Discovery Engine added** (10 academic sources, 0 overlap):
```
[+1] 📚 Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks (arxiv.org)
[+2] 📚 Benchmarking Vector, Graph and Hybrid RAG (arxiv.org)
[+3] 📚 HybridRAG: Integrating Knowledge Graphs and Vector Retrieval (arxiv.org)
[+4] 📚 Adversarial Threat Vectors and Risk Mitigation for RAG (arxiv.org)
[+5] 📚 RAGdb: A Zero-Dependency, Embeddable Architecture (arxiv.org)
[+6] 📚 Building Scalable AI-Powered Applications with Cloud Databases (arxiv.org)
[+7] 📚 Federated Retrieval-Augmented Generation (FRAG) (arxiv.org)
[+8] 📚 A Systematic Review of Key RAG Components (arxiv.org)
[+9] 📚 From Traditional RAG to Agentic and Graph RAG (arxiv.org)
[+10] 📚 Accelerating Retrieval-Augmented Generation (arxiv.org)
```

</details>

### 3. Search & Data Extraction Tools

Six specialized tools for heterogeneous data retrieval and transformation:

| Tool | Purpose | Input | Output |
|------|---------|-------|--------|
| `brave_web_search` | Real-time internet search | Query string | Structured search results |
| `brave_local_search` | Location-based POI discovery | Query + location | Business/POI data |
| `brave_web_search_code_mode` | JS extraction over web results | Query + JS transform | Filtered fields |
| `brave_local_search_code_mode` | JS extraction over local results | Query + JS transform | Filtered fields |
| `code_mode_transform` | Universal post-processing | Raw data + JS transform | Normalized output |
| `gemini_research_paper_analysis` | Academic paper analysis | Paper text + analysis type | Structured analysis |

### 4. Data Pipeline Integrations (Python)

Python-based automation for API consumption and data manipulation:

- **Gmail API** — OAuth 2.0 authenticated email data retrieval and parsing
- **Chrome DevTools Protocol** — Programmatic MCP tool introspection and browser automation
- **Cross-MCP Testing** — Integration test suite validating tool interoperability across MCP servers

### 5. Universal Code Mode Transform

A powerful **post-processing layer** designed to normalize and extract specific fields from large MCP outputs. Supports ready-to-use templates for:

- GitHub Issues / Pull Requests → compact summaries
- Firecrawl scrape results → title + URL extraction
- Chrome DevTools network logs → method + URL + status
- Video transcripts → keyword-filtered timestamp extraction

## Technical Stack

| Layer | Technologies |
|-------|-------------|
| **Runtime** | Node.js 18+, TypeScript, `@modelcontextprotocol/sdk` |
| **Cloud AI** | Google Cloud Vertex AI, Discovery Engine, Gemini SDK, Anthropic Vertex SDK |
| **Data Processing** | Python 3.10+, JSON/CSV parsing, JavaScript extraction |
| **APIs** | Brave Search (Pro + Answers), Google Gemini, Gmail, Chrome DevTools, GCP Discovery Engine |
| **Auth & Security** | GCP ADC, OAuth 2.0, AES-encrypted credentials, env-based secrets injection |
| **Testing** | MCP schema validation, cross-server integration tests, Vertex AI verification, hybrid pipeline benchmarks |
| **Tooling** | Git, npm, gcloud CLI, Linux/macOS |

## Project Structure

```
├── src/
│   ├── server.ts                # MCP server core implementation
│   ├── config.ts                # Configuration & environment management
│   ├── tools/
│   │   ├── definitions.ts       # Tool schemas & parameter validation
│   │   ├── handlers.ts          # Tool execution logic
│   │   └── index.ts             # Tool registration
│   └── utils/                   # API clients & shared utilities
├── vertex-ai/
│   ├── verify_discovery_engine.ts       # Vertex AI Search index verification
│   ├── test_hybrid_search_pipeline.ts   # End-to-end hybrid pipeline test (MCP + DE)
│   ├── test_pipeline_benchmark.ts       # Performance benchmark: Brave vs DE
│   ├── test_realworld_comparison.ts     # Real-world side-by-side: Brave-only vs Hybrid
│   ├── test_gemini_vertex.py            # Gemini model via Vertex AI SDK
│   └── test_claude_vertex.py            # Claude model via Vertex AI (Anthropic)
├── index.ts                     # Server entry point
├── benchmark.ts                 # Performance benchmarking suite
├── test_mcp_schema.js           # MCP schema validation tests
├── test_cross_mcp.js            # Cross-MCP integration test suite
├── call_chrome_mcp.py           # Chrome DevTools MCP automation
├── execute_via_chrome_mcp.py    # Browser-driven MCP execution
├── list_chrome_tools.py         # MCP tool introspection utility
├── gmail_auth_test.py           # Gmail OAuth integration tests
├── gmail_list_latest_5.py       # Gmail data pipeline example
├── patch_cgc_mcp.py             # MCP compatibility patches
├── run_server.sh                # Server launch script
├── package.json                 # Dependencies & build config
└── tsconfig.json                # TypeScript configuration
```

## Getting Started

### Prerequisites
- Node.js 18+
- Python 3.10+
- npm
- Google Cloud SDK (`gcloud`) with Vertex AI enabled

### Installation
```bash
git clone https://github.com/dcostenco/BCBA.git
cd BCBA
npm install
npm run build
```

### GCP / Vertex AI Setup
```bash
# Authenticate for Vertex AI (no API keys needed — uses ADC)
gcloud auth application-default login

# Optional: set Discovery Engine env vars for hybrid search
export DISCOVERY_ENGINE_PROJECT_ID=<your-gcp-project>
export DISCOVERY_ENGINE_ENGINE_ID=<your-engine-id>
export DISCOVERY_ENGINE_LOCATION=global
export DISCOVERY_ENGINE_COLLECTION=default_collection
export DISCOVERY_ENGINE_SERVING_CONFIG=default_serving_config
```

### Configuration

All credentials are injected via environment variables or GCP Application Default Credentials — **no API keys are stored in this repository**.

Required environment variables (set via your shell profile or a `.env` file, which is `.gitignore`’d):

- `BRAVE_API_KEY` — Brave Search Pro subscription
- `GEMINI_API_KEY` — Google AI Studio API key
- `DISCOVERY_ENGINE_PROJECT_ID` — GCP project with Discovery Engine enabled
- `DISCOVERY_ENGINE_ENGINE_ID` — Your Discovery Engine app/engine ID

### Running
```bash
# MCP Server
npm start

# Vertex AI Discovery Engine verification
npx ts-node vertex-ai/verify_discovery_engine.ts

# Vertex AI model tests
python3 vertex-ai/test_gemini_vertex.py
python3 vertex-ai/test_claude_vertex.py

# Hybrid pipeline test (MCP + Discovery Engine end-to-end)
npx ts-node vertex-ai/test_hybrid_search_pipeline.ts

# Performance benchmark (Brave Search vs Discovery Engine)
npx ts-node vertex-ai/test_pipeline_benchmark.ts
```

### Claude Desktop Integration

Add the server to your Claude Desktop MCP config (credentials are passed via environment variables):

```json
{
  "mcpServers": {
    "research-platform": {
      "command": "node",
      "args": ["<path>/build/index.js"],
      "env": {
        "BRAVE_API_KEY": "${BRAVE_API_KEY}",
        "GEMINI_API_KEY": "${GEMINI_API_KEY}",
        "DISCOVERY_ENGINE_PROJECT_ID": "${DISCOVERY_ENGINE_PROJECT_ID}",
        "DISCOVERY_ENGINE_ENGINE_ID": "${DISCOVERY_ENGINE_ENGINE_ID}"
      }
    }
  }
}
```

## Key Design Decisions

- **Protocol-first architecture** — All tools are exposed through the standardized MCP interface, ensuring compatibility with any MCP-compliant AI client
- **Cloud-native AI** — Vertex AI integration provides enterprise-grade model access with GCP's security, quota management, and multi-region support
- **Multi-model strategy** — Supports Gemini and Claude through the same GCP infrastructure, enabling model selection based on task requirements
- **Separation of concerns** — Tool definitions, handlers, and configuration are cleanly separated for maintainability
- **Security by design** — No hardcoded credentials; all secrets flow through environment variables, ADC, or encrypted stores
- **Extensibility** — New tools can be registered by adding a definition + handler without modifying the server core
- **Cross-system interoperability** — Universal transform layer enables output normalization across heterogeneous MCP servers

## License

MIT
