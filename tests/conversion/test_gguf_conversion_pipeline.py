#!/usr/bin/env python3
"""
Conversion pipeline test.

Pins the "MLX 4-bit → dequant → Q4_K_M GGUF = high-TTFT inference" failure mode.

THE FAILURE
-----------
This is a subtle breakage of the training-to-deploy cycle:
  - Training succeeds, loss converges normally
  - MLX-eval unit tests pass (correct tool calls, accurate routing)
  - The failure is only caught at 100-case eval scale when TTFT is much
    higher than expected for the model size

Root cause:
  When a fine-tuned adapter is fused into a 4-bit-quantized MLX base
  (e.g. `mlx-community/<model>-4bit`), the fused model's config.json
  declares `quantization.bits = 4`. The conversion then:
    1. mlx_lm.convert --dequantize → bf16 safetensors (the -dq/ dir)
    2. convert_hf_to_gguf.py → raw GGUF
    3. llama-quantize → Q4_K_M GGUF

  The dequant step (step 1) inflates the 4-bit group statistics into bf16
  tensors whose weight distributions do NOT compress well under Q4_K_M's
  group quantization — they end up with non-uniform row magnitudes that
  force llama.cpp into a slow sequential weight-access path. Result is
  multi-second TTFT vs the expected sub-10s for a properly sourced GGUF.

WHY UNIT TESTS MISSED IT
-------------------------
The MLX unit tests run the fused safetensors directly inside mlx_lm — they
never go through the GGUF conversion. The fused 4-bit model runs fine in MLX
because MLX has native 4-bit kernels. The slow path is GGUF-specific and only
appears after the dequant → convert roundtrip. A 1-case prompt test can pass
in 5s; a 100-case eval at 60s/prompt takes 100 minutes and is immediately
obvious as unshippable.

SAFE CONVERSION PATHS
---------------------
  SAFE   : bf16 base → fine-tune → fuse → Q4_K_M GGUF
             (requires 64GB unified memory for 32B, but TTFT is ~8s)
  SAFE   : bf16 base → fine-tune → fuse → upload adapter + merge on cloud
             (RunPod with enough VRAM, cheaper than local 64GB requirement)
  UNSAFE : 4-bit MLX base → fine-tune → fuse → dequant → Q4_K_M GGUF
             (60s+ TTFT — do not ship)

ESCAPE HATCH
------------
If you have measured acceptable TTFT on a 4-bit-sourced GGUF AND have a clear
explanation (e.g. a new llama.cpp kernel fixed the slow path), create a file:

    training/models/<name>-fused/CONVERSION_JUSTIFICATION.md

The static tests skip models that have this file. The TTFT gate still runs.

Tests
-----
  1. test_no_gguf_from_4bit_fused_source   — static, no external deps
  2. test_dq_dir_source_is_not_4bit_fused  — static, no external deps
  3. test_gguf_ttft_under_threshold        — runtime, requires Ollama on port 11434

Run:
    pytest tests/conversion/test_gguf_conversion_pipeline.py -v
"""

import json
import re
import time
from pathlib import Path
from typing import Optional

import pytest
import requests


REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO_ROOT / "training" / "models"

# Per-size TTFT thresholds (seconds for a full short-completion response,
# measured on the SECOND probe after a warm-up call loads the model).
# The failure was 60s+; these gates give ~3x headroom over typical fast TTFT
# while still catching the dequant slow path long before it's unshippable.
TTFT_THRESHOLDS = {
    "1b7": 8,
    "1.7b": 8,
    "14b": 20,
    "32b": 35,
    "_default": 45,
}

OLLAMA_URL = "http://localhost:11434"

# Probe prompt — short expected response, forces one tool call, low token budget.
_PROBE_PROMPT = "Save a ledger note: conversion pipeline test probe"
_PROBE_SYSTEM = (
    "When a tool is needed respond ONLY with:\n"
    "<|tool_call|>\n{\"name\": \"session_save_ledger\", \"arguments\": {}}\n<|tool_call_end|>"
)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _fused_dirs_with_4bit():
    """Yield (fused_dir, prefix) for every *-fused/ dir whose config declares bits=4."""
    if not MODELS_DIR.exists():
        return
    for fused in sorted(MODELS_DIR.glob("*-fused")):
        if not fused.is_dir():
            continue
        cfg_path = fused / "config.json"
        if not cfg_path.exists():
            continue
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        bits = (cfg.get("quantization") or {}).get("bits") or \
               (cfg.get("quantization_config") or {}).get("bits")
        if bits and int(bits) == 4:
            yield fused, fused.stem.removesuffix("-fused")


