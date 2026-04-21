#!/usr/bin/env python3
"""
GRPO (Group Relative Policy Optimization) for tool-use accuracy.
Uses deterministic reward function — no reward model needed.

v2.0 Fixes:
  - Normalized reward range to [-1.0, +1.0] to prevent gradient explosion
  - Reduced data repetition from 50x to 5x (anti-overfitting)
  - Added subprocess error handling with SFT fallback
  - Restored reward function verification block
  - Synthetic injection is now optional (use --synthetic flag)
  - Moderate learning rate (1e-5) to prevent catastrophic forgetting
"""
import json
import os
import sys
import subprocess
import re
import shutil

MODEL_PATH = "/Users/admin/prism/training/models/qwen-7b-mlx"
SFT_ADAPTER = "/Users/admin/prism/training/models/prism-sft-lora"
TOOL_SCHEMA = "/Users/admin/prism/training/data/tool_schema.json"
OUTPUT_ADAPTER = "/Users/admin/prism/training/models/prism-grpo-lora"
GRPO_DATA = "/Users/admin/prism/training/data/grpo_prompts.jsonl"

# Load valid tool names from schema
with open(TOOL_SCHEMA) as f:
    VALID_TOOLS = {t["name"] for t in json.load(f)["tools"]}

TOOL_PARAMS = {}
with open(TOOL_SCHEMA) as f:
    for t in json.load(f)["tools"]:
        TOOL_PARAMS[t["name"]] = {
            "required": set(t["parameters"].get("required", [])),
            "optional": set(t["parameters"]["properties"].keys()) - set(t["parameters"].get("required", []))
        }


def compute_reward(response_text: str) -> float:
    """
    Deterministic reward function for tool-use accuracy.
    Rewards <think> + <tool_call> structure with normalized output in [-1.0, +1.0].

    Scoring (raw, then normalized):
      Structure:
        +3.0  if response starts with <think>
        -1.0  if missing <think> opener
        +4.0  if <tool_call> + </tool_call> tags present
      Reasoning:
        +1.0  if <think> block >50 chars (substantive thought)
        +0.5  if think mentions "tool"/"requires" (strategy-oriented)
        -0.2  if <think> block >1000 chars (anti-thought-farming)
      Tool correctness:
        +1.0  if JSON parses correctly
        +2.0  if tool_name is valid
        -4.0  if tool_name is hallucinated
        +2.0  if all required params present
        -2.0  per missing required param
      No tool needed:
        +0.0  if response is >20 chars (reasonable prose)
        -0.5  if response is very short (<20 chars)

    Max raw = +13.5, min raw = -7.0. Normalized to [-1.0, +1.0].
    """
    RAW_MAX = 13.5
    RAW_MIN = -7.0

    reward = 0.0

    # ── Structural Reward ──
    if response_text.strip().startswith('<think>'):
        reward += 3.0
    else:
        reward -= 1.0

    if '<tool_call>' in response_text and '</tool_call>' in response_text:
        reward += 4.0

    # ── CoT reasoning reward ──
    think_match = re.search(r'<think>(.*?)</think>', response_text, re.DOTALL)
    if think_match:
        think_text = think_match.group(1).strip()
        if len(think_text) > 50:
            reward += 1.0  # Substantive reasoning
        if "tool" in think_text.lower() or "requires" in think_text.lower():
            reward += 0.5  # Strategy-oriented thought
        if len(think_text) > 1000:
            reward -= 0.2  # Anti-thought-farming

    # Check if response contains a tool call
    tool_content = None
    tool_match = re.search(r'<tool_call>\s*(.*?)\s*</tool_call>', response_text, re.DOTALL)
    if tool_match:
        tool_content = tool_match.group(1)

    if not tool_content:
        # No tool call — acceptable for reasoning-only prompts
        reward += (0.0 if len(response_text) > 20 else -0.5)
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    try:
        tool_call = json.loads(tool_content)
        reward += 1.0  # Valid JSON
    except json.JSONDecodeError:
        reward -= 3.0
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    tool_name = tool_call.get("name", "")
    if tool_name in VALID_TOOLS:
        reward += 2.0
    else:
        reward -= 4.0
        return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))

    args = tool_call.get("arguments", {})
    params = TOOL_PARAMS.get(tool_name, {"required": set(), "optional": set()})

    missing_required = params["required"] - set(args.keys())
    if not missing_required:
        reward += 2.0
    else:
        reward -= 2.0 * len(missing_required)

    # Normalize to [-1.0, +1.0]
    return max(-1.0, min(1.0, (reward - RAW_MIN) / (RAW_MAX - RAW_MIN) * 2 - 1))


