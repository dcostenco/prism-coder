#!/usr/bin/env python3
"""
Generate 1000+ prediction SFT training data using Claude Haiku (fast + cheap).
Uses Haiku for bulk generation, covers all categories exhaustively.
"""

import json
import os
import time
import urllib.request
import random

API_KEY = os.environ.get("ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_REDACTED")

# 200+ seed prompts across all categories
PROMPTS = [
    # === AAC BASIC (60) ===
    "I need", "I want", "I feel", "Can I", "Please help", "Where is",
    "I am", "My name is", "Take me to", "I don't", "Yes I", "No I don't",
    "More please", "All done", "Stop please", "Wait for", "Come here",
    "Look at", "Give me", "Show me", "Tell me", "Let me", "I like",
    "I need help with", "Can you help", "I want to go", "I want to play",
    "I need water", "I need food", "I need the bathroom", "I am ready",
    "I am not", "I don't want", "I don't like", "I don't understand",
    "Please wait", "Please stop", "Please come", "Please listen",
    "Can I go", "Can I play", "Can I eat", "Can I have", "Can I see",
    "Where is my", "Where is the", "Where are we", "Where did you",
    "What is", "What are", "What happened", "What time", "When is",
    "When can I", "Who is", "How do I", "How many", "How much",
    "Why is", "Why can't I",
    # === AAC EMOTIONS (40) ===
    "I feel happy", "I feel sad", "I feel angry", "I feel tired",
    "I feel scared", "I feel sick", "I feel lonely", "I feel excited",
    "I feel confused", "I feel nervous", "I feel frustrated", "I feel proud",
    "I am worried about", "I am upset because", "I miss my",
    "I am happy because", "I am sad because", "I am angry because",
    "I am scared of", "I don't feel well", "I feel better now",
    "I feel worse", "I need a hug", "I need a break", "I need comfort",
    "I am crying because", "I am laughing because", "I feel embarrassed",
    "I feel overwhelmed", "I feel calm now", "I feel unsafe",
    "I feel safe with", "I am bored", "I am having fun",
    "It hurts when", "It makes me sad when", "It makes me happy when",
    "I am afraid of", "I feel anxious about", "I am proud of",
    # === FOOD & ORDERING (40) ===
    "I would like to order", "Can I have a", "I want to eat",
    "No onions please", "Extra cheese please", "With ketchup",
    "A glass of water", "The check please", "Is this gluten free",
    "I am allergic to", "Can I see the menu", "For here or to go",
    "I'll have the", "Can I get a", "One more please",
    "I would like", "Medium size please", "Large please",
    "No ice please", "With milk", "Black coffee", "Orange juice",
    "I want pizza", "I want chicken", "I want fries", "I want a sandwich",
    "Side of", "Dressing on the side", "Can I substitute", "No salt",
    "Well done please", "Is this spicy", "What do you recommend",
    "How long will it take", "Can I have the special", "I am vegetarian",
    "Do you have vegan", "No dairy please", "Decaf please",
    "Can I order delivery",
    # === SOCIAL (40) ===
    "How are you", "Nice to meet you", "My friend is", "Can we play",
    "Do you want to", "I like your", "Happy birthday", "See you later",
    "What is your name", "Where do you live", "What grade are you in",
    "I go to", "My teacher is", "My favorite is",
    "Let's play together", "Want to be friends", "I had fun today",
    "Thank you for", "Sorry about", "I didn't mean to",
    "Can you come over", "What are you doing", "That was fun",
    "I agree with", "I disagree with", "Good morning",
    "Good afternoon", "Good night", "See you tomorrow",
    "Have a good day", "Nice talking to", "I appreciate",
    "Congratulations on", "I am sorry for", "Welcome to",
    "How was your day", "What did you do", "I went to",
    "We should go to", "Let me tell you about",
    # === SCHOOL & WORK (30) ===
    "I have a question", "I'm finished", "I don't understand this",
    "Can you repeat", "I need more time", "May I go to",
    "The answer is", "I think the answer", "Can you explain",
    "I forgot my homework", "My assignment is", "The test is",
    "I studied for", "Can I work with", "I need a pencil",
    "My project is about", "The class starts", "I am late because",
    "Can I present", "I have an idea", "I agree with that",
    "I need to finish", "My report is", "The deadline is",
    "I completed the", "Can I turn in", "I need to study",
    "My schedule is", "I have practice", "After school I",
    # === PLACES & NAVIGATION (25) ===
    "Take me to the", "I want to go to", "Where is the nearest",
    "How do I get to", "Is it far to", "Can we go to the",
    "I need to go to", "Let's go to", "The store is",
    "The hospital is", "The school is", "Turn left at",
    "Turn right at", "Go straight", "Stop here please",
    "We are lost", "I know the way", "Follow me to",
    "The address is", "It's on the corner", "Across the street",
    "Next to the", "Behind the", "In front of",
    "Which way to",
    # === CLINICAL SOAP (30) ===
    "Subjective: Client presented", "Subjective: Patient reports",
    "Subjective: Caregiver states", "Subjective: Parent describes",
    "Objective: During the session", "Objective: Data collected",
    "Objective: The following was", "Objective: Client responded",
    "Assessment: Based on the", "Assessment: Clinical observation",
    "Assessment: Progress toward", "Assessment: The data suggests",
    "Plan: Continue current", "Plan: Modify the", "Plan: Increase",
    "Plan: Decrease", "Plan: Add new", "Plan: Discontinue",
    "Plan: Refer to", "Plan: Schedule follow",
    "Session Summary: Today", "Progress Note: The client",
    "Discharge Summary: The patient", "Treatment Plan: Goals include",
    "Clinical Observation: The", "Behavioral Observation: During",
    "Data Summary: Across", "Recommendation: Based on",
    "Next Session: Focus on", "Supervision Note: Reviewed",
    # === ABA SPECIFIC (50) ===
    "the client demonstrated", "behavior was observed at",
    "prompting was faded from", "mastery criteria of 80%",
    "data indicates a trend", "replacement behavior was reinforced",
    "the target behavior occurred", "parent training was provided",
    "generalization probes were conducted", "maintenance data was collected",
    "functional communication training", "antecedent strategies included",
    "differential reinforcement of", "discrete trial training was",
    "natural environment teaching", "token economy was used",
    "crisis intervention procedures", "extinction burst was observed",
    "response cost was implemented", "task analysis for the",
    "chaining procedure was", "stimulus fading was used",
    "preference assessment revealed", "functional behavior assessment",
    "behavior intervention plan", "verbal behavior targets include",
    "mand training was conducted", "tact training for labeling",
    "intraverbal training focused", "echoic responses were assessed",
    "the reinforcement schedule", "interval recording showed",
    "frequency data indicates", "duration recording for",
    "latency data shows", "interresponse time was",
    "the discriminative stimulus", "stimulus control was",
    "conditional discrimination", "matching to sample",
    "incidental teaching during", "pivotal response training",
    "social skills group focused", "self-management program",
    "video modeling was used", "peer mediated intervention",
    "behavior momentum was", "high probability request",
    "Premack principle was", "shaping procedure for",
    # === MEDICAL (25) ===
    "the patient presented with", "vital signs are within",
    "blood pressure was measured", "no significant changes noted",
    "follow up appointment scheduled", "recommend additional testing",
    "diagnosis confirmed as", "treatment plan includes",
    "informed consent was obtained", "medical necessity is established",
    "caregiver reports that", "prescribed medication for",
    "referral to specialist for", "history of present illness",
    "review of systems reveals", "allergies include",
    "current medications are", "past medical history",
    "family history of", "surgical history includes",
    "immunizations are up to", "growth percentile is",
    "developmental milestone", "hearing screening results",
    "vision screening showed",
]

