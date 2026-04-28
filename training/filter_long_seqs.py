import json
import os
from transformers import AutoTokenizer

def filter_file(input_path, output_path, max_len=2000):
    tokenizer = AutoTokenizer.from_pretrained("Salesforce/xLAM-2-32b-fc-r")
    kept = 0
    dropped = 0
    with open(input_path, "r") as f_in, open(output_path, "w") as f_out:
        for line in f_in:
            data = json.loads(line)
            text_content = ""
            if "messages" in data:
                text_content = " ".join([m.get("content", "") for m in data["messages"]])
            elif "text" in data:
                text_content = data["text"]
            
            if len(str(data)) / 3.5 > max_len:
                tokens = len(tokenizer.encode(text_content))
                if tokens > max_len:
                    dropped += 1
                    continue
            f_out.write(line)
            kept += 1
    print(f"{input_path}: Kept {kept}, Dropped {dropped}")

os.makedirs("/Users/admin/prism/training/data/filtered", exist_ok=True)
filter_file("/Users/admin/prism/training/data/combined/train.jsonl", "/Users/admin/prism/training/data/filtered/train.jsonl")
filter_file("/Users/admin/prism/training/data/combined/valid.jsonl", "/Users/admin/prism/training/data/filtered/valid.jsonl")
