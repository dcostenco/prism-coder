#!/usr/bin/env python3
"""
Prove the pipe reader hands over commands that have already arrived, and
still joins a backslash continuation written with CRLF line endings.

Check 1: two commands are written to the pipe in one write, then the writer
pauses before a third. The reader must yield the second command before the
third is written, not when it arrives or when the idle timeout fires.

Check 2: a two-line command joined by a trailing backslash, with CRLF
endings, must reach the command loop as one command.

Usage:

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


def feed(write_fd, writes):
    """Write each (bytes, pause_after) in turn, then close the pipe."""
    for data, pause in writes:
        os.write(write_fd, data)
        if pause:
            time.sleep(pause)
    os.close(write_fd)


def read_all(browse, read_fd, timeout_sec, join=False):
    sys.stdin = io.TextIOWrapper(os.fdopen(read_fd, "rb", buffering=0), encoding="utf-8")
    lines = browse._stdin_lines_with_idle_timeout(timeout_sec=timeout_sec)
    return list(browse._join_continuations(lines) if join else lines)


def check_no_stall(browse):
    read_fd, write_fd = os.pipe()
    third_written = threading.Event()
    seen = []

    def writer():
        os.write(write_fd, b'eval "one"\neval "two"\n')
        time.sleep(3)
        third_written.set()
        os.write(write_fd, b'eval "three"\n')
        os.close(write_fd)

    threading.Thread(target=writer, daemon=True).start()
    sys.stdin = io.TextIOWrapper(os.fdopen(read_fd, "rb", buffering=0), encoding="utf-8")
    for line in browse._stdin_lines_with_idle_timeout(timeout_sec=10):
        # Causal, not timed: was the third command already written when this
        # one came out? The second must come out before that write.
        seen.append((line.rstrip("\n"), third_written.is_set()))
    expected = [('eval "one"', False), ('eval "two"', False), ('eval "three"', True)]
    if seen != expected:
        return f"the reader held a command back until the next write: {seen}"
    return None


def check_crlf_continuation(browse):
    read_fd, write_fd = os.pipe()
    writes = [(b'eval (() => {\\\r\nreturn "ok"; })()\r\n# comment\r\neval "last"\r\n', 0)]
    threading.Thread(target=feed, args=(write_fd, writes), daemon=True).start()
    commands = [c.strip() for c in read_all(browse, read_fd, 10, join=True)]
    expected = ['eval (() => {\nreturn "ok"; })()', '# comment', 'eval "last"']
    if commands != expected:
        return f"a CRLF backslash continuation did not join: {commands!r}"
    return None


def main():
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), "..", "scripts", "dev", "browse.py")
    browse = load(path)
    for check in (check_no_stall, check_crlf_continuation):
        failure = check(browse)
        if failure:
            print(f"PIPE_READER_FAIL {check.__name__}: {failure}")
            return 1
    print("PIPE_READER_OK no_stall crlf_continuation")
    return 0


if __name__ == "__main__":
    sys.exit(main())
