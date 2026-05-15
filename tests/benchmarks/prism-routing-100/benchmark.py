#!/usr/bin/env python3
"""
Prism Routing Benchmark — 100-case multi-model eval
Measures tool-routing accuracy across Prism's 7 MCP tools.

Usage:
  python3 benchmark.py                        # all models (requires Ollama + ANTHROPIC_API_KEY)
  python3 benchmark.py --models 14b sonnet    # specific models
  python3 benchmark.py --ollama-url http://192.168.1.10:11434  # remote Ollama

Models tested:
  - prism-coder:1b7   (Ollama local, on-device)
  - prism-coder:14b   (Ollama local, Mac M2 Pro+)
  - prism-coder:32b   (Ollama local, Mac M2 Ultra+)
  - claude-sonnet-4   (Anthropic API)
  - claude-opus-4-7   (Anthropic API)
"""

import argparse
import json
import os
import random
import re
import time
from typing import Optional

import anthropic
import requests

# ── Config ────────────────────────────────────────────────────────────────────

OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://localhost:11434")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "")

OLLAMA_MODELS = {
    "1b7": "dcostenco/prism-coder:1b7",
    "14b": "dcostenco/prism-coder:14b",
    "32b": "dcostenco/prism-coder:32b",
}
CLAUDE_MODELS = {
    "sonnet": "claude-sonnet-4-6",
    "opus":   "claude-opus-4-7",
}

# ── v25 System Prompt ─────────────────────────────────────────────────────────

SYSTEM_PROMPT = """CRITICAL: You have EXACTLY 7 tools. Their EXACT names are:
  session_load_context, session_save_ledger, session_save_handoff,
  session_compact_ledger, session_search_memory, knowledge_search, brave_web_search
DO NOT invent, create, or use any other tool name. "plain text" is NOT a tool — it means respond without any tool call.
If no rule matches exactly -> respond in plain text.
Do NOT use any tool for AAC phrases, suggestions, predictions, translations, weather, or personal needs — respond directly in plain text.

You are a helpful AI assistant with access to tools.
When a tool is needed, respond ONLY with:
<|tool_call|>
{"name": "tool_name", "arguments": {...}}
<|tool_call_end|>
If no tool is needed, respond in plain text.

TOOL ROUTING — apply TOP TO BOTTOM, first match wins:
1. current time / clock / what time is it -> respond directly (no tool)
2. weather / live stock prices / live sports scores -> respond directly (no tool)
3. translate / translation / "say X in Y" -> respond directly (no tool)
4. AAC phrases / suggest phrases / communication phrases -> respond directly (no tool)
5. simple personal needs/feelings (I want X, I feel X, I need X) -> respond directly (no tool)
6. static facts the model knows (capitals, history, math) -> respond directly (no tool)
7. write code / write regex / explain code / math -> respond directly (no tool)
8. handoff / pass to next agent / relay / transition notes -> session_save_handoff
9. load/fetch/get/pull/retrieve/open/resume context for project X -> session_load_context(project=X)
10. compact/archive/shrink/prune/trim the ledger -> session_compact_ledger
11. "google X" / search online / search the internet -> brave_web_search
12. look up current/news/recent info online -> brave_web_search
13. what did we discuss / previously talk about / session history -> session_search_memory
14. what have I recorded / find in my sessions / session notes -> session_search_memory
15. what do I know / knowledge base / stored knowledge -> knowledge_search
16. note: X / jot down / log / save / record / remember -> session_save_ledger

ONLY use tools listed above. NEVER invent tool names.
ALWAYS infer missing params; strip quotes from project names."""

