#!/usr/bin/env python3
"""
GRPO (Group Relative Policy Optimization) for tool-use accuracy.
Uses deterministic reward function — no reward model needed.
"""
import json
import os
import sys
import subprocess

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
    
    Scoring:
      +1.0 if tool_call JSON parses correctly
      +1.0 if tool_name ∈ valid_tools
      +1.0 if all required params present
      +0.5 for each correct optional param (max +2.0)
      -2.0 for hallucinated tool name
      -1.0 for missing required param
      +0.5 for natural language before tool call (reasoning)

    Chain-of-Thought (CoT) rewards:
      +0.5 if <think> block present with > 100 chars of reasoning
      -0.2 if <think> block exceeds 1000 chars (anti-thought-farming)
    """
    import re

    reward = 0.0

    # ── CoT reasoning reward ──
    think_match = re.search(r'<think>(.*?)</think>', response_text, re.DOTALL)
    if think_match:
        think_len = len(think_match.group(1).strip())
        if think_len > 100:
            reward += 0.5  # Substantive reasoning
        if think_len > 1000:
            reward -= 0.2  # Anti-thought-farming penalty (capped conciseness)

    # Check if response contains a tool call
    tool_match = re.search(r'<tool_call>\s*(.*?)\s*</tool_call>', response_text, re.DOTALL)
    if not tool_match:
        # No tool call — could be valid for non-tool queries
        # Give neutral reward if response is substantive
        return reward + (0.0 if len(response_text) > 20 else -0.5)

    # Check if there's reasoning text before the tool call (legacy pre-think format)
    pre_tool = response_text[:response_text.index('<tool_call>')].strip()
    # Remove the <think> block itself from pre_tool length check to avoid double-counting
    pre_tool_clean = re.sub(r'<think>.*?</think>', '', pre_tool, flags=re.DOTALL).strip()
    if len(pre_tool_clean) > 10:
        reward += 0.5  # Reasoning before action

    # Try to parse JSON
    try:
        tool_call = json.loads(tool_match.group(1))
        reward += 1.0  # Valid JSON
    except json.JSONDecodeError:
        return reward - 1.0  # Invalid JSON is heavily penalized

    # Check tool name
    tool_name = tool_call.get("name", "")
    if tool_name in VALID_TOOLS:
        reward += 1.0  # Valid tool name
    else:
        reward -= 2.0  # Hallucinated tool
        return reward

    # Check required params
    args = tool_call.get("arguments", {})
    params = TOOL_PARAMS.get(tool_name, {"required": set(), "optional": set()})

    missing_required = params["required"] - set(args.keys())
    if not missing_required:
        reward += 1.0  # All required params present
    else:
        reward -= 1.0 * len(missing_required)  # Penalize each missing required param

    # Bonus for optional params (capped at +2.0)
    correct_optional = params["optional"] & set(args.keys())
    reward += min(len(correct_optional) * 0.5, 2.0)

    return reward


def generate_grpo_prompts():
    """Generate prompts for GRPO training from diverse tool-use scenarios."""
    prompts = [
        "Load the full context for the prism-mcp project",
        "Save this session: implemented RBAC roles",
        "Explain how React Server Components work"
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


def main():
    print("=" * 60)
    print("GRPO Alignment for Tool-Use Accuracy")
    print("=" * 60)

    # Generate GRPO prompts
    prompts = generate_grpo_prompts()
    print(f"Generated {len(prompts)} GRPO training prompts")

    # For MLX, GRPO is implemented as iterative DPO with self-generated preferences
    # We'll use the SFT model to generate K=4 completions, rank by reward, then train DPO
    print("\nStep 1: Generate K=4 completions per prompt using SFT model...")
    print("Step 2: Rank completions by deterministic reward function")
    print("Step 3: Create preference pairs (best vs worst)")
    print("Step 4: Run DPO-style training on preference pairs")

    # Generate preference data using the SFT model
    dpo_data = []
    
    # Use mlx_lm to generate completions
    try:
        from mlx_lm import load, generate
        
        print("\nLoading SFT model + adapter...")
        model, tokenizer = load(MODEL_PATH, adapter_path=SFT_ADAPTER)
        
        for i, prompt in enumerate(prompts):
            sys_msg = "You are Prism, an AI coding assistant with persistent memory. Use MCP tools when appropriate."
            full_prompt = f"<|im_start|>system\n{sys_msg}<|im_end|>\n<|im_start|>user\n{prompt}<|im_end|>\n<|im_start|>assistant\n"
            
            # Generate K=4 completions with different temperatures
            completions = []
            for temp in [0.0, 0.0, 0.0, 0.0]:
                try:
                    response = generate(
                        model, tokenizer, 
                        prompt=full_prompt,
                        max_tokens=256
                    )
                    reward = compute_reward(response)
                    completions.append((response, reward))
                except Exception as e:
                    print(f"  Warning: Generation failed for temp={temp}: {e}")
                    continue
            
            if len(completions) >= 2:
                # Sort by reward
                completions.sort(key=lambda x: x[1], reverse=True)
                best = completions[0]
                worst = completions[-1]
                
                if best[1] > worst[1]:  # Only if there's a preference signal
                    dpo_data.append({
                        "prompt": prompt,
                        "chosen": best[0],
                        "rejected": worst[0],
                        "chosen_reward": best[1],
                        "rejected_reward": worst[1],
                    })
            
            if (i + 1) % 5 == 0:
                print(f"  Processed {i+1}/{len(prompts)} prompts, {len(dpo_data)} preference pairs")
        
        print(f"\nGenerated {len(dpo_data)} preference pairs")
        
        # Save preference data
        dpo_path = "/Users/admin/prism/training/data/grpo_preferences.jsonl"
        with open(dpo_path, "w") as f:
            for d in dpo_data:
                f.write(json.dumps(d) + "\n")
        
        # If we have enough pairs, run DPO training
        if len(dpo_data) >= 1:
            # Convert to ChatML format for MLX DPO
            dpo_train_path = "/Users/admin/prism/training/data/dpo_train.jsonl"
            with open(dpo_train_path, "w") as f:
                for d in dpo_data:
                    # Format as chosen/rejected message pairs
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
            
            print(f"\nRunning DPO alignment training...")
            cmd = [
                sys.executable, "-m", "mlx_lm.lora",
                "--model", MODEL_PATH,
                "--train",
                "--data", os.path.dirname(dpo_train_path),
                "--adapter-path", OUTPUT_ADAPTER,
                "--lora-layers", "16",
                "--lora-rank", "8",
                "--batch-size", "1",
                "--iters", "200",
                "--learning-rate", "5e-6",
                "--steps-per-report", "20",
                "--save-every", "100",
                "--resume-adapter-file", os.path.join(SFT_ADAPTER, "adapters.safetensors"),
            ]
            
            print(f"Command: {' '.join(cmd)}")
            result = subprocess.run(cmd)
            
            if result.returncode == 0:
                print(f"\nGRPO alignment complete! Adapter: {OUTPUT_ADAPTER}")
            else:
                print(f"\nDPO training returned code {result.returncode}")
                print("Falling back to SFT adapter only")
                # Copy SFT adapter as final
                os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
                import shutil
                for f in os.listdir(SFT_ADAPTER):
                    shutil.copy2(os.path.join(SFT_ADAPTER, f), os.path.join(OUTPUT_ADAPTER, f))
        else:
            print(f"\nNot enough preference pairs ({len(dpo_data)}) for DPO. Using SFT adapter.")
            os.makedirs(OUTPUT_ADAPTER, exist_ok=True)
            import shutil
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
            import shutil
            for fname in os.listdir(SFT_ADAPTER):
                shutil.copy2(os.path.join(SFT_ADAPTER, fname), os.path.join(OUTPUT_ADAPTER, fname))

    # Print reward function verification
    print("\n" + "=" * 60)
    print("Reward Function Verification:")
    print("=" * 60)
    
    test_cases = [
        ('I\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save (no think)"),
        ('<tool_call>\n{"name": "fake_tool", "arguments": {}}\n</tool_call>', "Hallucinated tool"),
        ('<tool_call>\n{invalid json}\n</tool_call>', "Invalid JSON"),
        ('Python is a programming language used for web development and data science.', "No tool (correct)"),
        ('<tool_call>\n{"name": "session_save", "arguments": {}}\n</tool_call>', "Missing required params"),
        # CoT-specific test cases
        ('<think>The user wants to save a session for project prism-mcp. This is a write operation. The correct tool is session_save which requires project and summary parameters. I have both values from the request.</think>\n\nI\'ll save this.\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Valid save WITH think (+0.5 CoT)"),
        ('<think>Let me think about this question. ' + 'I need to reason carefully. ' * 80 + '</think>\n\n<tool_call>\n{"name": "session_save", "arguments": {"project": "test", "summary": "test"}}\n</tool_call>', "Thought farming (>1000 chars, -0.2)"),
        ('<think>Short.</think>\n\nJust explaining code.', "Short think + no tool (neutral)"),
    ]
    
    for response, desc in test_cases:
        reward = compute_reward(response)
        print(f"  [{reward:+.1f}] {desc}")


if __name__ == "__main__":
    main()