def call_haiku(prompt: str, retries: int = 2) -> str:
    data = json.dumps({
        "model": "claude-haiku-4-5-20251001",
        "max_tokens": 60,
        "system": "You predict text completions. Given partial text, return ONLY a JSON array of 5 likely next words or short phrases the user might type next. Example: [\"word1\", \"word2\", \"word3\", \"word4\", \"word5\"]. No markdown, no explanation, just the array.",
        "messages": [{"role": "user", "content": f'Predict next words after: "{prompt}"'}],
    }).encode()

    for attempt in range(retries + 1):
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
            with urllib.request.urlopen(req, timeout=15) as resp:
                result = json.loads(resp.read())
                text = result.get("content", [{}])[0].get("text", "[]")
                text = text.strip()
                if text.startswith("```"):
                    text = text.split("\n", 1)[-1] if "\n" in text else text[3:]
                if text.endswith("```"):
                    text = text[:-3]
                text = text.strip()
                start = text.find("[")
                end = text.rfind("]")
                if start >= 0 and end > start:
                    text = text[start:end+1]
                parsed = json.loads(text)
                if isinstance(parsed, list) and len(parsed) >= 3:
                    return json.dumps([str(x) for x in parsed[:5]])
        except urllib.error.HTTPError as e:
            if e.code == 429 and attempt < retries:
                time.sleep(5 * (attempt + 1))
                continue
        except Exception:
            pass
        break
    return None

def make_variations(prompt: str) -> list:
    """Create partial-word variations for training prefix completion."""
    words = prompt.split()
    variations = [prompt]
    # Add truncated last word (simulate typing)
    if len(words[-1]) > 3:
        for cut in [3, 4, 5]:
            if cut < len(words[-1]):
                truncated = " ".join(words[:-1]) + " " + words[-1][:cut]
                if truncated != prompt:
                    variations.append(truncated)
    return variations

def main():
    output_path = "data/prediction_sft_1k.jsonl"
    count = 0
    seen = set()

    # Expand prompts with variations
    all_prompts = []
    for p in PROMPTS:
        for v in make_variations(p):
            if v not in seen:
                seen.add(v)
                all_prompts.append(v)

    random.shuffle(all_prompts)
    # Run each prompt 3-5x with slight temperature variation for diversity
    extra = []
    while len(all_prompts) + len(extra) < 3000:
        extra.extend(random.sample(all_prompts, min(len(all_prompts), 3000 - len(all_prompts) - len(extra))))
    all_prompts.extend(extra)
    random.shuffle(all_prompts)
    target = len(all_prompts)
    print(f"Total prompts to process: {len(all_prompts)} (target: {target})")

    with open(output_path, "w") as f:
        for i, prompt in enumerate(all_prompts):
            result = call_haiku(prompt)
            if result:
                entry = {
                    "text": f'<|im_start|>user\nPredict 5 next words for: "{prompt}". Return ONLY JSON array.<|im_end|>\n<|im_start|>assistant\n<think>\nThis is a text prediction request, not a tool call. I need to predict the most likely next words based on context.\n</think>\n{result}<|im_end|>'
                }
                f.write(json.dumps(entry) + "\n")
                count += 1
                if count % 25 == 0:
                    print(f"  [{count}/{len(all_prompts)}] ✓ {prompt}")
            else:
                print(f"  [{i}] ✗ {prompt}")
            time.sleep(1.0)  # Rate limit: 1 req/sec to avoid 429

    print(f"\n✅ Generated {count} prediction examples → {output_path}")

if __name__ == "__main__":
    main()
