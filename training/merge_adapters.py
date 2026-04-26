#!/usr/bin/env python3
"""
Model Souping: SLERP Adapter Weight Merging for BFCL
(SoCE - Soup of Category Experts strategy)

Merges two LoRA adapters using Spherical Linear Interpolation (SLERP)
to create a hybrid that performs well across multiple BFCL categories.

SLERP interpolates along the arc of the hypersphere rather than a
straight line, preserving the internal geometry of weight manifolds
and preventing 'brain damage' from naive linear averaging.

Usage:
    python merge_adapters.py --adapter-a adapters/sft --adapter-b adapters/dpo \
        --output adapters/merged --weight-a 0.6 --weight-b 0.4

The merged adapter can then be fused with mlx_lm.fuse as normal.
"""
import argparse
import json
import os
import sys
from pathlib import Path

try:
    import mlx.core as mx
    import mlx.nn as nn
except ImportError:
    print("ERROR: mlx not installed. Run: pip install mlx mlx-lm")
    sys.exit(1)

import numpy as np


def slerp(t: float, v0: mx.array, v1: mx.array, eps: float = 1e-8) -> mx.array:
    """Spherical Linear Interpolation between two weight tensors.
    
    Interpolates along the arc of the hypersphere rather than a straight line.
    This preserves the angular relationships between weight vectors, which is
    critical for maintaining model capabilities during adapter merging.
    
    Args:
        t: Interpolation factor (0.0 = all v0, 1.0 = all v1)
        v0: First weight tensor
        v1: Second weight tensor
        eps: Epsilon for numerical stability
    
    Returns:
        Interpolated weight tensor on the hypersphere arc
    """
    # Flatten for dot product computation
    v0_flat = v0.reshape(-1).astype(mx.float32)
    v1_flat = v1.reshape(-1).astype(mx.float32)
    
    # Normalize
    v0_norm = mx.sqrt(mx.sum(v0_flat * v0_flat) + eps)
    v1_norm = mx.sqrt(mx.sum(v1_flat * v1_flat) + eps)
    v0_unit = v0_flat / v0_norm
    v1_unit = v1_flat / v1_norm
    
    # Compute angle between vectors
    dot = mx.clip(mx.sum(v0_unit * v1_unit), -1.0, 1.0)
    dot_val = dot.item()
    
    # If vectors are nearly parallel, fall back to linear interpolation
    if abs(dot_val) > 1.0 - eps:
        result_flat = (1.0 - t) * v0_flat + t * v1_flat
    else:
        omega = float(np.arccos(abs(dot_val)))
        sin_omega = float(np.sin(omega))
        # Handle anti-parallel case
        if dot_val < 0:
            v1_flat = -v1_flat
        s0 = float(np.sin((1.0 - t) * omega)) / sin_omega
        s1 = float(np.sin(t * omega)) / sin_omega
        result_flat = s0 * v0_flat + s1 * v1_flat
    
    # Scale back to original magnitude (interpolated)
    result_norm = (1.0 - t) * v0_norm + t * v1_norm
    result_unit = result_flat / (mx.sqrt(mx.sum(result_flat * result_flat) + eps))
    result = (result_unit * result_norm).reshape(v0.shape)
    
    return result.astype(v0.dtype)


