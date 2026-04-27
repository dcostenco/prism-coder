#!/usr/bin/env python3
"""
Benchmark evaluation for Prism fine-tuned model.
Tests: retrieval accuracy, tool-call accuracy, reasoning quality, efficiency.
"""
import json
import os
import time
import re
import sys
import argparse

_TRAINING_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_PATH = os.environ.get("PRISM_MODEL_PATH", os.path.join(_TRAINING_DIR, "models", "qwen-7b-mlx"))
ADAPTER_PATH = os.environ.get("PRISM_ADAPTER_PATH", os.path.join(_TRAINING_DIR, "models", "prism-grpo-lora"))
SFT_ADAPTER = os.environ.get("PRISM_SFT_ADAPTER", os.path.join(_TRAINING_DIR, "models", "prism-sft-lora"))
TOOL_SCHEMA = os.path.join(_TRAINING_DIR, "data", "tool_schema.json")
REPORT_PATH = os.path.join(_TRAINING_DIR, "results", "benchmark_report.md")

# Load valid tools
try:
    with open(TOOL_SCHEMA) as f:
        schema = json.load(f)
    VALID_TOOLS = {t["name"] for t in schema["tools"]}
    TOOL_PARAMS = {}
    for t in schema["tools"]:
        TOOL_PARAMS[t["name"]] = {
            "required": set(t["parameters"].get("required", [])),
            "all": set(t["parameters"]["properties"].keys())
        }
except (FileNotFoundError, json.JSONDecodeError, PermissionError) as e:
    print(f"ERROR: Failed to load tool schema: {e}")
    print(f"Run: python3 build_tool_schema.py to regenerate {TOOL_SCHEMA}")
    VALID_TOOLS = set()
    TOOL_PARAMS = {}

