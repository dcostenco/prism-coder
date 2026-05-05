"""Phase 1.5 polish for Prism Coder 32B — push for top-tier BFCL V4.

Loads the final_adapter from Phase 1 (prism-v18coder-32b-synalux volume) and
continues training on the surgical polish dataset that targets the 3 weakest
categories on the public Berkeley BFCL V4 leaderboard:

  - 1,600 multi-turn function-calling rows (30% of Overall — biggest weight)
  - 2,000 abstention/irrelevance rows (Live Irrelevance bug — 50% drag fixed)
  - 1,053 polyglot Java/JS rows (closes Java 49% / JS 58% gap)

LR 1e-6 (10x lower than Phase 1) — surgical to preserve the BFCL backbone +
AAC + Synalux weights from Phase 1. 1 epoch on H100×4. Cost: ~$50.

Expected delta vs Phase 1: Multi-Turn 25% → 50%+, Live Irrelevance 49% → 70%+,
Java/JS 50/58% → 75/75%. Should land Prism-Coder-32B at 60-65% Overall —
top-tier of the open-source 32B class.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

import modal

app = modal.App("prism-v18coder-32b-polish-v15")

import os

image = (
    modal.Image.debian_slim(python_version="3.11")
    .apt_install("git")
    .pip_install(
        "torch==2.5.1", "transformers==4.55.0", "trl==0.18.0", "peft==0.15.0",
        "datasets==3.6.0", "accelerate==1.7.0", "bitsandbytes==0.45.3",
        "huggingface_hub", "sentencepiece", "protobuf",
    )
    .env({"HF_TOKEN": os.environ.get("HF_TOKEN", "")})
)

DATA_VOL = modal.Volume.from_name("prism-sft-data")
PHASE1_VOL = modal.Volume.from_name("prism-v18coder-32b-synalux")
OUT_VOL = modal.Volume.from_name("prism-v18coder-32b-polish-v15", create_if_missing=True)

BASE_MODEL = "Qwen/Qwen2.5-Coder-32B-Instruct"
PHASE1_ADAPTER = "/phase1/final_adapter"
POLISH_DATA = "/data/train_v18coder_polish_v1_5.jsonl"


MODAL_TIMEOUT_S = 4 * 60 * 60  # 4h — polish is ~1h, generous margin


@app.function(
    image=image,
    gpu="H100:4",
    timeout=MODAL_TIMEOUT_S,
    volumes={"/data": DATA_VOL, "/phase1": PHASE1_VOL, "/out": OUT_VOL},
)
def run_polish_v15():
    import time as _time
    import torch
    from datasets import Dataset
    from peft import PeftModel
    from transformers import AutoModelForCausalLM, AutoTokenizer, TrainerCallback
    from trl import SFTTrainer, SFTConfig

    # See synalux-private/skills/modal-training-resilience — graceful exit
    # before Modal's hard timeout fires. Forces a final save + clean stop
    # so we lose no work even if the run goes long.
    class GracefulExitCallback(TrainerCallback):
        def __init__(self, max_secs: int):
            self.deadline = _time.time() + max_secs
            self._announced = False
        def on_step_end(self, args, state, control, **kwargs):
            if _time.time() > self.deadline:
                if not self._announced:
                    print(f"[graceful] deadline reached at step {state.global_step} — saving + stopping")
                    self._announced = True
                control.should_save = True
                control.should_training_stop = True
            return control

    print("=== Phase 1.5 polish: 32B + multi-turn + abstention + polyglot ===")
    print(f"  base    = {BASE_MODEL}")
    print(f"  adapter = {PHASE1_ADAPTER} (from Phase 1)")
    print(f"  data    = {POLISH_DATA}")
    print(f"  LR      = 1e-6 (surgical — 10x lower than Phase 1's 1e-5)")

    if not Path(PHASE1_ADAPTER).exists():
        raise FileNotFoundError(f"Phase 1 adapter not found at {PHASE1_ADAPTER}")

    tok = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token

    base = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL, torch_dtype=torch.bfloat16, device_map="auto",
        trust_remote_code=True,
    )
    base.config.use_cache = False
    if hasattr(base, "enable_input_require_grads"):
        base.enable_input_require_grads()

    model = PeftModel.from_pretrained(base, PHASE1_ADAPTER, is_trainable=True)
    print("loaded Phase 1 adapter; continuing on polish data")
    model.print_trainable_parameters()

    rows = []
    with open(POLISH_DATA) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj.get("text"), str) and len(obj["text"]) >= 100:
                    rows.append({"text": obj["text"]})
            except Exception:
                continue
    print(f"polish examples: {len(rows)}")
    ds = Dataset.from_list(rows)

    cfg = SFTConfig(
        output_dir="/out/v18coder_32b_polish_v15_run",
        num_train_epochs=1,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        gradient_checkpointing=True,
        learning_rate=1e-6,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        bf16=True,
        logging_steps=25,
        save_steps=100,                     # tighter: max 100-step loss vs 200
        save_total_limit=3,
        report_to="none",
        dataset_text_field="text",
        max_seq_length=2048,
        packing=False,
    )
    trainer = SFTTrainer(
        model=model, train_dataset=ds, processing_class=tok, args=cfg,
        callbacks=[GracefulExitCallback(max_secs=int(MODAL_TIMEOUT_S * 0.92))],
    )

    t0 = time.time()
    trainer.train()
    train_secs = time.time() - t0
    print(f"polish v1.5 done in {train_secs:.0f}s")

    final_dir = "/out/final_polish_v15_adapter"
    model.save_pretrained(final_dir)
    tok.save_pretrained(final_dir)

    meta = {
        "train_secs": round(train_secs, 1), "epochs": 1,
        "lr": cfg.learning_rate, "examples": len(rows),
        "base_model": BASE_MODEL,
        "input_adapter": PHASE1_ADAPTER,
        "data_composition": (
            "1,600 multi-turn (bfcl) + 2,000 abstention (bfcl + xlam) + "
            "1,053 polyglot (Java + JS + Python balance) = 4,653 rows total"
        ),
        "campaign": "Phase 1.5 — top-tier BFCL V4 push",
    }
    Path("/out/v18coder_32b_polish_v15_meta.json").write_text(json.dumps(meta, indent=2))
    OUT_VOL.commit()
    return meta


@app.local_entrypoint()
def run():
    """Use `modal run --detach modal_v18coder_32b_polish_phase1_5.py::run_polish_v15`
    to launch this in a truly detached state. The spawn() pattern below is
    kept ONLY for backward compat — modern Modal silently drops it when the
    local entrypoint exits. See synalux-private/skills/modal-training-resilience.
    """
    raise SystemExit(
        "ERROR: do not run this script via `modal run` (without --detach). "
        "Use:  modal run --detach modal_v18coder_32b_polish_phase1_5.py::run_polish_v15"
    )