TOOLS_SCHEMA = [
    {"name": "session_load_context",   "description": "Load session context for a project",   "input_schema": {"type": "object", "properties": {"project": {"type": "string"}}, "required": ["project"]}},
    {"name": "session_save_ledger",    "description": "Save completed work to ledger",         "input_schema": {"type": "object", "properties": {"project": {"type": "string"}, "summary": {"type": "string"}}, "required": ["project"]}},
    {"name": "session_save_handoff",   "description": "Save handoff for next session",         "input_schema": {"type": "object", "properties": {"project": {"type": "string"}, "summary": {"type": "string"}}, "required": ["project"]}},
    {"name": "session_search_memory",  "description": "Search previous session memories",      "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "session_compact_ledger", "description": "Compact the session ledger",            "input_schema": {"type": "object", "properties": {"project": {"type": "string"}}, "required": ["project"]}},
    {"name": "knowledge_search",       "description": "Search the knowledge base",             "input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
    {"name": "brave_web_search",       "description": "Search the web for current information","input_schema": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}},
]

# ── Test Case Pool (200 cases, 13 categories) ─────────────────────────────────

TEST_POOL = [
    # save — session_save_ledger
    ("save",  "Note: finished migrating the auth service to JWT",                  "session_save_ledger"),
    ("save",  "Jot down: resolved the TTS chipmunk bug in prism-aac",              "session_save_ledger"),
    ("save",  "Save a ledger for prism-mcp — completed BFCL eval",                "session_save_ledger"),
    ("save",  "Record today's progress on the synalux portal",                     "session_save_ledger"),
    ("save",  "Log that we fixed the NCCL training error",                         "session_save_ledger"),
    ("save",  "Keep this: upgraded Supabase client to v2",                         "session_save_ledger"),
    ("save",  "Remember: RunPod endpoint now uses vLLM v0.4.2",                    "session_save_ledger"),
    ("save",  "Capture this session — prism routing at 99%",                       "session_save_ledger"),
    ("save",  "Record progress: v25 system prompt converged after 3 red-team rounds","session_save_ledger"),
    ("save",  "Save ledger entry: 14B model tied Sonnet on routing eval",          "session_save_ledger"),
    ("save",  "Note this down: removed legacy Modelfile.7b-v17",                   "session_save_ledger"),
    ("save",  "Don't lose this: sft_fix_v23 training corpus is at 3182 examples",  "session_save_ledger"),
    ("save",  "Preserve today's benchmark results — 99/100 for 14B",              "session_save_ledger"),
    # smem — session_search_memory
    ("smem",  "What did we discuss about BFCL last time?",                         "session_search_memory"),
    ("smem",  "What have I previously recorded about training loss?",              "session_search_memory"),
    ("smem",  "What was the plan we discussed for the iOS deployment?",            "session_search_memory"),
    ("smem",  "Find in my sessions anything about RunPod configuration",           "session_search_memory"),
    ("smem",  "What did I record about the 14B model failures?",                   "session_search_memory"),
    ("smem",  "Show me past session notes about AAC phrase prediction",            "session_search_memory"),
    ("smem",  "What was previously said about the TTS rate bug?",                  "session_search_memory"),
    ("smem",  "Recall what we discussed about Vast.ai PyTorch errors",             "session_search_memory"),
    ("smem",  "Previous discussions about the v19 system prompt",                  "session_search_memory"),
    # aac — plain text (AAC phrases)
    ("aac",   "Suggest phrases for expressing pain",                               None),
    ("aac",   "Give me AAC phrases for asking for help",                           None),
    ("aac",   "What are good phrases for someone who is tired?",                   None),
    ("aac",   "Generate communication phrases for requesting a break",             None),
    ("aac",   "Suggest 5 phrases for expressing hunger",                           None),
    ("aac",   "AAC prediction: what might a non-speaking user want to say next?",  None),
    ("aac",   "Give phrase suggestions for expressing happiness",                   None),
    ("aac",   "What phrases help communicate medical needs?",                      None),
    ("aac",   "Suggest AAC phrases for a child who wants to play",                 None),
    ("aac",   "Generate phrase predictions for social greetings",                  None),
    ("aac",   "Give me communication phrases for expressing frustration",          None),
    ("aac",   "Suggest phrases for asking to go outside",                          None),
    # tran — plain text (translation)
    ("tran",  "Translate 'hello, how are you?' into Spanish",                      None),
    ("tran",  "How do you say 'I need help' in French?",                           None),
    ("tran",  "Convert 'good morning' to Japanese",                                None),
    ("tran",  "Say 'thank you very much' in Portuguese",                           None),
    ("tran",  "Translation request: 'I am in pain' into German",                   None),
    ("tran",  "What is 'emergency exit' in Mandarin?",                             None),
    # hand — session_save_handoff
    ("hand",  "Pass this to the next agent: routing is done, focus on iOS next",   "session_save_handoff"),
    ("hand",  "Save a handoff for prism-coder — training complete, deploy next",   "session_save_handoff"),
    ("hand",  "Relay to next session: benchmark results are in training/",         "session_save_handoff"),
    ("hand",  "Transition notes for the QA agent: test all 5 model tiers",        "session_save_handoff"),
    ("hand",  "Archive and pass on to next dev: fix the RunPod health check",      "session_save_handoff"),
    ("hand",  "Next session prep: start with reading benchmark_final_100.json",    "session_save_handoff"),
    ("hand",  "Handoff to iOS team: GGUF model is ready at ios_model/",            "session_save_handoff"),
    ("hand",  "Save live state for the next agent working on prism-mcp",           "session_save_handoff"),
    # pred — plain text (prediction / no tool)
    ("pred",  "What is the capital of France?",                                    None),
    ("pred",  "Explain what a LoRA adapter is",                                    None),
    ("pred",  "What does BFCL stand for?",                                         None),
    ("pred",  "How does quantization affect model size?",                          None),
    ("pred",  "What is the difference between SFT and GRPO?",                      None),
    ("pred",  "Explain why num_predict -1 matters for Ollama",                     None),
    ("pred",  "What year was the Transformer architecture published?",             None),
    ("pred",  "How many parameters does Qwen3-14B have?",                          None),
    # web — brave_web_search
    ("web",   "Search the web for latest LLM benchmarks 2026",                     "brave_web_search"),
    ("web",   "Google: RunPod serverless pricing update",                           "brave_web_search"),
    ("web",   "Look up current Ollama release notes",                              "brave_web_search"),
    ("web",   "Search online for Qwen3 model card",                                "brave_web_search"),
    ("web",   "Find news about Apple MLX framework updates",                       "brave_web_search"),
    ("web",   "What's the latest version of llama.cpp?",                           "brave_web_search"),
    ("web",   "Google: OpenRouter Qwen3-14B pricing per token",                    "brave_web_search"),
    # irrel — plain text (no-tool guard)
    ("irrel", "What time is it in Tokyo right now?",                               None),
    ("irrel", "What is the weather in San Francisco today?",                       None),
    ("irrel", "I need my medicine",                                                None),
    ("irrel", "I'm hungry",                                                        None),
    ("irrel", "Write a regex to match email addresses",                            None),
    ("irrel", "I feel tired and want to rest",                                     None),
    # cmpct — session_compact_ledger
    ("cmpct", "Compact the ledger for prism-mcp",                                  "session_compact_ledger"),
    ("cmpct", "Shrink the session ledger — too many entries",                      "session_compact_ledger"),
    ("cmpct", "Archive old entries in the prism-aac ledger",                       "session_compact_ledger"),
    ("cmpct", "Prune the ledger for synalux-private",                              "session_compact_ledger"),
    ("cmpct", "Trim the session ledger — it's getting too long",                   "session_compact_ledger"),
    ("cmpct", "Run ledger compaction on the bcba-private project",                 "session_compact_ledger"),
    # load — session_load_context
    ("load",  "Load context for prism-mcp",                                        "session_load_context"),
    ("load",  "Fetch my work context for project synalux-private",                 "session_load_context"),
    ("load",  "Get context for bcba-private",                                      "session_load_context"),
    ("load",  "Pull session context for prism-aac",                                "session_load_context"),
    ("load",  "Open context for project prism-coder",                              "session_load_context"),
    ("load",  "Resume context for synalux-health",                                 "session_load_context"),
    ("load",  "Retrieve context for the iOS deployment project",                   "session_load_context"),
    ("load",  "Restore context for prism-training",                                "session_load_context"),
    ("load",  "Load my session for the BCBA clinical tools project",               "session_load_context"),
    # info — plain text (factual, no tool)
    ("info",  "What is 17 × 24?",                                                  None),
    ("info",  "What does HIPAA stand for?",                                        None),
    ("info",  "Explain the difference between RAM and VRAM",                       None),
    ("info",  "What is the Transformer architecture?",                             None),
    ("info",  "What is a GGUF file?",                                              None),
    # know — knowledge_search
    ("know",  "What do I know about HIPAA compliance?",                            "knowledge_search"),
    ("know",  "Search my knowledge base for ACT-R decay algorithm notes",         "knowledge_search"),
    ("know",  "What's in my stored notes about Supabase migration?",              "knowledge_search"),
    ("know",  "Check my knowledge for notes on the TTS fallback design",          "knowledge_search"),
    ("know",  "Find stored knowledge about the Synalux SFT corpus",               "knowledge_search"),
    ("know",  "What do I have on file about BCBA ethics code?",                   "knowledge_search"),
    ("know",  "Look up my stored notes on RunPod vLLM configuration",             "knowledge_search"),
    # edge — ambiguous / multi-intent (hard cases)
    ("edge",  "Look up my notes on BFCL then compact the ledger",                 "knowledge_search"),
    ("edge",  "What do I know about iOS? Search memory too",                      "knowledge_search"),
    ("edge",  "Find previous sessions about training, then save a handoff",       "session_search_memory"),
    ("edge",  "Load context for prism-mcp and tell me what we discussed last week","session_load_context"),
    ("edge",  "Save and pass on to next agent: 14B is production-ready",          "session_save_handoff"),
    ("edge",  "Record this and compact the ledger afterward",                     "session_save_ledger"),
]

# ── Inference helpers ──────────────────────────────────────────────────────────

def _extract_tool(text: str) -> Optional[str]:
    m = re.search(r'<\|tool_call\|>\s*(\{.*?\})\s*(?:<\|tool_call_end\|>|$)', text, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1)).get("name")
        except Exception:
            pass
    return None


