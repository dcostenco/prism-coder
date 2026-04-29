import json
import os

def filter_file(input_path, output_path, max_len=2000):
    if not os.path.exists(input_path):
        return
    kept = 0
    dropped = 0
    with open(input_path, "r") as f_in:
        lines = f_in.readlines()
        
    with open(output_path, "w") as f_out:
        for line in lines:
            data = json.loads(line)
            # Estimate tokens roughly based on characters (3.5 chars ~ 1 token)
            estimated_tokens = len(str(data)) / 3.5
            if estimated_tokens > max_len:
                dropped += 1
                continue
            f_out.write(line)
            kept += 1
    print(f"{input_path}: Kept {kept}, Dropped {dropped}")

data_dir = "/Users/admin/prism/training/models/prism-grpo-lora/dpo_data"
filter_file(f"{data_dir}/train.jsonl", f"{data_dir}/train.jsonl", 2000)
filter_file(f"{data_dir}/valid.jsonl", f"{data_dir}/valid.jsonl", 2000)