# Held-out test prompts — NONE overlap with GRPO training prompts.
# Training used: "Load...prism-mcp", "Save...RBAC", "Explain React Server Components",
# "Search...JWT", "List...billing-portal", "Delete...billing bug", "Zero-Search architecture",
# "Store...ACT-R decay", "Search...memory consolidation", "Hand off billing task",
# "Initialize...docs-portal", "hello world Python", "schema migration v9.4",
# "HIPAA security audit", "Log work...abortPipeline".
TEST_CASES = [
    # ═══════════════════════════════════════════════════════════════
    # SECTION 1: Prism MCP Tool-call tests (19 tools)
    # ═══════════════════════════════════════════════════════════════
    {"prompt": "Show me the context for docs-portal", "expected_tool": "session_load_context", "category": "tool_call"},
    {"prompt": "Record this work: migrated Stripe webhooks to v2 API", "expected_tool": "session_save_ledger", "category": "tool_call"},
    {"prompt": "Look up past work on the OAuth2 refresh flow", "expected_tool": "session_search_memory", "category": "retrieval"},
    {"prompt": "Save the current handoff state for docs-portal project", "expected_tool": "session_save_handoff", "category": "tool_call"},
    {"prompt": "Remove the memory about the failed deploy last Friday", "expected_tool": "session_forget_memory", "category": "tool_call"},
    {"prompt": "Run a health check on the memory system", "expected_tool": "session_health_check", "category": "tool_call"},
    {"prompt": "What do we know about edge function cold starts?", "expected_tool": "knowledge_search", "category": "retrieval"},
    {"prompt": "Compact old ledger entries for the prism-mcp project", "expected_tool": "session_compact_ledger", "category": "tool_call"},
    {"prompt": "Export all memory data for billing-portal to my desktop", "expected_tool": "session_export_memory", "category": "tool_call"},
    {"prompt": "Should the local agent or the cloud agent handle this CSS fix?", "expected_tool": "session_task_route", "category": "tool_call"},
    {"prompt": "Upvote that memory about the RBAC fix — it was really helpful", "expected_tool": "knowledge_upvote", "category": "tool_call"},
    {"prompt": "Downvote the stale entry about the old API endpoint", "expected_tool": "knowledge_downvote", "category": "tool_call"},
    {"prompt": "Backfill graph edges for the prism-mcp project", "expected_tool": "session_backfill_links", "category": "tool_call"},
    {"prompt": "Find semantic relationships between memory nodes for analytics-dashboard", "expected_tool": "session_synthesize_edges", "category": "tool_call"},
    {"prompt": "Show me the memory version history for prism-mcp", "expected_tool": "memory_history", "category": "tool_call"},
    {"prompt": "Restore the prism-mcp memory to version 3", "expected_tool": "memory_checkout", "category": "tool_call"},
    {"prompt": "Log a success event: deployed the billing module without errors", "expected_tool": "session_save_experience", "category": "tool_call"},
    {"prompt": "Forget all knowledge entries older than 90 days", "expected_tool": "knowledge_forget", "category": "tool_call"},

    # ═══════════════════════════════════════════════════════════════
    # SECTION 2: Synalux-specific tool tests
    # ═══════════════════════════════════════════════════════════════
    {"prompt": "Generate a professional image of a modern clinic dashboard", "expected_tool": "image_gen", "category": "tool_call"},
    {"prompt": "Read this text aloud in Spanish for the patient summary", "expected_tool": "tts", "category": "tool_call"},
    {"prompt": "Verify HIPAA compliance for the new data storage event", "expected_tool": "hipaa", "category": "tool_call"},

    # ═══════════════════════════════════════════════════════════════
    # SECTION 3: Reasoning tests (should NOT invoke a tool)
    # ═══════════════════════════════════════════════════════════════
    {"prompt": "What is the difference between gRPC and REST?", "expected_tool": None, "category": "reasoning"},
    {"prompt": "How does garbage collection work in Go?", "expected_tool": None, "category": "reasoning"},
    {"prompt": "Explain the CAP theorem in simple terms", "expected_tool": None, "category": "reasoning"},
    {"prompt": "What are the pros and cons of microservices?", "expected_tool": None, "category": "reasoning"},
    {"prompt": "Write a bash one-liner to find large files", "expected_tool": None, "category": "reasoning"},

    # ═══════════════════════════════════════════════════════════════
    # SECTION 4: Adversarial keyword traps (sound tool-like but are NOT)
    # ═══════════════════════════════════════════════════════════════
    {"prompt": "How does session replication work in distributed systems?", "expected_tool": None, "category": "adversarial"},
    {"prompt": "What is the difference between stack memory and heap memory?", "expected_tool": None, "category": "adversarial"},
    {"prompt": "Explain how load balancing works across multiple servers", "expected_tool": None, "category": "adversarial"},
    {"prompt": "What is knowledge distillation in machine learning?", "expected_tool": None, "category": "adversarial"},
    {"prompt": "How do you implement a search algorithm for a graph?", "expected_tool": None, "category": "adversarial"},
    {"prompt": "How do I save data to localStorage in the browser?", "expected_tool": None, "category": "adversarial"},
    {"prompt": "Explain how to export a module in Node.js", "expected_tool": None, "category": "adversarial"},
    {"prompt": "What is task routing in distributed systems like Celery?", "expected_tool": None, "category": "adversarial"},

    # ═══════════════════════════════════════════════════════════════
    # SECTION 5: Edge cases — ambiguous, multi-intent, or tricky
    # ═══════════════════════════════════════════════════════════════
    {"prompt": "Search for what we decided about the caching layer last week", "expected_tool": "session_search_memory", "category": "edge_case"},
    {"prompt": "Can you check if the memory system is healthy and fix any issues?", "expected_tool": "session_health_check", "category": "edge_case"},
    {"prompt": "I want to clean up — compact and then export the prism-mcp project", "expected_tool": "session_compact_ledger", "category": "edge_case"},
    {"prompt": "Delete session abc-123 because it contains wrong information", "expected_tool": "session_forget_memory", "category": "edge_case"},
    {"prompt": "What's in our knowledge base about Supabase RLS policies?", "expected_tool": "knowledge_search", "category": "edge_case"},
]



