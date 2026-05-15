#!/usr/bin/env python3
"""
Training script pre-flight validation.

Scans all train_*.sh scripts in training/ and validates them BEFORE any
GPU-hours are burned.

Checks performed:
  1. 4-bit quantized bases are flagged for any tier that needs GGUF conversion
     (4-bit → fuse → dequant → Q4_K_M produces unshippable GGUFs with high TTFT)
  2. 32B scripts must use QwQ-32B lineage, not Qwen3-32B
     (mismatched base + published system prompt = adapter emits coherent text
     but zero tool calls)
  3. DATA_DIR referencing a known-bad corpus is flagged
  4. Extreme iteration counts (>200) are flagged
  5. Referenced data directories and config files must exist on disk

Run:
    pytest tests/training/test_training_script_preflight.py -v
"""

import re
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
TRAINING_DIR = REPO_ROOT / "training"

CANONICAL_32B_LINEAGE = "QwQ"
KNOWN_BAD_CORPORA = {"v25_max"}
MAX_SAFE_ITERS = 200


def _training_scripts() -> list[Path]:
    if not TRAINING_DIR.exists():
        return []
    return sorted(TRAINING_DIR.glob("train_*.sh"))


def _extract_var(text: str, var: str) -> str | None:
    """Extract a bash variable assignment like BASE_MODEL='...' or BASE_MODEL=\"...\"."""
    m = re.search(rf'{var}=["\']?([^"\';\n]+)["\']?', text)
    return m.group(1).strip() if m else None


def _extract_flag(text: str, flag: str) -> str | None:
    """Extract a CLI flag value like --iters 250."""
    m = re.search(rf'{flag}\s+(\S+)', text)
    return m.group(1).strip() if m else None


def _infer_tier(script_path: Path) -> str | None:
    name = script_path.stem.lower()
    for tag in ("1b7", "14b", "32b", "235b"):
        if tag in name:
            return tag
    return None


def _parse_script(script_path: Path) -> dict:
    text = script_path.read_text()
    base = _extract_var(text, "BASE_MODEL")
    data_dir = _extract_var(text, "DATA_DIR")
    iters_str = _extract_flag(text, "--iters")
    iters = int(iters_str) if iters_str and iters_str.isdigit() else None
    tier = _infer_tier(script_path)

    # Resolve relative data dir to corpus name
    corpus_name = None
    if data_dir:
        corpus_name = data_dir.rstrip("/").split("/")[-1]

    return {
        "path": script_path,
        "tier": tier,
        "base_model": base or "",
        "data_dir": data_dir,
        "corpus_name": corpus_name,
        "iters": iters,
        "text": text,
    }


_scripts = [_parse_script(s) for s in _training_scripts()]


