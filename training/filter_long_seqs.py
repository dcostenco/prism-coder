import json
import os
from transformers import AutoTokenizer

def filter_file(input_path, output_path, max_len=2000):
    tokenizer = AutoTokenizer.from_pretrained("Salesforce/xLAM-2-32b-fc-r")
    kept = 0
    dropped = 0
    
    with open(input_path, "r") as f_in:
        lines = f_in.readlines()
        
    with open(output_path, "w") as f_out:
        for line in lines:
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

_TRAINING_DIR = os.path.dirname(os.path.abspath(__file__))
os.makedirs(os.path.join(_TRAINING_DIR, "data", "filtered"), exist_ok=True)
filter_file(os.path.join(_TRAINING_DIR, "data", "combined", "train.jsonl"), os.path.join(_TRAINING_DIR, "data", "filtered", "train.jsonl"))
filter_file(os.path.join(_TRAINING_DIR, "data", "combined", "valid.jsonl"), os.path.join(_TRAINING_DIR, "data", "filtered", "valid.jsonl"))