def parse_tool_call(response: str):
    """Extract tool name and arguments from response.
    
    Sanitizes the response first (strips \\ufffd EOS replacement chars),
    then tries multiple formats:
    Accepts multiple formats:
      1. <|tool_call|>{...}</|tool_call|>     — Prism canonical format
      2. <|im_start|>{...}<|im_end|>      — Qwen native ChatML format
      3. Bare JSON with "name" key        — fallback
    """
    # Sanitize: Qwen tokenizer replaces <|im_end|> EOS with \ufffd
    response = response.replace('\ufffd', '').strip()

    # R17-fix: Globally strip CoT block to protect all regex strategies
    # R19-fix: Handle unclosed think blocks via (?:</\|synalux_think\|>|$) fallback
    clean_response = re.sub(r'<\|synalux_think\|>.*?(?:</\|synalux_think\|>|$)', '', response, flags=re.DOTALL)

    # 1. Try <|tool_call|> tags (canonical Prism format)
    match = re.search(r'<\|tool_call\|>\s*(.*?)\s*</\|tool_call\|>', clean_response, re.DOTALL)
    if match:
        try:
            call = json.loads(match.group(1))
            return call.get("name"), call.get("arguments", {})
        except json.JSONDecodeError:
            return "INVALID_JSON", None

    # 1b. Try <|tool_call|> tags (Synalux native format)
    synalux_match = re.search(r'<\|tool_call\|>\s*(.*?)\s*(?:</\|tool_call\|>|$)', clean_response, re.DOTALL)
    if synalux_match:
        try:
            call = json.loads(synalux_match.group(1))
            return call.get("name"), call.get("arguments", {})
        except json.JSONDecodeError:
            return "INVALID_JSON", None

    # 2. Try <|im_start|>...<|im_end|> (Qwen native tool format)
    #    Note: the Qwen tokenizer strips <|im_end|> as the EOS token,
    #    so the model output often has <|im_start|>{JSON} with no closer.
    im_match = re.search(r'<\|im_start\|>\s*(\{[\s\S]*\})\s*(?:<\|im_end\|>|$)', clean_response, re.DOTALL)
    if im_match:
        try:
            call = json.loads(im_match.group(1))
            tool_name = call.get("name") or call.get("tool")
            if tool_name:
                return tool_name, call.get("arguments") or call.get("parameters", {})
        except json.JSONDecodeError:
            return "INVALID_JSON", None

    # 3. Fallback: bare JSON with "name" or "tool" key
    #    CoT already stripped at top via clean_response
    stripped = clean_response
    
    # Find all potential JSON objects using balanced brace matching
    i = 0
    while i < len(stripped):
        if stripped[i] == '{':
            depth = 0
            start = i
            for j in range(i, len(stripped)):
                if stripped[j] == '{':
                    depth += 1
                elif stripped[j] == '}':
                    depth -= 1
                    if depth == 0:
                        candidate = stripped[start:j+1]
                        try:
                            call = json.loads(candidate)
                            if isinstance(call, dict):
                                tool_name = call.get("name") or call.get("tool")
                                if tool_name:
                                    return tool_name, call.get("arguments") or call.get("parameters", {})
                        except json.JSONDecodeError:
                            pass
                        break
        i += 1

    return None, None