def generate_grpo_prompts():
    """Generate prompts for GRPO training."""
    prompts = [
        "Load the full context for the prism-mcp project",
        "Save this session: implemented RBAC roles",
        "Explain how React Server Components work",
        "Search for sessions about JWT authentication in synalux-private",
        "List all sessions for project bcba-private",
        "Delete the session from yesterday about the billing bug",
        "What do we know about the 'Zero-Search' architecture in prism?",
        "Store this knowledge: The ACT-R decay rate is 0.5 for rollup nodes",
        "Search for patterns about memory consolidation",
        "Hand off the billing task from dev to security: payment logic is ready",
        "Initialize a deep session for project synalux-docs",
        "Write a hello world in Python",
        "Find work related to the schema migration in v9.4",
        "What is the status of the HIPAA security audit?",
        "Log work: fixed the abortPipeline syntax error in dashboard",
    ]

    with open(GRPO_DATA, "w") as f:
        for prompt in prompts:
            f.write(json.dumps({
                "messages": [
                    {"role": "system", "content": "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."},
                    {"role": "user", "content": prompt}
                ]
            }) + "\n")
    return prompts


def generate_synthetic_chosen(prompt: str) -> str:
    """Generate a perfect response for a given prompt (used with --synthetic flag)."""
    if "Load" in prompt and "prism-mcp" in prompt:
        return '<think>The user wants to load project context for "prism-mcp". This is a read operation. I should use session_load_context with the project name.</think>\n\n<tool_call>\n{"name": "session_load_context", "arguments": {"project": "prism-mcp", "level": "shallow"}}\n</tool_call>'
    if "Save" in prompt and "RBAC" in prompt:
        return '<think>The user wants to save a work session about RBAC. This is a write operation to the session ledger. I should use session_save.</think>\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "prism-mcp", "summary": "implemented RBAC roles"}}\n</tool_call>'
    if "Search" in prompt and "JWT" in prompt:
        return '<think>The user is asking about JWT authentication work. I should use session_search to find relevant history.</think>\n\n<tool_call>\n{"name": "session_search", "arguments": {"query": "JWT authentication", "project": "synalux-private"}}\n</tool_call>'
    if "Store this knowledge" in prompt:
        return '<think>The user wants to store a principle about memory decay. I should use knowledge_save for permanent storage.</think>\n\n<tool_call>\n{"name": "knowledge_save", "arguments": {"project": "prism", "concept": "ACT-R Decay Rate", "description": "The ACT-R decay rate is 0.5 for rollup nodes", "confidence": 1.0}}\n</tool_call>'
    return None


