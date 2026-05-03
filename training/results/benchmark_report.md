# Prism LLM Benchmark Report

## Model Configuration
| Setting | Value |
|---------|-------|
| **Base Model** | Qwen 2.5 Coder 7B Instruct |
| **Adapter** | None |
| **Hardware** | Apple M5 Max, 48GB |
| **Framework** | MLX |

## Overall Results

| Metric | Score |
|--------|-------|
| **Tool-Call Accuracy** | 87.2% |
| **JSON Validity** | 100.0% |
| **Parameter Accuracy** | 92.3% |
| **Avg Latency** | 3891ms |
| **Tokens/Second** | 19.3 |
| **Avg Tokens/Response** | 75 |

## Category Breakdown

| Category | Accuracy | Count |
|----------|----------|-------|
| adversarial | 100.0% | 8 |
| edge_case | 100.0% | 5 |
| reasoning | 100.0% | 5 |
| retrieval | 50.0% | 2 |
| tool_call | 78.9% | 19 |

## Detailed Results

| # | Status | Category | Prompt | Expected | Got |
|---|--------|----------|--------|----------|-----|
| 1 | ✅ | tool_call | Show me the context for docs-portal | session_load_context | session_load_context |
| 2 | ❌ | tool_call | Record this work: migrated Stripe webhooks to v2 A | session_save_ledger | session_save_experience |
| 3 | ✅ | retrieval | Look up past work on the OAuth2 refresh flow | session_search_memory | session_search_memory |
| 4 | ✅ | tool_call | Save the current handoff state for docs-portal pro | session_save_handoff | session_save_handoff |
| 5 | ❌ | tool_call | Remove the memory about the failed deploy last Fri | session_forget_memory | knowledge_forget |
| 6 | ✅ | tool_call | Run a health check on the memory system | session_health_check | session_health_check |
| 7 | ❌ | retrieval | What do we know about edge function cold starts? | knowledge_search | None |
| 8 | ✅ | tool_call | Compact old ledger entries for the prism-mcp proje | session_compact_ledger | session_compact_ledger |
| 9 | ✅ | tool_call | Export all memory data for billing-portal to my de | session_export_memory | session_export_memory |
| 10 | ✅ | tool_call | Should the local agent or the cloud agent handle t | session_task_route | session_task_route |
| 11 | ✅ | tool_call | Upvote that memory about the RBAC fix — it was rea | knowledge_upvote | knowledge_upvote |
| 12 | ✅ | tool_call | Downvote the stale entry about the old API endpoin | knowledge_downvote | knowledge_downvote |
| 13 | ✅ | tool_call | Backfill graph edges for the prism-mcp project | session_backfill_links | session_backfill_links |
| 14 | ✅ | tool_call | Find semantic relationships between memory nodes f | session_synthesize_edges | session_synthesize_edges |
| 15 | ✅ | tool_call | Show me the memory version history for prism-mcp | memory_history | memory_history |
| 16 | ❌ | tool_call | Restore the prism-mcp memory to version 3 | memory_checkout | session_checkout |
| 17 | ✅ | tool_call | Log a success event: deployed the billing module w | session_save_experience | session_save_experience |
| 18 | ✅ | tool_call | Forget all knowledge entries older than 90 days | knowledge_forget | knowledge_forget |
| 19 | ✅ | tool_call | Generate a professional image of a modern clinic d | image_gen | image_gen |
| 20 | ✅ | tool_call | Read this text aloud in Spanish for the patient su | tts | tts |
| 21 | ❌ | tool_call | Verify HIPAA compliance for the new data storage e | hipaa | session_health_check |
| 22 | ✅ | reasoning | What is the difference between gRPC and REST? | None | None |
| 23 | ✅ | reasoning | How does garbage collection work in Go? | None | None |
| 24 | ✅ | reasoning | Explain the CAP theorem in simple terms | None | None |
| 25 | ✅ | reasoning | What are the pros and cons of microservices? | None | None |
| 26 | ✅ | reasoning | Write a bash one-liner to find large files | None | None |
| 27 | ✅ | adversarial | How does session replication work in distributed s | None | None |
| 28 | ✅ | adversarial | What is the difference between stack memory and he | None | None |
| 29 | ✅ | adversarial | Explain how load balancing works across multiple s | None | None |
| 30 | ✅ | adversarial | What is knowledge distillation in machine learning | None | None |
| 31 | ✅ | adversarial | How do you implement a search algorithm for a grap | None | None |
| 32 | ✅ | adversarial | How do I save data to localStorage in the browser? | None | None |
| 33 | ✅ | adversarial | Explain how to export a module in Node.js | None | None |
| 34 | ✅ | adversarial | What is task routing in distributed systems like C | None | None |
| 35 | ✅ | edge_case | Search for what we decided about the caching layer | session_search_memory | session_search_memory |
| 36 | ✅ | edge_case | Can you check if the memory system is healthy and  | session_health_check | session_health_check |
| 37 | ✅ | edge_case | I want to clean up — compact and then export the p | session_compact_ledger | session_compact_ledger |
| 38 | ✅ | edge_case | Delete session abc-123 because it contains wrong i | session_forget_memory | session_forget_memory |
| 39 | ✅ | edge_case | What's in our knowledge base about Supabase RLS po | knowledge_search | knowledge_search |

---
*Generated at 2026-05-01 14:09:23*