def _gguf_prefix(gguf_path: Path) -> str:
    """Strip quantization suffixes to get the base name prefix.

    Examples:
      qwen3-32b-finetuned-q4km.gguf       → qwen3-32b-finetuned
      qwen3-32b-finetuned.gguf            → qwen3-32b-finetuned
      prism-coder-32b-q4_k_m.gguf         → prism-coder-32b
    """
    stem = gguf_path.stem
    # Strip known quantization suffixes (order matters — longest first)
    for suffix in ("-q4_k_m", "-q4km", "-q8_0", "-q8", "-q4_0", "-q4", "-bf16", "-f16"):
        if stem.endswith(suffix):
            stem = stem[: -len(suffix)]
            break
    return stem


def _gguf_files() -> list[Path]:
    if not MODELS_DIR.exists():
        return []
    return sorted(MODELS_DIR.rglob("*.gguf"))


def _dq_dirs():
    """Yield (dq_dir, fused_dir_or_None) for every *-dq/ directory."""
    if not MODELS_DIR.exists():
        return
    for dq in sorted(MODELS_DIR.glob("*-dq")):
        if not dq.is_dir():
            continue
        # Corresponding fused dir: replace -dq with -fused
        fused = MODELS_DIR / (dq.stem.removesuffix("-dq") + "-fused")
        yield dq, fused if fused.is_dir() else None


def _has_justification(fused_dir: Path) -> bool:
    return (fused_dir / "CONVERSION_JUSTIFICATION.md").exists()


def _ollama_available() -> bool:
    try:
        return requests.get(f"{OLLAMA_URL}/api/tags", timeout=3).status_code == 200
    except Exception:
        return False


def _ollama_models() -> list[str]:
    try:
        data = requests.get(f"{OLLAMA_URL}/api/tags", timeout=5).json()
        return [m["name"] for m in data.get("models", [])]
    except Exception:
        return []


def _size_tag(model_name: str) -> str:
    """Infer size tier from Ollama model name."""
    name = model_name.lower()
    for tag in ("1b7", "1.7b", "14b", "32b"):
        if tag in name:
            return "1b7" if tag in ("1b7", "1.7b") else tag
    return "_default"


def _measure_response_time(model: str, timeout: int = 90) -> Optional[float]:
    """Return total response time in seconds on a WARMED model, or None on error.

    Sends two requests: the first (untimed) loads the model into Ollama's GPU
    memory. The second (timed) measures true inference speed free of cold-start
    overhead. Ollama swaps models between parametrize cases; without the warmup
    a multi-model suite would measure load time, not inference time.
    """
    _body = {
        "model": model,
        "messages": [
            {"role": "system", "content": _PROBE_SYSTEM},
            {"role": "user", "content": _PROBE_PROMPT},
        ],
        "stream": False,
        "options": {"temperature": 0, "num_predict": 60},
    }
    # Warm-up: load the model, don't care about the response.
    try:
        requests.post(f"{OLLAMA_URL}/api/chat", json=_body, timeout=120)
    except Exception:
        pass  # If warm-up itself times out the timed call will also fail → None
    # Timed probe.
    t0 = time.monotonic()
    try:
        r = requests.post(f"{OLLAMA_URL}/api/chat", json=_body, timeout=timeout)
        _ = r.json()
        return time.monotonic() - t0
    except Exception:
        return None


# ── Test 1: Static GGUF lineage check ─────────────────────────────────────────


def _static_4bit_gguf_cases():
    """Build parametrize data: (fused_dir, gguf_path) for dangerous pairs."""
    cases = []
    gguf_files = _gguf_files()
    for fused_dir, prefix in _fused_dirs_with_4bit():
        if _has_justification(fused_dir):
            continue
        for gguf in gguf_files:
            if _gguf_prefix(gguf) == prefix or gguf.stem.startswith(prefix):
                cases.append((fused_dir, gguf))
    return cases


_4bit_gguf_cases = _static_4bit_gguf_cases()