def merge_adapters(
    adapter_a_path: str,
    adapter_b_path: str,
    output_path: str,
    weight_a: float = 0.6,
    weight_b: float = 0.4,
):
    """Merge two LoRA adapter weight files using SLERP.
    
    This implements Spherical Linear Interpolation for the SoCE strategy.
    SLERP preserves angular relationships in weight space, unlike naive
    linear averaging which can destroy the model's internal geometry.
    
    Both adapters must have identical architecture (same lora_rank, lora_layers).
    
    weight_b controls the interpolation: 0.0 = pure adapter_a, 1.0 = pure adapter_b.
    Default 0.4 meaning 60% SFT / 40% alignment.
    """
    assert abs(weight_a + weight_b - 1.0) < 1e-6, f"Weights must sum to 1.0, got {weight_a + weight_b}"
    
    print(f"Loading Adapter A: {adapter_a_path} (weight={weight_a})")
    print(f"Loading Adapter B: {adapter_b_path} (weight={weight_b})")
    
    # Load adapter weights
    weights_a = mx.load(os.path.join(adapter_a_path, "adapters.safetensors"))
    weights_b = mx.load(os.path.join(adapter_b_path, "adapters.safetensors"))
    
    # Verify keys match
    keys_a = set(weights_a.keys())
    keys_b = set(weights_b.keys())
    
    if keys_a != keys_b:
        missing_in_b = keys_a - keys_b
        missing_in_a = keys_b - keys_a
        if missing_in_b:
            print(f"WARNING: Keys in A but not B: {missing_in_b}")
        if missing_in_a:
            print(f"WARNING: Keys in B but not A: {missing_in_a}")
        # Use intersection
        common_keys = keys_a & keys_b
        print(f"Using {len(common_keys)} common keys for merge")
    else:
        common_keys = keys_a
        print(f"All {len(common_keys)} keys match between adapters")
    
    # SLERP merge (preserves weight manifold geometry)
    merged = {}
    shape_mismatches = []
    slerp_count = 0
    linear_count = 0
    for key in sorted(common_keys):
        if weights_a[key].shape != weights_b[key].shape:
            shape_mismatches.append(f"  {key}: A={weights_a[key].shape} vs B={weights_b[key].shape}")
            continue
        # Use SLERP interpolation with t = weight_b (0.4 = 60% A, 40% B)
        t = weight_b
        if weights_a[key].size > 1:  # SLERP only for non-scalar tensors
            merged[key] = slerp(t, weights_a[key], weights_b[key])
            slerp_count += 1
        else:  # Scalar fallback to linear
            merged[key] = (1.0 - t) * weights_a[key] + t * weights_b[key]
            linear_count += 1
    
    if shape_mismatches:
        print(f"\n🔴 SHAPE MISMATCH — Cannot merge adapters with different LoRA ranks!")
        print(f"   Mismatched keys ({len(shape_mismatches)}):")
        for m in shape_mismatches[:5]:
            print(m)
        print(f"\n   Fix: Ensure both adapters use the same --lora-rank value.")
        print(f"   Or drop merge_adapters.py and use sequential training (SFT → fuse → DPO).")
        sys.exit(1)
    
    # Save merged adapter
    os.makedirs(output_path, exist_ok=True)
    mx.save_safetensors(os.path.join(output_path, "adapters.safetensors"), merged)
    
    # Copy adapter config from adapter A (architecture must match)
    config_path = os.path.join(adapter_a_path, "adapter_config.json")
    if os.path.exists(config_path):
        with open(config_path) as f:
            config = json.load(f)
        config["merge_info"] = {
            "adapter_a": adapter_a_path,
            "adapter_b": adapter_b_path,
            "weight_a": weight_a,
            "weight_b": weight_b,
            "strategy": "SoCE (Soup of Category Experts)",
        }
        out_config = os.path.join(output_path, "adapter_config.json")
        with open(out_config, "w") as f:
            json.dump(config, f, indent=2)
    
    print(f"\n✅ SLERP-Merged adapter saved to: {output_path}")
    print(f"   Strategy: SLERP with t={weight_b:.2f} ({weight_a:.0%} SFT / {weight_b:.0%} Alignment)")
    print(f"   SLERP keys: {slerp_count}, Linear (scalar): {linear_count}")
    print(f"\nNext: fuse with 'python -m mlx_lm.fuse --model <base> --adapter-path {output_path}'")


def main():
    parser = argparse.ArgumentParser(description="Merge two LoRA adapters (Model Souping)")
    parser.add_argument("--adapter-a", required=True, help="Path to first adapter (e.g., SFT)")
    parser.add_argument("--adapter-b", required=True, help="Path to second adapter (e.g., DPO)")
    parser.add_argument("--output", required=True, help="Output path for merged adapter")
    parser.add_argument("--weight-a", type=float, default=0.6, help="Weight for adapter A (default: 0.6)")
    parser.add_argument("--weight-b", type=float, default=0.4, help="Weight for adapter B (default: 0.4)")
    args = parser.parse_args()
    
    merge_adapters(args.adapter_a, args.adapter_b, args.output, args.weight_a, args.weight_b)


if __name__ == "__main__":
    main()
