### 🧪 Verified Zero-Search Implementation
The core unbinding engine is verified via Synalux's cognitive testing suite:
- **Core Math**: [Holographic Reduced Representations (hdc.ts)](./src/sdm/hdc.ts)
- **Unit Tests**: [HDC Performance & Capacity Tests](./tests)
- **Benchmarks**: [O(1) Retrieval Comparison Script](./tests/verification/cli-integration.test.ts)

> Informed by Anderson's ACT-R (Adaptive Control of Thought—Rational), Collins & Loftus spreading activation networks (1975), Kanerva's SDM (1988), Hebb's learning rule, and LeCun's "Why AI Systems Don't Learn" (Dupoux, LeCun, Malik).

---

## 🛡️ HIPAA & Security

Prism is built for high-compliance environments where data privacy is non-negotiable.

- **Local-First Architecture:** By default, all memory, embeddings, and cognitive processing happen on your device. No clinical data or PHI ever leaves your infrastructure.
- **Fail-Closed Pipelines:** The "Dark Factory" pipeline ensures that if any security gate (PII detection, adversarial check) fails, the entire process is halted immediately.
- **SCM Scan & Audit:** Integrated tools for secret detection in codebases and Dockerfile analysis, with immutable audit trails for every agent decision.
- **HIPAA Hardened:** Optimized for secure clinical deployments, with zero-retention defaults and encryption at rest.

---

## 💼 Business & Enterprise Support

Prism MCP is open-source and free for individual developers under the BUSL-1.1 license. For teams and enterprises building autonomous AI workflows or integrating MCP-native memory at scale, we offer professional consulting and setup packages.

### 🥉 Team Pilot Package
*Perfect for engineering teams adopting MCP tools and collaborative agents.*
* **What's included:** Full team rollout, managed Supabase configuration (for multi-device sync), Universal Import of legacy chat history, and dedicated setup support.
* **Model:** Fixed-price engagement.

### 🥈 Cognitive Architecture Tuning
*For teams building advanced AI agents or autonomous pipelines.*
* **What's included:** "Dark Factory" pipeline implementation tailored to your workflows, adversarial evaluator tuning, custom HDC cognitive route configuration, and local open-weight model integration (BYOM).
* **Model:** Retainer or project-based.

### 🥇 Enterprise Integration
*Full-scale deployment for high-compliance environments.*
* **What's included:** Active Directory / custom JWKS auth integration, Air-gapped on-premise deployment, custom OTel Grafana dashboards for cognitive observability, and custom skills/tools development.
* **Model:** Custom enterprise quote.

**Interested in accelerating your team's autonomous workflows?**
[📧 Contact us for a consultation](mailto:dmitri@synalux.ai) — let's build your organization's cognitive memory engine.

---

## <a name="milestones-roadmap"></a>📦 Milestones & Roadmap

> **Current: v12.0.0** — Unified Billing & Agent Skill Ecosystem ([CHANGELOG](CHANGELOG.md))