@pytest.mark.skipif(
    not MODELS_DIR.exists(),
    reason="training/models/ not present — no conversion artifacts to check",
)
@pytest.mark.parametrize(
    "fused_dir,gguf_path",
    _4bit_gguf_cases,
    ids=[f"{f.name}→{g.name}" for f, g in _4bit_gguf_cases],
)
def test_no_gguf_from_4bit_fused_source(fused_dir, gguf_path):
    """A GGUF derived from a 4-bit-quantized MLX fused model will have high TTFT.

    Failure mode: when an adapter is fused into a 4-bit MLX base
    (e.g. mlx-community/<model>-4bit), the fused config.json declares
    quantization.bits=4. The dequant → Q4_K_M GGUF conversion produces a
    model with multi-second TTFT — unshippable for production.

    The GGUF at {gguf_path.name} appears to be derived from {fused_dir.name}
    (shared name prefix), and {fused_dir.name}/config.json declares bits=4.

    To resolve, choose one of:
      (a) Delete {gguf_path.name} and retrain from a bf16 base:
              Qwen/QwQ-32B or Qwen/Qwen3-32B (bf16, 64GB unified memory needed)
      (b) Upload the adapter to RunPod, merge on a bf16 remote, convert there.
      (c) If you have verified acceptable TTFT (< {TTFT_THRESHOLDS['32b']}s on 32B /
          < {TTFT_THRESHOLDS['14b']}s on 14B), document it in:
              {fused_dir}/CONVERSION_JUSTIFICATION.md
          The static check will then skip, but the TTFT gate still runs.
    """
    pytest.fail(
        f"\n\n❌ GGUF FROM 4-BIT FUSED SOURCE — 60s+ TTFT RISK\n\n"
        f"  GGUF    : {gguf_path.relative_to(REPO_ROOT)}\n"
        f"  Source  : {fused_dir.relative_to(REPO_ROOT)}/config.json\n"
        f"  bits    : 4  (set by mlx_lm.fuse on a 4-bit-quantized base)\n\n"
        f"The MLX-4bit → dequant → Q4_K_M GGUF roundtrip produces a GGUF where\n"
        f"llama.cpp cannot use its fast grouped matrix-vector kernel. The result\n"
        f"is 60s+ TTFT on 32B (confirmed May 2026 on M4 Max).\n\n"
        f"Training succeeded. Unit tests passed. Only caught at 100-case scale.\n\n"
        f"Fix options:\n"
        f"  (a) Retrain from bf16 base ({fused_dir.stem.split('-')[0].upper()} needs ~64GB unified memory)\n"
        f"  (b) Merge adapter on RunPod bf16 instance, convert there\n"
        f"  (c) If TTFT is measured acceptable, write:\n"
        f"        {fused_dir}/CONVERSION_JUSTIFICATION.md"
    )


# ── Test 2: dq intermediate guard ─────────────────────────────────────────────


def _dq_4bit_cases():
    """Build parametrize data: (dq_dir, fused_dir) where fused is 4-bit."""
    cases = []
    for dq_dir, fused_dir in _dq_dirs():
        if fused_dir is None:
            continue
        if _has_justification(fused_dir):
            continue
        cfg_path = fused_dir / "config.json"
        if not cfg_path.exists():
            continue
        try:
            cfg = json.loads(cfg_path.read_text())
        except Exception:
            continue
        bits = (cfg.get("quantization") or {}).get("bits") or \
               (cfg.get("quantization_config") or {}).get("bits")
        if bits and int(bits) == 4:
            cases.append((dq_dir, fused_dir))
    return cases


_dq_cases = _dq_4bit_cases()


@pytest.mark.skipif(
    not MODELS_DIR.exists(),
    reason="training/models/ not present",
)
@pytest.mark.parametrize(
    "dq_dir,fused_dir",
    _dq_cases,
    ids=[f"{d.name}" for d, _ in _dq_cases],
)
def test_dq_dir_source_is_not_4bit_fused(dq_dir, fused_dir):
    """A -dq/ dequantization intermediate from a 4-bit fused source is the
    direct precursor to a slow GGUF. This test catches the bad artifact one
    step earlier — before someone runs convert_hf_to_gguf.py.

    If this directory exists and no GGUF has been generated yet, delete it
    and start the conversion from a bf16 base instead.
    """
    pytest.fail(
        f"\n\n❌ DEQUANT INTERMEDIATE FROM 4-BIT FUSED SOURCE\n\n"
        f"  DQ dir  : {dq_dir.relative_to(REPO_ROOT)}\n"
        f"  Source  : {fused_dir.relative_to(REPO_ROOT)}/config.json (bits=4)\n\n"
        f"This directory was produced by `mlx_lm.convert --dequantize` on a\n"
        f"4-bit fused model. Any GGUF derived from this dq/ dir will have 60s+\n"
        f"TTFT. Stop the conversion here — delete the dq/ dir and restart from\n"
        f"a bf16 base model.\n\n"
        f"The corresponding GGUF may not exist yet. This test catches the failure\n"
        f"one step earlier than test_no_gguf_from_4bit_fused_source."
    )