def evaluate_response(response: str, expected_tool: str):
    """Score a single response."""
    tool_name, tool_args = parse_tool_call(response)
    
    result = {
        "tool_called": tool_name,
        "expected_tool": expected_tool,
        "json_valid": tool_name != "INVALID_JSON" if tool_name else True,
        "correct_tool": False,
        "params_valid": False,
        "has_reasoning": False,
        "has_think": False,
        "think_length": 0,
    }
    
    # Check for <|synalux_think|> CoT block
    # R20-fix: Handle unclosed think blocks via (?:</\|synalux_think\|>|$) fallback
    think_match = re.search(r'<\|synalux_think\|>(.*?)(?:</\|synalux_think\|>|$)', response, re.DOTALL)
    if think_match:
        result["has_think"] = True
        result["think_length"] = len(think_match.group(1).strip())
    
    # Check reasoning (text before tool call, excluding <|synalux_think|> blocks)
    if '<|tool_call|>' in response:
        pre = response.split('<|tool_call|>')[0].strip()
        # R20-fix: Handle unclosed think blocks
        pre_clean = re.sub(r'<\|synalux_think\|>.*?(?:</\|synalux_think\|>|$)', '', pre, flags=re.DOTALL).strip()
        result["has_reasoning"] = len(pre_clean) > 10 or result["has_think"]
    elif expected_tool is None:
        result["has_reasoning"] = len(response.strip()) > 20 or result["has_think"]
    
    # Check correct tool
    if expected_tool is None:
        result["correct_tool"] = tool_name is None  # Should NOT have called a tool
    else:
        result["correct_tool"] = tool_name == expected_tool
    
    # Check params
    # R14-fix: Use `is not None` — empty dict {} is falsy but valid for zero-arg tools
    if tool_name and tool_name in TOOL_PARAMS and tool_args is not None and isinstance(tool_args, dict):
        required = TOOL_PARAMS[tool_name]["required"]
        result["params_valid"] = required.issubset(set(tool_args.keys()))
    elif expected_tool is None and tool_name is None:
        result["params_valid"] = True  # No tool = no params needed
    
    return result


def run_benchmark(requested_adapter=None):
    """Run full benchmark suite."""
    try:
        from mlx_lm import load, generate
    except ImportError:
        print("ERROR: mlx_lm not installed")
        sys.exit(1)
    
    # Determine which adapter to use
    adapter = requested_adapter if requested_adapter else (ADAPTER_PATH if os.path.exists(ADAPTER_PATH) else SFT_ADAPTER)
    if adapter and not os.path.exists(adapter):
        print(f"ERROR: No adapter found at {adapter}")
        print("Running without adapter (base model only)")
        adapter = None
    
    print(f"Loading model: {MODEL_PATH}")
    print(f"Adapter: {adapter or 'None (base model)'}")
    
    if adapter:
        model, tokenizer = load(MODEL_PATH, adapter_path=adapter)
    else:
        model, tokenizer = load(MODEL_PATH)
    
    results = []
    total_tokens = 0
    total_time = 0
    
    # R8-fix: Use full XML tool schemas instead of name-only list
    from config import format_system_prompt
    try:
        with open(TOOL_SCHEMA) as f:
            _tools = json.load(f).get("tools", [])
    except (FileNotFoundError, json.JSONDecodeError):
        _tools = []
    sys_prompt = format_system_prompt(_tools)
    
    for i, test in enumerate(TEST_CASES):
        prompt_text = f"<|im_start|>system\n{sys_prompt}<|im_end|>\n<|im_start|>user\n{test['prompt']}<|im_end|>\n<|im_start|>assistant\n"
        
        start = time.time()
        response = generate(model, tokenizer, prompt=prompt_text, max_tokens=768)
        elapsed = time.time() - start
        
        print(f"    Response: {response[:150].replace(chr(10), ' ')}...")
        
        tokens = len(tokenizer.encode(response))
        total_tokens += tokens
        total_time += elapsed
        
        eval_result = evaluate_response(response, test["expected_tool"])
        eval_result["prompt"] = test["prompt"]
        eval_result["category"] = test["category"]
        eval_result["response_preview"] = response[:150]
        eval_result["tokens"] = tokens
        eval_result["latency_ms"] = round(elapsed * 1000)
        
        results.append(eval_result)
        
        status = "✅" if eval_result["correct_tool"] else "❌"
        print(f"  [{i+1}/{len(TEST_CASES)}] {status} {test['category']:12} | {test['prompt'][:60]}")
    
    # Compute metrics
    metrics = compute_metrics(results, total_tokens, total_time)
    
    # Generate report
    generate_report(results, metrics, adapter)
    
    return metrics