| Release | Headline |
|---------|----------|
| **v12.0.0** | 💳 **Unified Billing & Agent Skill Ecosystem** — Synalux-priced tiers ($19/$49/$99), 14-day trial, 54 skills, BUSL-1.1 license. |
| **v11.6.0** | 🏗️ **Agent Infrastructure Resilience** — Production-grade serialized queue, memory guardian, queue watchdog, status dashboard. 115/115 tests. |
| **v11.5.1** | 🧠 **Structural GRPO Alignment** — Perfect 100% accuracy cross-validated on Synalux Elite platform. |
| **v11.0.1** | 🧪 **Production Stability** — Field-tested Zero-Search logic merge, local logic finalization, HIPAA-hardened security refinement. |
| **v11.0** | 🧠 **Zero-Search Retrieval** — Holographic Reduced Representations (HRR) + Deep Research Intelligence [🧪 Field Testing - Synalux](https://synalux.ai/docs) |
| **v10.0** | 🛡️ **HIPAA-Hardened Local LLM** — `prism-coder:7b` powers compaction + task routing 100% on-device. |
| **v9.14** | 🧬 Dynamic Hardware Routing & Semantic Tool RAG — MLX SFT pipeline, Nomic pruning, GRPO alignment |
| **v9.13** | 🔬 Local Embeddings & Zero-API-Key Semantic Search — `nomic-embed-text-v1.5` on-device |
| **v9.5** | 🛡️ Adversarial Behavioral Hardening — 24 forbidden openers, XML anti-tag system, sycophancy defense |
| **v9.4** | 🔒 Security Sweep — command injection, path traversal, CORS, fail-closed rate limiter, bidirectional sync |
| **v9.0** | 🧠 Autonomous Cognitive OS — Surprisal Gate, Cognitive Budget, Affect-Tagged Memory |
| **v7.8** | 🧠 Cognitive Architecture — Hebbian consolidation, multi-hop reasoning, rejection gate |
| **v7.0** | 🧬 ACT-R Activation Memory |

### Future Tracks
- **v12.0: Distal Memory** — Semantic clustering of long-term history with Active-Prism background maintenance.
- **v13.0: Team Handoff** — Encrypted peer-to-peer session syncing with multi-agent task routing and verifiable memory.

👉 **[Full ROADMAP.md →](ROADMAP.md)**


## <a name="troubleshooting-faq"></a>❓ Troubleshooting FAQ

**Q: Why is the dashboard project selector stuck on "Loading projects..."?**
A: Fixed in v7.3.3. The root cause was a multi-layer quote-escaping trap in the `abortPipeline` onclick handler that generated a `SyntaxError` in the browser, silently killing the entire dashboard IIFE. Update to v7.3.3+ (`npx -y prism-mcp-server`). If still stuck, check that Supabase env values are properly set (unresolved placeholders like `${SUPABASE_URL}` cause `/api/projects` to return empty). Prism auto-falls back to local SQLite when Supabase is misconfigured.

**Q: Why is semantic search quality weak or inconsistent?**
A: Check embedding provider configuration and key availability. Missing embedding credentials reduce semantic recall quality and can shift behavior toward keyword-heavy matches.

**Q: How do I delete a bad memory entry?**
A: Use `session_forget_memory` for targeted soft/hard deletion. For manual cleanup and merge workflows, use the dashboard graph editor.

**Q: How do I verify the install quickly?**
A: Run `npm run build && npm test`, then open the Mind Palace dashboard (`localhost:3000`) and confirm projects load plus Graph Health renders.


---

### 💡 Known Limitations & Quirks

- **Some advanced text features may still benefit from a cloud API key.** While `prism-coder:7b` handles core compaction and routing, high-level features like Morning Briefings and complex VLM captioning are optimized for cloud providers (`GOOGLE_API_KEY`, `OPENAI_API_KEY`, or `ANTHROPIC_API_KEY`). Semantic search and basic compaction work 100% offline with `embedding_provider=local`.
- **Auto-load is model- and client-dependent.** Session auto-loading relies on both the LLM following system prompt instructions *and* the MCP client completing tool registration before the model's first turn. Prism provides platform-specific [Setup Guides](#setup-guides) and a server-side fallback (v5.2.1) that auto-pushes context after 10 seconds.
- **MCP client race conditions.** Some MCP clients may not finish tool enumeration before the model generates its first response, causing transient `unknown_tool` errors. This is a client-side timing issue — Prism's server completes the MCP handshake in ~60ms. Workaround: the server-side auto-push fallback and the startup skill's retry logic.
- **No real-time sync without Supabase.** Local SQLite mode is single-machine only. Multi-device or team sync requires a Supabase backend.
- **Embedding quality varies by provider.** Gemini `text-embedding-004` and OpenAI `text-embedding-3-small` produce high-quality 768-dim vectors. Prism passes `dimensions: 768` via the Matryoshka API for OpenAI models (native output is 1536-dim; this truncation is lossless and outperforms ada-002 at full 1536 dims). Local embeddings (`nomic-embed-text-v1.5` via `@huggingface/transformers`) provide good quality with zero API cost. Ollama embeddings are usable but may reduce retrieval accuracy.
- **Dashboard is HTTP-only.** The Mind Palace dashboard at `localhost:3000` does not support HTTPS. For remote access, use a reverse proxy (nginx/Caddy) or SSH tunnel. Basic auth is available via `PRISM_DASHBOARD_USER` / `PRISM_DASHBOARD_PASS`. JWKS JWT auth is available via `PRISM_JWKS_URI` for agent-native authentication (works with Auth0, AgentLair ([llms.txt](https://agentlair.com/llms.txt)), Keycloak, Cognito, or any standard JWKS endpoint).
- **Long-lived clients can accumulate zombie processes.** MCP clients that run for extended periods (e.g., Claude CLI) may leave orphaned Prism server processes. The lifecycle manager detects true orphans (PPID=1) but allows coexistence for active parent processes. Use `PRISM_INSTANCE` to isolate instances across clients.
- **Migration is one-way.** Universal Import ingests sessions *into* Prism but does not export back to Claude/Gemini/OpenAI formats. Use `session_export_memory` for portable JSON/Markdown export, or the `vault` format for Obsidian/Logseq-compatible `.zip` archives.
- **Export ceiling at 10,000 ledger entries.** The `session_export_memory` tool and the dashboard export button cap vault/JSON exports at 10,000 entries per project as an OOM guard. Projects exceeding this limit should use per-project exports and time-based filtering to stay within the ceiling. This limit does not affect search or context loading.
- **No Windows CI testing.** Prism is developed and tested on macOS/Linux. It should work on Windows via Node.js, but edge cases (file paths, PID locks) may surface.

---

## License

BUSL-1.1

---

<sub>**Keywords:** MCP server, Model Context Protocol, Claude Desktop memory, persistent session memory, AI agent memory, cognitive architecture, ACT-R spreading activation, Hebbian learning, episodic semantic consolidation, multi-hop reasoning, uncertainty rejection gate, local-first, SQLite MCP, Mind Palace, time travel, visual memory, VLM image captioning, OpenTelemetry, GDPR, agent telepathy, multi-agent sync, behavioral memory, cursorrules, Ollama MCP, Brave Search MCP, TurboQuant, progressive context loading, knowledge management, LangChain retriever, LangGraph agent, business, enterprise, hipaa</sub>
