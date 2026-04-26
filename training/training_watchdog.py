#!/usr/bin/env python3
"""
Training Watchdog for M5 Max 48GB

Monitors a training process for:
  1. Memory pressure — kills if free memory stays below threshold
  2. Freeze detection — alerts if log file stops updating
  3. Process alive check — detects crashes

Usage:
  python training_watchdog.py --pid <training_pid>
  python training_watchdog.py --pid <training_pid> --log-file ./output/train.log
  python training_watchdog.py --pid <training_pid> --kill-threshold 1.0  # 1GB free = kill

Run alongside training:
  python bfcl_qlora_finetune.py ... &
  TRAIN_PID=$!
  python training_watchdog.py --pid $TRAIN_PID --log-file ./output/train.log
"""
import argparse
import os
import signal
import subprocess
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path


# ============================================================================
# macOS Memory Monitoring
# ============================================================================

def get_memory_stats_gb() -> dict:
    """Get memory stats from macOS vm_stat + sysctl.
    
    Returns dict with total_gb, used_gb, free_gb, swap_used_gb, pressure.
    """
    # Total memory
    try:
        total_bytes = int(subprocess.check_output(
            ["sysctl", "-n", "hw.memsize"], text=True).strip())
        total_gb = total_bytes / (1024 ** 3)
    except Exception:
        total_gb = 48.0  # fallback

    # vm_stat for page counts
    try:
        vm = subprocess.check_output(["vm_stat"], text=True)
        page_size = 16384  # Apple Silicon uses 16K pages
        stats = {}
        for line in vm.strip().split("\n"):
            if ":" in line:
                key, val = line.split(":", 1)
                val = val.strip().rstrip(".")
                try:
                    stats[key.strip()] = int(val)
                except ValueError:
                    pass

        free_pages = stats.get("Pages free", 0)
        inactive_pages = stats.get("Pages inactive", 0)
        speculative_pages = stats.get("Pages speculative", 0)
        # "Available" = free + inactive + speculative (reclaimable)
        available_gb = (free_pages + inactive_pages + speculative_pages) * page_size / (1024 ** 3)
        free_gb = free_pages * page_size / (1024 ** 3)
    except Exception:
        available_gb = 10.0
        free_gb = 5.0

    # Swap usage
    try:
        swap_out = subprocess.check_output(["sysctl", "-n", "vm.swapusage"], text=True)
        # Format: "total = 6144.00M  used = 2048.00M  free = 4096.00M ..."
        for part in swap_out.split():
            if part.endswith("M") and "used" in swap_out[:swap_out.index(part)]:
                swap_used_gb = float(part.rstrip("M")) / 1024
                break
        else:
            swap_used_gb = 0.0
    except Exception:
        swap_used_gb = 0.0

    # Memory pressure (macOS)
    try:
        pressure = subprocess.check_output(
            ["memory_pressure"], text=True, timeout=5)
        if "CRITICAL" in pressure:
            pressure_level = "CRITICAL"
        elif "WARN" in pressure:
            pressure_level = "WARN"
        else:
            pressure_level = "NORMAL"
    except Exception:
        pressure_level = "UNKNOWN"

    return {
        "total_gb": round(total_gb, 1),
        "available_gb": round(available_gb, 1),
        "free_gb": round(free_gb, 1),
        "swap_used_gb": round(swap_used_gb, 1),
        "pressure": pressure_level,
    }


def is_process_alive(pid: int) -> bool:
    """Check if a process is still running."""
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def get_log_mtime(log_path: str) -> float:
    """Get last modification time of log file."""
    try:
        return Path(log_path).stat().st_mtime
    except (FileNotFoundError, OSError):
        return 0.0


def kill_process_tree(pid: int):
    """Kill a process and all its children."""
    try:
        # Kill process group
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except (OSError, ProcessLookupError):
        pass
    time.sleep(2)
    try:
        os.kill(pid, signal.SIGKILL)
    except (OSError, ProcessLookupError):
        pass


# ============================================================================
# Watchdog Loop
# ============================================================================

