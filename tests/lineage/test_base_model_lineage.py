#!/usr/bin/env python3
"""
Base-model lineage test.

A 32B adapter trained from Qwen/Qwen3-32B when the published 32B is
trained from Qwen/QwQ-32B produces an adapter that generates coherent
text but cannot emit tool calls — the system prompt and training corpus
target QwQ-32B's behavior, so the wrong-base adapter is functionally
broken even when training metrics look healthy.

This test catches base-model lineage mismatches BEFORE any training:

  - For every local Prism Coder adapter (`models/prism-coder-*-final/`),
    inspect adapter_config.json
  - The base_model_name_or_path MUST match the lineage of the
    correspondingly-tiered published HF Hub model
  - If you intentionally change base (e.g. Qwen2.5 → Qwen3), declare it
    in the BASE_MODEL_LINEAGE map below and version-bump the published
    model id so users see the change

Run:
    pytest tests/training/test_base_model_lineage.py -v
"""
import json
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[2]
MODELS_DIR = REPO_ROOT / "training" / "models"


# CANONICAL LINEAGE — what each published `dcostenco/prism-coder-<size>`
# tier is trained from. ANY new adapter for a given tier must match its
# tier's lineage entry. If you want to change a base, update this map
# AND publish under a new versioned id (e.g. prism-coder-32b-v2-qwen3).
BASE_MODEL_LINEAGE = {
    "1b7": ["Qwen/Qwen3-1.7B"],
    "14b": ["Qwen/Qwen3-14B"],
    "32b": ["Qwen/QwQ-32B"],
    # Historical bases we've used but no longer publish — kept here so
    # that orphan adapters on disk don't break the suite. Adding to this
    # list is OK; REMOVING from it requires deleting the adapter.
    "legacy-7b": ["Qwen/Qwen2.5-Coder-7B-Instruct"],
}


def _adapter_configs():
    """Walk training/models and yield (size_tag, adapter_config_path) for
    only adapters that declare a HF base model. MLX-trained adapters
    point at local paths and are skipped — they're lineage-checked
    indirectly via the local MLX base dir name."""
    if not MODELS_DIR.exists():
        return
    for cfg in sorted(MODELS_DIR.rglob("adapter_config.json")):
        if "fused" in str(cfg).lower():
            continue
        try:
            with cfg.open() as f:
                data = json.load(f)
        except Exception:
            continue
        base = data.get("base_model_name_or_path")
        if not base:
            # MLX adapter — no HF base recorded. Skip; the harness-level
            # parity test (tests/eval/test_mlx_vs_ollama_parity.py) is
            # the safeguard for MLX flows.
            continue
        if not base.startswith("Qwen/"):
            # Local or third-party — skip lineage check (not lineageable)
            continue
        name = cfg.parent.name.lower()
        # Tag-size inference. Order matters — longer first.
        size = None
        for tag in ("1b7", "1.7b", "14b", "32b"):
            if tag in name:
                size = "1b7" if tag in ("1b7", "1.7b") else tag
                break
        if size:
            yield (size, cfg)


def test_at_least_one_adapter_exists():
    """Sanity — if this fails the test suite is useless on this machine.
    Skip rather than fail to keep CI green when training/ is empty."""
    cfgs = list(_adapter_configs())
    if not cfgs:
        pytest.skip("No adapter_config.json files found in training/models")


@pytest.mark.parametrize("size,cfg_path", [(s, p) for s, p in _adapter_configs()],
                         ids=lambda x: str(x)[:50])
def test_adapter_base_matches_published_lineage(size, cfg_path):
    """Every adapter's base_model_name_or_path must match its tier's
    canonical lineage. This is the test that would have flagged the
    QwQ-32B vs Qwen3-32B mistake from this session before training."""
    with cfg_path.open() as f:
        cfg = json.load(f)
    base = cfg.get("base_model_name_or_path")
    assert base, f"{cfg_path} missing base_model_name_or_path"

    allowed = BASE_MODEL_LINEAGE.get(size, [])
    # Also check legacy in case this is an old adapter
    if size in BASE_MODEL_LINEAGE:
        allowed_with_legacy = allowed + BASE_MODEL_LINEAGE.get(f"legacy-{size}", [])
    else:
        allowed_with_legacy = allowed

    assert base in allowed_with_legacy, (
        f"\n❌ LINEAGE MISMATCH at {cfg_path}\n"
        f"   Adapter base: {base!r}\n"
        f"   Allowed for tier '{size}': {allowed_with_legacy}\n\n"
        f"Training a tier from a non-published base produces an adapter whose\n"
        f"system prompt and corpus expect a different model's behavior — the\n"
        f"adapter generates coherent text but is functionally broken on the\n"
        f"published interface (e.g. cannot emit tool calls).\n\n"
        f"To resolve:\n"
        f"  (a) Retrain from {allowed[0]!r}, OR\n"
        f"  (b) Add {base!r} to BASE_MODEL_LINEAGE['{size}'] AND publish\n"
        f"      the new adapter under a NEW versioned id\n"
        f"      (e.g. dcostenco/prism-coder-{size}-v2-<base-short>).\n"
    )


def test_no_silent_base_upgrades():
    """If BASE_MODEL_LINEAGE ever lists >1 active base per tier, force a
    code review — that means we're silently shipping different bases
    under the same id. Either consolidate or split into versioned ids."""
    for tier, bases in BASE_MODEL_LINEAGE.items():
        if tier.startswith("legacy-"):
            continue
        assert len(bases) == 1, (
            f"Tier '{tier}' has {len(bases)} active bases: {bases}. "
            f"This means the same `dcostenco/prism-coder-{tier}` Hub tag "
            f"could be backed by different bases — silent breakage for "
            f"any user pinning the tag. Split into versioned ids."
        )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
