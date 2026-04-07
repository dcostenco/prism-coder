# How We Built an AI Agent Memory System That Scores 92.3% on LongMemEval

If you've ever built an AI agent using standard RAG (Retrieval-Augmented Generation), you know the pain: as the chat history grows, the agent’s context window fills with repetitive boilerplate, hallucinations increase, and API costs skyrocket.

We recently launched **Prism (v9.0)**, an open-source Autonomous Cognitive OS for MCP (Model Context Protocol). We wanted to prove that our cognitive architecture isn't just theory—it actually outperforms standard RAG and memory vector maps. 

To prove it, we ran Prism against **[LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025)**, the gold standard benchmark for long-term chat memory systems. 

The result? Prism achieved **92.3% R@5 overall**, positioning it near the very top of the community leaderboards. Here is exactly how we built it, why it works, and how you can run it.

## The Benchmark: What is LongMemEval?

LongMemEval tests five core abilities of an agent's memory:
1. Information Extraction
2. Multi-Session Reasoning
3. Knowledge Updates
4. Temporal Reasoning
5. Abstention (Knowing when to say "I don't know")

It simulates hundreds of historical sessions per "user" and asks complex questions requiring the agent to retrieve exactly the right context from the haystack.

### Prism's Results
| Category | Prism R@5 | 
|----------|-----|
| **Overall** | **92.3%** |
| single-session-assistant | 98.2% | 
| multi-session | 95.9% | 
| single-session-preference | 93.3% |
| knowledge-update | 91.7% | 
| temporal-reasoning | 89.0% | 
| single-session-user | 87.5% | 

> *Methodology: Hybrid retrieval (FTS5 + vector cosine similarity) using `nomic-embed-text` embeddings via Ollama. Backed by libSQL locally.*

## The Secret Sauce: Moving Beyond Flat Vector DBs

Standard RAG treats memory as a bottomless text file. Prism treats memory like a **human cognitive system**. We achieved our LongMemEval scores using three specific architectural shifts:

### 1. Token-Economic RL (The Surprisal Gate)
Agent memory shouldn't be infinite. Prism introduces a **Cognitive Budget**. When an agent wants to save a memory, Prism runs a Vector-Based Surprisal calculation against recent history.
* **Redundant Boilerplate** costs 2.0x tokens.
* **Novel, Compressed Insights** cost 0.5x tokens. 

The physics of the system mathematically forces the LLM to learn data compression. It learns to store *principles*, instead of raw logs. This makes retrieval incredibly dense and accurate.

### 2. Affect-Tagged Memory (Giving AI a "Gut Feeling")
Vector math measures *semantic similarity*, but standard RAG doesn't measure *sentiment or outcome*.
When Prism stores outcomes (Success or Failure), it tags the memory with an **Affective Valence** (-1.0 to +1.0). At retrieval time, the absolute magnitude (`|valence|`) boosts the memory's ranking score. 

If an agent queries an architecture pattern that historically caused a production outage, it doesn't just get the text back—it receives a warning from Prism.

### 3. The Synapse Engine (GraphRAG without GraphDBs)
When Prism compresses memories, it extracts causal links (`caused_by`, `led_to`) forming an associative memory graph on top of standard SQLite. We traverse this graph using **ACT-R spreading activation**. 

When searching for "Error X", Prism doesn't just return the error log. The engine's multi-hop propagation traverses the causal edges, surfacing "Workaround Y" linked to "Decision Z". This is what lets Prism excel at the `multi-session` and `temporal-reasoning` categories in LongMemEval.

## Get Started with Prism

Prism is open-source and built specifically for the **Model Context Protocol (MCP)**. It works instantly with Claude Desktop, Cursor, Windsurf, or Cline.

```bash
npx -y prism-mcp-server
```

You can point it to a local SQLite file for 100% offline data privacy or a Supabase instance for team synchronization. 

Check out the full repository and benchmark harness here:
[GitHub - dcostenco/prism-mcp](https://github.com/dcostenco/prism-mcp)

*(We'd love to hear how it performs on your massive codebases!)*
