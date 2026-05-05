"""Resume Phase 1 32B training from checkpoint-3000 — Modal timeout cut us at step 3481/5499.

The original run (modal_v18coder_32b_synalux_sft.py) hit Modal's 14h
function timeout at 63% completion. checkpoint-3000 was committed to
the volume; checkpoint-3500 was about to land but didn't survive.

We can't use trainer.resume_from_checkpoint(...) because torch==2.5.1
refuses to torch.load() optimizer state since CVE-2025-32434 (requires
torch>=2.6). Instead we treat checkpoint-3000 as a PEFT adapter and
continue training on the SAME 44K-row dataset with a fresh cosine
schedule over the remaining ~2500 steps. LR is approximated at the
point where the original cosine would have been at step 3000:

  cos(pi * 3000/5499) ≈ -0.144
  LR(3000) ≈ 1e-5 * 0.5 * (1 - 0.144) ≈ 4.3e-6

So we use LR=4e-6 cosine→0 over the remaining steps. Close enough.

Cost: ~$60 (4 GPUs × ~10h × ~$1.50/H100). Avoids losing $200+ of
already-trained Phase 1 weights AND keeps Phase 1.5 polish on track.

Output goes to the SAME volume + same final_adapter path that
modal_v18coder_32b_polish_phase1_5.py loads from, so the polish
script needs no changes.
"""
from __future__ import annotations

import json
import os
import time
from pathlib import Path

import modal

app = modal.App("prism-v18coder-32b-resume")

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
OUT_VOL = modal.Volume.from_name("prism-v18coder-32b-synalux")  # same volume — no create

BASE_MODEL = "Qwen/Qwen2.5-Coder-32B-Instruct"
TRAIN_DATA = "/data/train_v18coder_32b.jsonl"
RESUME_ADAPTER = "/out/v18coder_32b_synalux_run/checkpoint-3000"

# Approximate the cosine LR at the point we cut off. See module docstring.
RESUME_LR = 4e-6
# Original total was 5499 steps. We loaded checkpoint-3000, so ~2499 to go.
# Add a small buffer so we don't undershoot if the dataset shuffles to a
# slightly different step count. SFTTrainer auto-stops at end of dataset.
REMAINING_STEPS = 2700


MODAL_TIMEOUT_S = 20 * 60 * 60  # 20h — buffer over the previous 14h that killed us


@app.function(
    image=image,
    gpu="H100:4",
    timeout=MODAL_TIMEOUT_S,
    volumes={"/data": DATA_VOL, "/out": OUT_VOL},
)
def run_resume():
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

    print("=== Phase 1 RESUME from checkpoint-3000 ===")
    print(f"  base    = {BASE_MODEL}")
    print(f"  adapter = {RESUME_ADAPTER}")
    print(f"  data    = {TRAIN_DATA}")
    print(f"  LR      = {RESUME_LR} (cos approx at step 3000/5499)")
    print(f"  steps   = {REMAINING_STEPS} max")
    print(f"  timeout = 20h")

    if not Path(RESUME_ADAPTER).exists():
        raise FileNotFoundError(f"Resume adapter not found at {RESUME_ADAPTER}")

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

    model = PeftModel.from_pretrained(base, RESUME_ADAPTER, is_trainable=True)
    print("loaded checkpoint-3000 as PEFT adapter; continuing training")
    model.print_trainable_parameters()

    rows = []
    with open(TRAIN_DATA) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
                if isinstance(obj.get("text"), str) and len(obj["text"]) >= 50:
                    rows.append({"text": obj["text"]})
            except Exception:
                continue
    print(f"training examples: {len(rows)}")
    ds = Dataset.from_list(rows)

    cfg = SFTConfig(
        output_dir="/out/v18coder_32b_synalux_run_resume",
        num_train_epochs=1,
        max_steps=REMAINING_STEPS,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        gradient_checkpointing=True,
        learning_rate=RESUME_LR,
        lr_scheduler_type="cosine",
        warmup_ratio=0.0,  # no warmup on resume — we're already in the trained regime
        bf16=True,
        logging_steps=25,
        save_steps=200,                     # tighter: max ~50min lost vs 2h with 500
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
    print(f"resume done in {train_secs:.0f}s")

    # Save to the SAME final_adapter path the Phase 1.5 polish script expects
    final_dir = "/out/final_adapter"
    model.save_pretrained(final_dir)
    tok.save_pretrained(final_dir)

    meta = {
        "train_secs": round(train_secs, 1),
        "resumed_from": RESUME_ADAPTER,
        "resume_step_estimate": 3000,
        "max_steps_added": REMAINING_STEPS,
        "lr": RESUME_LR,
        "examples": len(rows),
        "base_model": BASE_MODEL,
        "campaign": "Phase 1 RESUME after Modal 14h timeout at step 3481/5499",
    }
    Path("/out/v18coder_32b_synalux_resume_meta.json").write_text(json.dumps(meta, indent=2))
    OUT_VOL.commit()
    return meta


@app.local_entrypoint()
def run():
    """The .spawn() pattern silently fails in current Modal SDK — task gets
    reaped when local entrypoint exits. Use --detach instead.
    See synalux-private/skills/modal-training-resilience.
    """
    raise SystemExit(
        "ERROR: do not run this script via `modal run` (without --detach). "
        "Use:  modal run --detach modal_v18coder_32b_resume.py::run_resume"
    )