def run_watchdog(pid: int, log_file: str = None,
                 poll_interval: int = 30,
                 kill_threshold_gb: float = 1.0,
                 kill_sustain_s: int = 60,
                 freeze_timeout_s: int = 300,
                 swap_kill_gb: float = 4.0):
    """Main watchdog loop.
    
    Args:
        pid: Training process PID to monitor.
        log_file: Path to training log file (for freeze detection).
        poll_interval: Seconds between checks.
        kill_threshold_gb: Kill if available memory stays below this for kill_sustain_s.
        kill_sustain_s: Seconds memory must stay critical before kill.
        freeze_timeout_s: Kill if log file hasn't updated in this many seconds.
        swap_kill_gb: Kill if swap usage exceeds this.
    """
    print(f"{'='*60}")
    print(f"  Training Watchdog — M5 Max 48GB")
    print(f"{'='*60}")
    print(f"  Monitoring PID:         {pid}")
    print(f"  Log file:               {log_file or 'None (freeze detection disabled)'}")
    print(f"  Poll interval:          {poll_interval}s")
    print(f"  Kill threshold:         <{kill_threshold_gb} GB available for {kill_sustain_s}s")
    print(f"  Freeze timeout:         {freeze_timeout_s}s")
    print(f"  Swap kill threshold:    {swap_kill_gb} GB")
    print(f"{'='*60}\n")

    critical_since = None
    last_log_mtime = get_log_mtime(log_file) if log_file else None
    last_log_check = time.time()
    peak_mem_used = 0.0
    check_count = 0

    while True:
        check_count += 1
        now = datetime.now()
        
        # 1. Is the process still alive?
        if not is_process_alive(pid):
            print(f"\n[{now:%H:%M:%S}] ✅ Training process {pid} has exited.")
            print(f"  Peak memory usage observed: {peak_mem_used:.1f} GB")
            return 0

        # 2. Memory check
        mem = get_memory_stats_gb()
        used_gb = mem["total_gb"] - mem["available_gb"]
        peak_mem_used = max(peak_mem_used, used_gb)
        
        status = "🟢"
        if mem["available_gb"] < kill_threshold_gb * 2:
            status = "🟡"
        if mem["available_gb"] < kill_threshold_gb:
            status = "🔴"
        if mem["pressure"] == "CRITICAL":
            status = "🔴"

        # Print status every check
        if check_count % 4 == 1 or status != "🟢":
            print(f"[{now:%H:%M:%S}] {status} avail={mem['available_gb']:.1f}GB "
                  f"free={mem['free_gb']:.1f}GB swap={mem['swap_used_gb']:.1f}GB "
                  f"pressure={mem['pressure']} peak={peak_mem_used:.1f}GB")

        # 3. Sustained critical memory check
        if mem["available_gb"] < kill_threshold_gb:
            if critical_since is None:
                critical_since = time.time()
                print(f"  ⚠️  Available memory below {kill_threshold_gb}GB — starting countdown ({kill_sustain_s}s)")
            elif time.time() - critical_since > kill_sustain_s:
                print(f"\n{'!'*60}")
                print(f"  🛑 WATCHDOG KILL: Memory critical for >{kill_sustain_s}s")
                print(f"     Available: {mem['available_gb']:.1f} GB < {kill_threshold_gb} GB threshold")
                print(f"     Swap used: {mem['swap_used_gb']:.1f} GB")
                print(f"     Peak usage: {peak_mem_used:.1f} GB")
                print(f"  Killing PID {pid}...")
                print(f"{'!'*60}\n")
                kill_process_tree(pid)
                return 1
        else:
            if critical_since is not None:
                elapsed = time.time() - critical_since
                print(f"  ✅ Memory recovered after {elapsed:.0f}s critical period")
            critical_since = None

        # 4. Swap threshold check
        if mem["swap_used_gb"] > swap_kill_gb:
            print(f"\n{'!'*60}")
            print(f"  🛑 WATCHDOG KILL: Swap usage {mem['swap_used_gb']:.1f}GB > {swap_kill_gb}GB threshold")
            print(f"     System is thrashing — training will be extremely slow")
            print(f"  Killing PID {pid}...")
            print(f"{'!'*60}\n")
            kill_process_tree(pid)
            return 2

        # 5. Freeze detection (log file staleness)
        if log_file:
            current_mtime = get_log_mtime(log_file)
            if current_mtime > 0:
                if current_mtime != last_log_mtime:
                    last_log_mtime = current_mtime
                    last_log_check = time.time()
                elif time.time() - last_log_check > freeze_timeout_s:
                    print(f"\n{'!'*60}")
                    print(f"  🧊 WATCHDOG ALERT: Log file frozen for >{freeze_timeout_s}s")
                    print(f"     Last update: {datetime.fromtimestamp(last_log_mtime):%H:%M:%S}")
                    print(f"     Process {pid} may be frozen")
                    print(f"  Killing PID {pid}...")
                    print(f"{'!'*60}\n")
                    kill_process_tree(pid)
                    return 3

        time.sleep(poll_interval)


def main():
    parser = argparse.ArgumentParser(
        description="Training Watchdog — monitors memory/freezes during MLX training",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Monitor training process
  python training_watchdog.py --pid 12345

  # With log freeze detection
  python training_watchdog.py --pid 12345 --log-file ./output/train.log

  # Tighter thresholds for 48GB M5 Max
  python training_watchdog.py --pid 12345 --kill-threshold 1.5 --swap-kill 3.0
        """)
    parser.add_argument("--pid", type=int, required=True,
                        help="PID of the training process to monitor")
    parser.add_argument("--log-file", type=str, default=None,
                        help="Path to training log file (for freeze detection)")
    parser.add_argument("--poll-interval", type=int, default=30,
                        help="Seconds between checks (default: 30)")
    parser.add_argument("--kill-threshold", type=float, default=1.0,
                        help="Kill if available memory stays below this (GB, default: 1.0)")
    parser.add_argument("--kill-sustain", type=int, default=60,
                        help="Seconds memory must stay critical before kill (default: 60)")
    parser.add_argument("--freeze-timeout", type=int, default=300,
                        help="Kill if log frozen for this many seconds (default: 300)")
    parser.add_argument("--swap-kill", type=float, default=4.0,
                        help="Kill if swap exceeds this (GB, default: 4.0)")
    args = parser.parse_args()

    if not is_process_alive(args.pid):
        print(f"ERROR: PID {args.pid} is not running")
        sys.exit(1)

    exit_code = run_watchdog(
        pid=args.pid,
        log_file=args.log_file,
        poll_interval=args.poll_interval,
        kill_threshold_gb=args.kill_threshold,
        kill_sustain_s=args.kill_sustain,
        freeze_timeout_s=args.freeze_timeout,
        swap_kill_gb=args.swap_kill,
    )
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
