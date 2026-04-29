import json
from transformers import AutoTokenizer

tokenizer = AutoTokenizer.from_pretrained("Qwen/Qwen2.5-Coder-7B-Instruct")

def analyze_lengths(filepath):
    print(f"Analyzing {filepath}")
    with open(filepath, "r") as f:
        lines = f.readlines()
    
    lengths = []
    for line in lines:
        data = json.loads(line)
        # Format the text as the chat template would
        text = ""
        for m in data["messages"]:
            text += f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n"
        
        # Calculate prompt length (everything except the last assistant message)
        prompt_text = ""
        for m in data["messages"][:-1]:
            prompt_text += f"<|im_start|>{m['role']}\n{m['content']}<|im_end|>\n"
        prompt_text += "<|im_start|>assistant\n"
        
        total_len = len(tokenizer.encode(text))
        prompt_len = len(tokenizer.encode(prompt_text))
        assist_len = total_len - prompt_len
        
        lengths.append((total_len, prompt_len, assist_len))
    
    lengths.sort(key=lambda x: x[0])
    print(f"Total sequences: {len(lengths)}")
    print(f"Min total length: {lengths[0][0]}, Max total length: {lengths[-1][0]}")
    
    # Check how many have prompt_len > 1024
    over_1024 = sum(1 for x in lengths if x[1] > 1024)
    print(f"Prompts > 1024 tokens: {over_1024}")
    
    over_2048 = sum(1 for x in lengths if x[0] > 2048)
    print(f"Total > 2048 tokens: {over_2048}")
    
    print("Top 10 longest total sequences:")
    for x in lengths[-10:]:
        print(f"  Total: {x[0]}, Prompt: {x[1]}, Assistant: {x[2]}")

_TRAINING_DIR = os.path.dirname(os.path.abspath(__file__))
analyze_lengths(os.path.join(_TRAINING_DIR, "models", "prism-grpo-lora", "dpo_data", "train.jsonl"))
