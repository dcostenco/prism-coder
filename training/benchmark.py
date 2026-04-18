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

MODEL_PATH = "/Users/admin/prism/training/models/qwen-7b-mlx"
ADAPTER_PATH = "/Users/admin/prism/training/models/prism-sft-lora"
SFT_ADAPTER = "/Users/admin/prism/training/models/prism-sft-lora"
TOOL_SCHEMA = "/Users/admin/prism/training/data/tool_schema.json"
REPORT_PATH = "/Users/admin/prism/training/results/benchmark_report.md"

# Load valid tools
with open(TOOL_SCHEMA) as f:
    schema = json.load(f)
    VALID_TOOLS = {t["name"] for t in schema["tools"]}
    TOOL_PARAMS = {}
    for t in schema["tools"]:
        TOOL_PARAMS[t["name"]] = {
            "required": set(t["parameters"].get("required", [])),
            "all": set(t["parameters"]["properties"].keys())
        }

# Test prompts with expected behavior
TEST_CASES = [
    {"prompt": "Load context for prism-mcp", "expected_tool": "session_load_context", "category": "tool_call"},
    {"prompt": "Explain async/await in JavaScript", "expected_tool": None, "category": "reasoning"},
    {"prompt": "Find sessions about RBAC implementation", "expected_tool": "session_search", "category": "retrieval"}
]


def parse_tool_call(response: str):
    """Extract tool name and arguments from response."""
    match = re.search(r'<tool_call>\s*(.*?)\s*</tool_call>', response, re.DOTALL)
    if not match:
        return None, None
    
    try:
        call = json.loads(match.group(1))
        return call.get("name"), call.get("arguments", {})
    except json.JSONDecodeError:
        return "INVALID_JSON", None


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
    
    # Check for <think> CoT block
    think_match = re.search(r'<think>(.*?)</think>', response, re.DOTALL)
    if think_match:
        result["has_think"] = True
        result["think_length"] = len(think_match.group(1).strip())
    
    # Check reasoning (text before tool call, excluding <think> blocks)
    if '<tool_call>' in response:
        pre = response[:response.index('<tool_call>')].strip()
        pre_clean = re.sub(r'<think>.*?</think>', '', pre, flags=re.DOTALL).strip()
        result["has_reasoning"] = len(pre_clean) > 10 or result["has_think"]
    elif expected_tool is None:
        result["has_reasoning"] = len(response.strip()) > 20 or result["has_think"]
    
    # Check correct tool
    if expected_tool is None:
        result["correct_tool"] = tool_name is None  # Should NOT have called a tool
    else:
        result["correct_tool"] = tool_name == expected_tool
    
    # Check params
    if tool_name and tool_name in TOOL_PARAMS and tool_args:
        required = TOOL_PARAMS[tool_name]["required"]
        result["params_valid"] = required.issubset(set(tool_args.keys()))
    elif expected_tool is None and tool_name is None:
        result["params_valid"] = True  # No tool = no params needed
    
    return result


def run_benchmark():
    """Run full benchmark suite."""
    try:
        from mlx_lm import load, generate
    except ImportError:
        print("ERROR: mlx_lm not installed")
        sys.exit(1)
    
    # Determine which adapter to use
    adapter = ADAPTER_PATH if os.path.exists(ADAPTER_PATH) else SFT_ADAPTER
    if not os.path.exists(adapter):
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
    
    sys_prompt = "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate. Available tools: session_load_context, session_save, session_search, session_list, session_delete, knowledge_save, knowledge_search, memory_link, session_handoff, session_task_route"
    
    for i, test in enumerate(TEST_CASES):
        prompt_text = f"<|im_start|>system\n{sys_prompt}<|im_end|>\n<|im_start|>user\n{test['prompt']}<|im_end|>\n<|im_start|>assistant\n"
        
        start = time.time()
        response = generate(model, tokenizer, prompt=prompt_text, max_tokens=384)
        elapsed = time.time() - start
        
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
        if r["has_reasoning"]:
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
| **Hardware** | Apple M4 Max, 36GB |
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
    run_benchmark()