def _call_ollama(tag: str, prompt: str, timeout: int = 60) -> tuple[Optional[str], float]:
    t0 = time.time()
    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": tag, "prompt": f"<|im_start|>system\n{SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n",
                  "stream": False, "options": {"num_predict": -1, "temperature": 0}},
            timeout=timeout,
        )
        data = r.json()
        return _extract_tool(data.get("response", "")), round(time.time() - t0, 2)
    except Exception as e:
        print(f"    [ollama error] {e}")
        return None, round(time.time() - t0, 2)


def _call_claude(model_id: str, prompt: str, client: anthropic.Anthropic) -> tuple[Optional[str], float]:
    t0 = time.time()
    try:
        msg = client.messages.create(
            model=model_id,
            max_tokens=512,
            system=SYSTEM_PROMPT,
            tools=TOOLS_SCHEMA,
            messages=[{"role": "user", "content": prompt}],
        )
        tool_name = None
        for blk in msg.content:
            if blk.type == "tool_use":
                tool_name = blk.name
                break
        return tool_name, round(time.time() - t0, 2)
    except Exception as e:
        print(f"    [claude error] {e}")
        return None, round(time.time() - t0, 2)


# ── Main ──────────────────────────────────────────────────────────────────────

def run_benchmark(models: list[str], n: int = 100, seed: int = 2026, verbose: bool = False):
    rng = random.Random(seed)
    cases = rng.sample(TEST_POOL, min(n, len(TEST_POOL)))
    if n > len(TEST_POOL):
        cases += rng.choices(TEST_POOL, k=n - len(TEST_POOL))

    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY) if ANTHROPIC_API_KEY else None

    results = {}
    for label in models:
        print(f"\n{'='*60}")
        print(f"  {label}")
        print(f"{'='*60}")

        cats: dict[str, list[bool]] = {}
        latencies: list[float] = []
        invented = 0

        for cat, prompt, expected in cases:
            if label in OLLAMA_MODELS:
                got, lat = _call_ollama(OLLAMA_MODELS[label], prompt)
            elif label in CLAUDE_MODELS and client:
                got, lat = _call_claude(CLAUDE_MODELS[label], prompt, client)
            else:
                print(f"  skipping {label} — model unavailable")
                break

            latencies.append(lat)

            correct = (got == expected) if expected else (got is None)
            valid_tools = {t["name"] for t in TOOLS_SCHEMA}
            if got and got not in valid_tools:
                invented += 1

            cats.setdefault(cat, []).append(correct)
            icon = "✓" if correct else "✗"
            if verbose or not correct:
                print(f"  {icon} [{cat}] {prompt[:55]:<55} → {got or 'plain'}")

        if not latencies:
            continue

        total = sum(len(v) for v in cats.values())
        correct_total = sum(sum(v) for v in cats.values())
        pct = round(correct_total / total * 100)
        avg_lat = round(sum(latencies) / len(latencies), 1)
        p50_lat = round(sorted(latencies)[len(latencies) // 2], 1)

        results[label] = {
            "pct": pct, "correct": correct_total, "total": total,
            "avg": avg_lat, "p50": p50_lat, "invented": invented,
            "cats": {k: round(sum(v) / len(v) * 100) for k, v in cats.items()},
        }
        print(f"\n  Score: {pct}% ({correct_total}/{total})  avg={avg_lat}s  p50={p50_lat}s  invented={invented}")

    return results


def print_table(results: dict):
    print("\n" + "="*85)
    print("  PRISM ROUTING BENCHMARK — 100-CASE EVAL (v25 system prompt, seed=2026)")
    print("="*85)

    cat_order = ["load","save","smem","hand","cmpct","web","know","aac","tran","pred","irrel","info","edge"]
    cat_labels = {
        "load":  "Load ctx", "save":  "Save",    "smem":  "Srch mem",
        "hand":  "Handoff",  "cmpct": "Compact", "web":   "Web srch",
        "know":  "Know srch","aac":   "AAC",     "tran":  "Translate",
        "pred":  "Plain txt","irrel": "No-tool", "info":  "Info",
        "edge":  "Edge",
    }

    header = f"{'Model':<18} {'Overall':>8} {'Lat avg':>8} {'Lat p50':>8} {'Inv':>4}  "
    header += "  ".join(f"{cat_labels[c]:>9}" for c in cat_order)
    print(header)
    print("-" * len(header))

    for label, r in sorted(results.items(), key=lambda x: -x[1]["pct"]):
        row = f"{label:<18} {r['pct']:>7}%  {r['avg']:>6}s  {r['p50']:>6}s  {r['invented']:>3}  "
        row += "  ".join(f"{r['cats'].get(c, 0):>8}%" for c in cat_order)
        print(row)

    print("="*85)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prism routing benchmark")
    parser.add_argument("--models", nargs="+", default=list(OLLAMA_MODELS) + list(CLAUDE_MODELS),
                        help="Models to test: 1b7 14b 32b sonnet opus")
    parser.add_argument("--n", type=int, default=100, help="Number of test cases (max 200)")
    parser.add_argument("--seed", type=int, default=2026)
    parser.add_argument("--verbose", action="store_true")
    parser.add_argument("--out", default="results.json", help="Output file")
    args = parser.parse_args()

    results = run_benchmark(args.models, n=args.n, seed=args.seed, verbose=args.verbose)
    print_table(results)

    with open(args.out, "w") as f:
        json.dump({"seed": args.seed, "n": args.n, "results": results}, f, indent=2)
    print(f"\nResults saved to {args.out}")
