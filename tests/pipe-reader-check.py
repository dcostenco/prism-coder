#!/usr/bin/env python3
"""
Prove the pipe reader hands over commands that have already arrived.

Two commands are written to the pipe in one write, then the writer pauses.
The reader must yield the second command during the pause, not when the
third arrives or when its idle timeout fires. Usage:

    python3 tests/pipe-reader-check.py [path/to/browse.py]

Prints PIPE_READER_OK and exits 0, or prints the failure and exits 1.
"""
import importlib.util
import io
import os
import sys
import threading
import time


def load(path):
    spec = importlib.util.spec_from_file_location("browse_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "scripts", "dev", "browse.py")
    browse = load(path)
    read_fd, write_fd = os.pipe()
    sys.stdin = io.TextIOWrapper(os.fdopen(read_fd, "rb", buffering=0), encoding="utf-8")

    def writer():
        os.write(write_fd, b'eval "one"\neval "two"\n')
        time.sleep(3)
        os.write(write_fd, b'eval "three"\n')
        os.close(write_fd)

    threading.Thread(target=writer, daemon=True).start()
    started = time.monotonic()
    seen = []
    for line in browse._stdin_lines_with_idle_timeout(timeout_sec=10):
        seen.append((line.rstrip("\n"), round(time.monotonic() - started, 2)))
    lines = [line for line, _ in seen]
    if lines != ['eval "one"', 'eval "two"', 'eval "three"']:
        print(f"PIPE_READER_FAIL lines={seen}")
        return 1
    second_at = seen[1][1]
    if second_at >= 2.5:
        print(f"PIPE_READER_FAIL the second command waited for the third: {seen}")
        return 1
    print(f"PIPE_READER_OK {seen}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