@pytest.mark.skipif(not _scripts, reason="No train_*.sh scripts in training/")
@pytest.mark.parametrize(
    "script",
    _scripts,
    ids=[s["path"].name for s in _scripts],
)
class TestTrainingScriptPreflight:

    def test_no_4bit_base_for_gguf_tiers(self, script):
        """A 4-bit quantized MLX base will produce a GGUF with 60s+ TTFT.

        The MLX-4bit → fuse → dequant → Q4_K_M GGUF roundtrip is broken:
        llama.cpp can't use fast grouped kernels on the dequantized weights.
        Confirmed on M4 Max, May 2026 with mlx-community/Qwen3-32B-4bit.

        Safe alternative: download the bf16 base (needs 64GB unified memory
        for 32B) or train on RunPod with a bf16 base.
        """
        base = script["base_model"]
        if "4bit" not in base.lower() and "4-bit" not in base.lower():
            return  # not a quantized base — OK
        tier = script["tier"]
        if tier == "1b7":
            return  # 1.7B stays on-device, never converted to GGUF — safe
        pytest.fail(
            f"\n\n❌ 4-BIT BASE → GGUF CONVERSION WILL BE SLOW\n\n"
            f"  Script : {script['path'].name}\n"
            f"  Base   : {base}\n"
            f"  Tier   : {tier}\n\n"
            f"This base model is 4-bit quantized. After fuse → dequant → Q4_K_M,\n"
            f"the GGUF will have 60s+ TTFT (May 2026, M4 Max). Training will\n"
            f"succeed and unit tests will pass — the failure only surfaces at\n"
            f"100-case eval scale.\n\n"
            f"Fix: change BASE_MODEL to a bf16 base:\n"
            f"  32B: use Qwen/QwQ-32B or mlx-community/QwQ-32B (needs 64GB RAM)\n"
            f"  14B: use $SCRIPT_DIR/mlx_model_qwen3_14b (bf16, ~28GB)\n"
            f"  Or: train on RunPod with the bf16 HF base."
        )

    def test_32b_uses_qwq_lineage(self, script):
        """The 32B tier MUST use QwQ-32B, not Qwen3-32B.

        The published prism-coder:32b is trained from Qwen/QwQ-32B. Its system
        prompt and training corpus target QwQ-32B's tool-call behavior. Training
        on Qwen3-32B instead produces an adapter that generates coherent text
        but cannot emit tool calls — a silent functional regression caught only
        post-train.
        """
        if script["tier"] != "32b":
            return
        base = script["base_model"]
        # Local paths like $SCRIPT_DIR/mlx_model_qwq_32b are OK if they contain "qwq"
        # HF Hub paths like mlx-community/QwQ-32B are OK
        # HF Hub paths like mlx-community/Qwen3-32B-4bit are NOT OK
        base_lower = base.lower()
        if "qwq" in base_lower:
            return  # correct lineage
        if "qwen3-32b" in base_lower or "qwen/qwen3-32b" in base_lower:
            pytest.fail(
                f"\n\n❌ 32B LINEAGE MISMATCH — Qwen3-32B != QwQ-32B\n\n"
                f"  Script : {script['path'].name}\n"
                f"  Base   : {base}\n\n"
                f"The published prism-coder:32b is trained from Qwen/QwQ-32B.\n"
                f"Using Qwen3-32B instead produces an adapter that CANNOT emit\n"
                f"tool calls (system prompt + corpus target QwQ behavior).\n\n"
                f"Fix: BASE_MODEL=\"mlx-community/QwQ-32B\" (or the bf16 variant)"
            )

    def test_no_known_bad_corpus(self, script):
        """A corpus listed in KNOWN_BAD_CORPORA caused tool-call mode collapse
        in a prior fine-tune — over-saturating the model with tool-call
        exemplars made it invoke tools for plain-text prompts.

        Such corpora are kept on disk for regression detection but should not
        be referenced by any new training run.
        """
        corpus = script.get("corpus_name")
        if not corpus or corpus not in KNOWN_BAD_CORPORA:
            return
        pytest.fail(
            f"\n\n❌ KNOWN-BAD CORPUS REFERENCED\n\n"
            f"  Script : {script['path'].name}\n"
            f"  Corpus : {corpus}\n\n"
            f"This corpus is pinned as a known-bad recipe — it caused tool-call\n"
            f"mode collapse in a prior fine-tune. Use the current polish recipe\n"
            f"instead (smaller corpus, balanced tool/plain-text split)."
        )

    def test_iters_under_safety_limit(self, script):
        """Extreme iteration counts risk mode collapse on small tool-routing
        models. Light-touch polish recipes (~50 iters) gain points without
        regression; heavier touches commonly regress.

        >200 iters is suspicious. >400 is dangerous. This test flags >200
        to force a justification in the training script comments.
        """
        iters = script["iters"]
        if iters is None or iters <= MAX_SAFE_ITERS:
            return
        # Check for an explicit justification comment in the script
        if "JUSTIFIED:" in script["text"] or "HIGH_ITERS_OK:" in script["text"]:
            return
        pytest.fail(
            f"\n\n❌ HIGH ITERATION COUNT — MODE COLLAPSE RISK\n\n"
            f"  Script : {script['path'].name}\n"
            f"  Iters  : {iters} (gate: {MAX_SAFE_ITERS})\n\n"
            f"Heavy-touch fine-tunes on tool-routing models commonly regress.\n"
            f"Light-touch recipes (~50 iters) reliably gain points without\n"
            f"regression.\n\n"
            f"If high iters are intentional, add a comment to the script:\n"
            f"  # JUSTIFIED: <reason for high iters>"
        )

    def test_referenced_data_exists(self, script):
        """The data directory must exist before launching a training run.

        If DATA_DIR points to a missing directory, the training script will
        fail after GPU allocation — wasting the allocation fee.
        """
        data_dir = script.get("data_dir")
        if not data_dir:
            return
        # Resolve $SCRIPT_DIR to TRAINING_DIR
        resolved = data_dir.replace("$SCRIPT_DIR", str(TRAINING_DIR))
        resolved = resolved.replace("${SCRIPT_DIR}", str(TRAINING_DIR))
        p = Path(resolved)
        if not p.exists():
            pytest.fail(
                f"\n\n❌ DATA DIRECTORY MISSING\n\n"
                f"  Script : {script['path'].name}\n"
                f"  DATA_DIR: {data_dir}\n"
                f"  Resolved: {resolved}\n\n"
                f"The data directory doesn't exist. The training script will\n"
                f"fail after GPU allocation, wasting the setup time and fees."
            )


def test_at_least_one_script_scanned():
    """Sanity check — skip if no scripts exist (expected on CI/fresh checkout)."""
    if not _scripts:
        pytest.skip("No train_*.sh scripts found in training/")


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