def verify_reward_function():
    """Self-test the reward function with known inputs."""
    print("\n" + "=" * 60)
    print("Reward Function Verification:")
    print("=" * 60)

    test_cases = [
        ('<think>The user wants to save a session for project prism-mcp. This is a write operation. The correct tool is session_save which requires project and summary parameters. I have both values from the request.</think>\n\nI\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save WITH think (best case)"),
        ('I\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save (no think)"),
        ('<tool_call>\n{"name": "fake_tool", "arguments": {}}\n</tool_call>', "Hallucinated tool"),
        ('<tool_call>\n{invalid json}\n</tool_call>', "Invalid JSON"),
        ('Python is a programming language used for web development and data science.', "No tool (correct for reasoning)"),
        ('<tool_call>\n{"name": "session_save", "arguments": {}}\n</tool_call>', "Missing required params"),
        ('<think>Short.</think>\n\nJust explaining code.', "Short think + no tool (neutral)"),
        ('<think>Let me think about this question. ' + 'I need to reason carefully. ' * 80 + '</think>\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Thought farming (>1000 chars)"),
    ]

    for response, desc in test_cases:
        reward = compute_reward(response)
        print(f"  [{reward:+.3f}] {desc}")

    print("=" * 60)


def main():
    import argparse
    parser = argparse.ArgumentParser(description="GRPO Alignment for Tool-Use Accuracy")
    parser.add_argument("--synthetic", action="store_true", help="Inject synthetic gold-standard responses as chosen side")
    parser.add_argument("--repeat", type=int, default=5, help="Data repetition factor (default: 5)")
    parser.add_argument("--iters", type=int, default=300, help="Training iterations (default: 300)")
    parser.add_argument("--lr", type=float, default=1e-5, help="Learning rate (default: 1e-5)")
    parser.add_argument("--verify-only", action="store_true", help="Only run reward function verification, no training")
    args = parser.parse_args()

    # Always verify reward function first
    verify_reward_function()

    if args.verify_only:
        return

    print("\n" + "=" * 60)
    print("GRPO Alignment for Tool-Use Accuracy")
    print(f"  Synthetic injection: {'ON' if args.synthetic else 'OFF (true GRPO)'}")
    print(f"  Data repetition: {args.repeat}x")
    print(f"  Iterations: {args.iters}")
    print(f"  Learning rate: {args.lr}")
    print("=" * 60)

    prompts = generate_grpo_prompts()
    dpo_data = []

    try:
        from mlx_lm import load, generate
        print("\nLoading SFT model + adapter...")
        model, tokenizer = load(MODEL_PATH, adapter_path=SFT_ADAPTER)

        for i, prompt in enumerate(prompts):
            sys_msg = "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."
            full_prompt = f"<|im_start|>system\n{sys_msg}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"

            completions = []
            for j in range(4):
                try:
                    response = generate(model, tokenizer, prompt=full_prompt, max_tokens=256)
                    reward = compute_reward(response)
                    print(f"    [Prompt {i+1} Gen {j+1}] Reward: {reward:+.3f} | Response: {response[:60].replace(chr(10), ' ')}...")
                    completions.append((response, reward))
                except Exception as e:
                    print(f"  Warning: Generation failed: {e}")
                    continue

            if len(completions) >= 2:
                completions.sort(key=lambda x: x[1], reverse=True)
                best = completions[0]
                worst = completions[-1]

                if args.synthetic:
                    # Synthetic injection mode: use handcrafted "perfect" responses
                    synthetic_chosen = generate_synthetic_chosen(prompt)
                    if synthetic_chosen:
                        dpo_data.append({
                            "prompt": prompt,
                            "chosen": synthetic_chosen,
                            "rejected": worst[0],
                        })
                        continue

                # True GRPO: use model's own best vs worst
                if best[1] > worst[1]:
                    dpo_data.append({
                        "prompt": prompt,
                        "chosen": best[0],
                        "rejected": worst[0],
                    })

            if (i + 1) % 5 == 0:
                print(f"  Processed {i+1}/{len(prompts)} prompts, {len(dpo_data)} preference pairs")

        print(f"\nGenerated {len(dpo_data)} preference pairs")

        if len(dpo_data) >= 1:
            dpo_train_path = "/Users/admin/prism/training/data/dpo_train.jsonl"
            with open(dpo_train_path, "w") as f:
                for _ in range(args.repeat):
                    for d in dpo_data:
                        entry = {
                            "chosen": [
                                {"role": "user", "content": d["prompt"]},
                                {"role": "assistant", "content": d["chosen"]}
                            ],
                            "rejected": [
                                {"role": "user", "content": d["prompt"]},
                                {"role": "assistant", "content": d["rejected"]}
                            ]
                        }
                        f.write(json.dumps(entry) + "\n")

            total_examples = len(dpo_data) * args.repeat
            print(f"  Training data: {len(dpo_data)} unique pairs × {args.repeat} = {total_examples} examples")

            print(f"\nRunning DPO alignment training...")
            cmd = [
                sys.executable, "-m", "mlx_lm.lora",
                "--model", MODEL_PATH,
                "--train",
                "--data", os.path.dirname(dpo_train_path),
                "--adapter-path", OUTPUT_ADAPTER,
                "--num-layers", "12",
                "--batch-size", "1",
                "--iters", str(args.iters),
                "--max-seq-length", "1024",
                "--learning-rate", str(args.lr),
                "--steps-per-report", "50",
                "--save-every", "150",
                "--resume-adapter-file", os.path.join(SFT_ADAPTER, "adapters.safetensors"),
            ]

            print(f"Command: {' '.join(cmd)}")
            result = subprocess.run(cmd)

            if result.returncode == 0:
                print(f"\nGRPO alignment complete! Adapter: {OUTPUT_ADAPTER}")
            else:
                print(f"\nDPO training returned code {result.returncode}")
                print("Falling back to SFT adapter only")
                os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
                for fname in os.listdir(SFT_ADAPTER):
                    shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))
        else:
            print(f"\nNot enough preference pairs ({len(dpo_data)}) for DPO. Using SFT adapter.")
            os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
            for fname in os.listdir(SFT_ADAPTER):
                shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))

    except ImportError:
        print("ERROR: mlx_lm not installed. Run: pip3 install mlx mlx-lm")
        sys.exit(1)
    except Exception as e:
        print(f"GRPO failed: {e}")
        print("Falling back to SFT-only adapter")
        os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
        if os.path.exists(SFT_ADAPTER):
            for fname in os.listdir(SFT_ADAPTER):
                shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))


if __name__ == "__main__":
    main()