def compute_metrics(results, total_tokens, total_time):
    """Compute aggregate metrics."""
    categories = {}
    for r in results:
        cat = r["category"]
        if cat not in categories:
            categories[cat] = {"total": 0, "correct": 0, "json_valid": 0, "params_valid": 0, "has_reasoning": 0}
        categories[cat]["total"] += 1
        if r["correct_tool"]:
            categories[cat]["correct"] += 1
        if r["json_valid"]:
            categories[cat]["json_valid"] += 1
        if r["params_valid"]:
            categories[cat]["params_valid"] += 1
        if v := r.get("has_reasoning"):
            categories[cat]["has_reasoning"] += 1
    
    total = len(results)
    correct = sum(1 for r in results if r["correct_tool"])
    json_valid = sum(1 for r in results if r["json_valid"])
    params_valid = sum(1 for r in results if r["params_valid"])
    
    return {
        "overall_accuracy": correct / total * 100,
        "json_validity": json_valid / total * 100,
        "params_accuracy": params_valid / total * 100,
        "total_tokens": total_tokens,
        "total_time_s": round(total_time, 1),
        "avg_tokens_per_response": total_tokens // total,
        "avg_latency_ms": round(total_time / total * 1000),
        "tokens_per_second": round(total_tokens / total_time, 1),
        "categories": {k: {
            "accuracy": v["correct"] / v["total"] * 100,
            "count": v["total"]
        } for k, v in categories.items()}
    }


def generate_report(results, metrics, adapter_path):
    """Generate markdown benchmark report."""
    report = f"""# Prism LLM Benchmark Report

## Model Configuration
| Setting | Value |
|---------|-------|
| **Base Model** | Qwen 2.5 Coder 7B Instruct |
| **Adapter** | {adapter_path or 'None'} |
| **Hardware** | Apple M5 Max, 48GB |
| **Framework** | MLX |

## Overall Results

| Metric | Score |
|--------|-------|
| **Tool-Call Accuracy** | {metrics['overall_accuracy']:.1f}% |
| **JSON Validity** | {metrics['json_validity']:.1f}% |
| **Parameter Accuracy** | {metrics['params_accuracy']:.1f}% |
| **Avg Latency** | {metrics['avg_latency_ms']}ms |
| **Tokens/Second** | {metrics['tokens_per_second']} |
| **Avg Tokens/Response** | {metrics['avg_tokens_per_response']} |

## Category Breakdown

| Category | Accuracy | Count |
|----------|----------|-------|
"""
    for cat, data in sorted(metrics["categories"].items()):
        report += f"| {cat} | {data['accuracy']:.1f}% | {data['count']} |\n"

    report += "\n## Detailed Results\n\n"
    report += "| # | Status | Category | Prompt | Expected | Got |\n"
    report += "|---|--------|----------|--------|----------|-----|\n"

    for i, r in enumerate(results):
        status = "✅" if r["correct_tool"] else "❌"
        expected = r["expected_tool"] or "None"
        got = r["tool_called"] or "None"
        prompt = r["prompt"][:50]
        report += f"| {i+1} | {status} | {r['category']} | {prompt} | {expected} | {got} |\n"

    report += f"\n---\n*Generated at {time.strftime('%Y-%m-%d %H:%M:%S')}*\n"

    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, "w") as f:
        f.write(report)

    print(f"\n{'='*60}")
    print(f"Benchmark Report: {REPORT_PATH}")
    print(f"{'='*60}")
    print(f"Tool-Call Accuracy: {metrics['overall_accuracy']:.1f}%")
    print(f"JSON Validity:      {metrics['json_validity']:.1f}%")
    print(f"Parameter Accuracy: {metrics['params_accuracy']:.1f}%")
    print(f"Avg Latency:        {metrics['avg_latency_ms']}ms")
    print(f"Tokens/sec:         {metrics['tokens_per_second']}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Prism LLM Benchmark")
    parser.add_argument("--adapter", type=str, help="Path to LoRA adapter")
    args = parser.parse_args()
    
    run_benchmark(requested_adapter=args.adapter)
