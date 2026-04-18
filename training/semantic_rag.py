import json
import urllib.request
import os

TOOL_SCHEMA_PATH = "/Users/admin/prism/training/data/tool_schema.json"
EMBEDDINGS_PATH = "/Users/admin/prism/training/data/tool_embeddings.json"

def get_embedding(text):
    req = urllib.request.Request("http://localhost:11434/api/embeddings", 
        data=json.dumps({"model": "nomic-embed-text", "prompt": text}).encode('utf-8'),
        headers={'Content-Type': 'application/json'})
    try:
        res = urllib.request.urlopen(req)
        return json.loads(res.read().decode('utf-8'))['embedding']
    except Exception as e:
        print(f"Error getting embedding: {e}")
        return None

def main():
    print("Generating Nomic embeddings for MCP tools...")
    
    with open(TOOL_SCHEMA_PATH, "r") as f:
        schema = json.load(f)
        
    tools = schema.get("tools", [])
    print(f"Found {len(tools)} tools.")
    
    embeddings = {}
    for t in tools:
        name = t["name"]
        desc = t["description"]
        print(f"Embedding tool: {name}")
        emb = get_embedding(f"{name}: {desc}")
        if emb:
            embeddings[name] = {
                "schema": t,
                "embedding": emb
            }
            
    with open(EMBEDDINGS_PATH, "w") as f:
        json.dump(embeddings, f, indent=2)
        
    print(f"Saved embeddings to {EMBEDDINGS_PATH}")

if __name__ == "__main__":
    main()
