#!/usr/bin/env python3
"""
Prove Prism Browser's pipe reader:

1. hands over a command that has already arrived, before the next write;
2. joins a backslash continuation written with CRLF line endings;
3. decodes as the text stream did: a multi-byte encoding (UTF-16) with a
   character split across reads, and a bare CR ending a line;
4. drops a continued command whose tail never came at the idle timeout,
   rather than running its head alone.

Usage:

    python3 tests/pipe-reader-check.py [path/to/browse.py]

Prints PIPE_READER_OK and exits 0, or prints the failure and exits 1.
"""
import contextlib
import importlib.util
import io
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BROWSE = os.path.join(HERE, "..", "scripts", "dev", "browse.py")


def load(path):
    spec = importlib.util.spec_from_file_location("browse_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The timeout path writes to the real browser audit log; keep it local.
    module.audit_log = lambda *args, **kwargs: None
    return module


def use_pipe_as_stdin(encoding="utf-8"):
    read_fd, write_fd = os.pipe()
    raw = os.fdopen(read_fd, "rb", buffering=0)
    sys.stdin = io.TextIOWrapper(raw, encoding=encoding)
    return write_fd


def check_no_stall(browse):
    write_fd = use_pipe_as_stdin()
    second_out = threading.Event()
    third_written = threading.Event()

    def writer():
        os.write(write_fd, b'eval "one"\neval "two"\n')
        # Wait for the reader to hand over the second command, bounded so a
        # reader that holds it back still lets this check finish and fail.
        second_out.wait(timeout=10)
        third_written.set()
        os.write(write_fd, b'eval "three"\n')
        os.close(write_fd)

    threading.Thread(target=writer, daemon=True).start()
    seen = []
    for line in browse._stdin_lines_with_idle_timeout(timeout_sec=30):
        seen.append((line.rstrip("\n"), third_written.is_set()))
        if line.startswith('eval "two"'):
            second_out.set()
    expected = [
        ('eval "one"', False),
        ('eval "two"', False),
        ('eval "three"', True),
    ]
    if seen != expected:
        return f"a command was held back until the next write: {seen}"
    return None


def check_crlf_continuation(browse):
    write_fd = use_pipe_as_stdin()
    os.write(write_fd, b'eval (() => {\\\r\nreturn "ok"; })()\r\n# note\r\n')
    os.close(write_fd)
    lines = browse._stdin_lines_with_idle_timeout(timeout_sec=10)
    commands = [c.strip() for c in browse._join_continuations(lines)]
    expected = ['eval (() => {\nreturn "ok"; })()', "# note"]
    if commands != expected:
        return f"a CRLF continuation did not join: {commands!r}"
    return None


def check_stream_decoding(browse):
    write_fd = use_pipe_as_stdin(encoding="utf-16-le")
    data = 'eval "é"\reval "two"\n'.encode("utf-16-le")

    def writer():
        # Split inside a character, so the decoder must carry it across reads.
        os.write(write_fd, data[:13])
        time.sleep(0.3)
        os.write(write_fd, data[13:])
        os.close(write_fd)

    threading.Thread(target=writer, daemon=True).start()
    lines = list(browse._stdin_lines_with_idle_timeout(timeout_sec=10))
    expected = ['eval "é"\n', 'eval "two"\n']
    if lines != expected:
        return f"UTF-16 or a bare CR was not read as the stream did: {lines!r}"
    return None


def check_timeout_drops_unfinished_continuation(browse):
    write_fd = use_pipe_as_stdin()
    os.write(write_fd, b'eval "head" \\\n+ 2')

    def close_later():
        time.sleep(3)
        os.close(write_fd)

    threading.Thread(target=close_later, daemon=True).start()
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        commands = list(browse._pipe_commands(timeout_sec=1))
    if commands:
        return f"the head of an unfinished command ran at the timeout: {commands!r}"
    if "No input for 1s" not in printed.getvalue():
        return f"the timeout was not reported: {printed.getvalue()!r}"
    return None


CHECKS = (
    check_no_stall,
    check_crlf_continuation,
    check_stream_decoding,
    check_timeout_drops_unfinished_continuation,
)


def main():
    browse = load(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BROWSE)
    for check in CHECKS:
        try:
            failure = check(browse)
        except Exception as error:
            failure = f"{type(error).__name__}: {error}"
        if failure:
            print(f"PIPE_READER_FAIL {check.__name__}: {failure}")
            return 1
    print("PIPE_READER_OK " + " ".join(c.__name__ for c in CHECKS))
    return 0


if __name__ == "__main__":
    sys.exit(main())
