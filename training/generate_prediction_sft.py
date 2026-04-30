#!/usr/bin/env python3
"""
Generate prediction SFT training data using Claude Opus as teacher.
Produces text completion examples for prism-coder:7b retraining.
Categories: AAC phrases, clinical/ABA, everyday, food ordering, social, medical.
"""

import json
import os
import time
import urllib.request

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_REDACTED")

CATEGORIES = {
    "aac_basic": [
        "I need", "I want", "I feel", "Can I", "Please help", "Where is",
        "I am", "My name is", "Take me to", "I don't", "Yes I", "No I don't",
        "More please", "All done", "Stop please", "Wait for", "Come here",
        "Look at", "Give me", "Show me", "Tell me", "Let me",
    ],
    "aac_emotions": [
        "I feel happy", "I feel sad", "I feel angry", "I feel tired",
        "I feel scared", "I feel sick", "I feel lonely", "I feel excited",
        "I feel confused", "I feel nervous", "I feel frustrated", "I feel proud",
        "I am worried about", "I am upset because", "I miss my",
    ],
    "aac_food": [
        "I would like to order", "Can I have", "I want to eat",
        "No onions", "Extra cheese", "With ketchup", "A glass of",
        "The check please", "Is this gluten", "I am allergic to",
        "Can I see the menu", "For here or", "I'll have the",
    ],
    "aac_social": [
        "How are you", "Nice to meet", "My friend is", "Can we play",
        "Do you want to", "I like your", "Happy birthday", "See you later",
        "What is your name", "Where do you live", "What grade are",
        "I go to", "My teacher is", "My favorite is",
    ],
    "clinical_soap": [
        "Subjective: Client", "Objective: During", "Assessment: Based",
        "Plan: Continue", "Plan: Modify", "Plan: The following",
        "Session Summary:", "Progress Note:", "Discharge Summary:",
        "Treatment Plan:", "Initial Assessment:", "Clinical Observation:",
    ],
    "clinical_aba": [
        "the client demonstrated", "behavior was observed", "prompting was faded",
        "mastery criteria of", "data indicates a", "replacement behavior was",
        "the target behavior", "parent training was", "generalization probes were",
        "maintenance data was", "functional communication", "antecedent strategies",
        "differential reinforcement", "discrete trial training", "natural environment",
        "token economy was", "crisis intervention", "extinction burst was",
        "response cost was", "task analysis for", "chaining procedure",
        "stimulus fading was", "preference assessment", "functional behavior",
        "behavior intervention", "verbal behavior targets", "mand training was",
        "tact training for", "intraverbal training", "echoic responses were",
    ],
    "clinical_medical": [
        "the patient presented", "vital signs are", "blood pressure was",
        "no significant changes", "follow up appointment", "recommend additional",
        "diagnosis confirmed", "treatment plan includes", "informed consent was",
        "medical necessity is", "caregiver reports that", "prescribed medication",
        "referral to specialist", "history of present", "review of systems",
    ],
    "everyday": [
        "What time is", "I need to go", "Can you drive me", "The weather is",
        "I have homework", "My class starts", "I forgot my", "Can you call",
        "I left my", "Where are my", "When is the", "How do I get to",
        "I have an appointment", "Pick me up at", "I need to buy",
    ],
}

def call_opus(prompt: str) -> str:
    data = json.dumps({
        "model": "claude-opus-4-20250514",
        "max_tokens": 80,
        "system": "You predict text completions. Given partial text, return ONLY a JSON array of 5 most likely next words or short phrases. No explanation, no markdown, just the array.",
        "messages": [{"role": "user", "content": f'Complete: "{prompt}"'}],
    }).encode()

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=data,
        headers={
            "Content-Type": "application/json",
            "x-api-key": API_KEY,
            "anthropic-version": "2023-06-01",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            text = result.get("content", [{}])[0].get("text", "[]")
            # Clean markdown wrappers
            text = text.strip().removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return json.dumps(parsed[:5])
    except Exception as e:
        print(f"  ERROR: {e}")
    return None

def main():
    output_path = "data/prediction_sft_generated.jsonl"
    count = 0

    with open(output_path, "w") as f:
        for category, prompts in CATEGORIES.items():
            print(f"\n=== {category} ({len(prompts)} prompts) ===")
            for prompt in prompts:
                result = call_opus(prompt)
                if result:
                    entry = {
                        "text": f'<|im_start|>user\nPredict 5 next words for: "{prompt}". Return ONLY JSON array.<|im_end|>\n<|im_start|>assistant\n{result}<|im_end|>'
                    }
                    f.write(json.dumps(entry) + "\n")
                    count += 1
                    print(f"  ✓ {prompt} → {result}")
                else:
                    print(f"  ✗ {prompt} — skipped")
                time.sleep(0.3)  # Rate limit

    print(f"\n✅ Generated {count} examples → {output_path}")

if __name__ == "__main__":
    main()