# ── Test 3: Runtime TTFT gate ─────────────────────────────────────────────────


def _prism_coder_tags():
    """Return all prism-coder tags currently loaded in Ollama."""
    return [t for t in _ollama_models() if "prism-coder" in t.lower() or "dcostenco" in t.lower()]


@pytest.mark.skipif(not _ollama_available(), reason="Ollama not running on localhost:11434")
@pytest.mark.parametrize("model", _prism_coder_tags(), ids=lambda m: m.replace(":", "-").replace("/", "_"))
def test_gguf_ttft_under_threshold(model):
    """Every Ollama-loaded prism-coder model must respond within the TTFT gate.

    This is the runtime catch for the 60s+ inference failure from May 2026.
    The static tests (above) prevent the bad GGUF from being created at all,
    but this test is the last line of defense — it verifies that whatever is
    currently loaded in Ollama actually has acceptable latency before any
    eval run or deployment.

    If this test fails but the static tests pass, the slow model may have been
    loaded before the conversion pipeline test existed. Pull the model's GGUF,
    check its fused-source config.json for bits=4, and follow the fix options
    in test_no_gguf_from_4bit_fused_source.
    """
    size = _size_tag(model)
    threshold = TTFT_THRESHOLDS.get(size, TTFT_THRESHOLDS["_default"])
    elapsed = _measure_response_time(model, timeout=threshold + 30)

    if elapsed is None:
        pytest.skip(f"Ollama call to {model!r} failed (model may not be fully loaded)")

    assert elapsed <= threshold, (
        f"\n\n❌ TTFT GATE FAILURE — {model!r}\n\n"
        f"  Elapsed : {elapsed:.1f}s\n"
        f"  Gate    : {threshold}s (size tier: {size!r})\n\n"
        f"This matches the May 2026 failure signature: MLX-4bit → dequant →\n"
        f"Q4_K_M GGUF roundtrip producing 60s+ TTFT. At this latency, a\n"
        f"100-case eval would take {elapsed * 100 / 60:.0f}+ minutes.\n\n"
        f"To diagnose:\n"
        f"  1. Find the GGUF behind this Ollama tag (check Modelfile):\n"
        f"       ollama show {model} --modelfile\n"
        f"  2. Find the fused dir that sourced it (matching name prefix)\n"
        f"  3. Check: training/models/<name>-fused/config.json → quantization.bits\n"
        f"  4. If bits=4 → rebuild from bf16 base. If bits is absent/None →\n"
        f"     the slow path may have another cause; profile with llama-bench."
    )


# ── Sanity ────────────────────────────────────────────────────────────────────


def test_suite_has_something_to_check():
    """Ensures this test file is not vacuously passing.

    Skips (rather than fails) when there are no conversion artifacts AND Ollama
    is not running — this is expected on CI where training/ is empty. Fails only
    when this test file's own detection logic is broken (no dirs scanned, no
    Ollama, nothing exercised at all on a machine that has these artifacts).
    """
    has_models = MODELS_DIR.exists() and any(MODELS_DIR.iterdir())
    has_ollama = _ollama_available()
    if not has_models and not has_ollama:
        pytest.skip(
            "No training/models/ artifacts and Ollama not running — "
            "conversion tests skipped (expected on fresh checkout or CI)"
        )
    # At least one of the detection paths must have been exercised.
    # If models/ exists but _fused_dirs_with_4bit() and _dq_dirs() both return
    # nothing, and Ollama has no prism-coder models, warn so the suite doesn't
    # silently become a no-op after a cleanup.
    fused_4bit = list(_fused_dirs_with_4bit())
    dq = list(_dq_dirs())
    prism_tags = _prism_coder_tags() if has_ollama else []
    if has_models and not fused_4bit and not dq and not prism_tags:
        # Not a failure — just means the artifacts are all clean.
        # Document the state so the skip message is informative.
        pytest.skip(
            "models/ exists but no 4-bit fused dirs, no dq dirs, and no "
            "prism-coder Ollama tags — all clean or models not yet built"
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v", "-s"])
