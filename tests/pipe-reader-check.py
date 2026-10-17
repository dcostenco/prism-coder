#!/usr/bin/env python3
"""
Prove Prism Browser's pipe reader:

1. hands over a command that has already arrived, before the next write;
2. joins a backslash continuation written with CRLF line endings;
3. decodes as the text stream did, with every read boundary forced: a
   multi-byte encoding (UTF-16) split inside characters, CRLF split between
   two reads, a bare CR, a trailing CR and an unterminated tail at EOF, and
   a strict decoding error raised as before;
4. keeps a partial line whole when select() fails partway and the reader
   falls back to blocking reads;
5. drops a continued command whose tail never came at the idle timeout,
   rather than running its head alone (where select() can watch a pipe).

Usage:

    python3 tests/pipe-reader-check.py [path/to/browse.py]

Prints PIPE_READER_OK and exits 0, or prints the failure and exits 1.
"""
import contextlib
import importlib.util
import io
import os
import select
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
DEFAULT_BROWSE = os.path.join(HERE, "..", "scripts", "dev", "browse.py")


def load(path):
    spec = importlib.util.spec_from_file_location("browse_under_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # The timeout path writes to the real browser audit log; keep it local.
    module.audit_log = lambda *args, **kwargs: None
    return module


class _Proxy:
    """A module stand-in: overrides one function, passes the rest through."""

    def __init__(self, real, **overrides):
        self._real = real
        self.__dict__.update(overrides)

    def __getattr__(self, name):
        return getattr(self._real, name)


@contextlib.contextmanager
def reads_of_at_most(browse, size):
    """Make every os.read in the reader return at most `size` bytes."""
    real = browse.os
    browse.os = _Proxy(real, read=lambda fd, n: real.read(fd, min(n, size)))
    try:
        yield
    finally:
        browse.os = real


@contextlib.contextmanager
def select_fails_after(browse, calls):
    """Let select() answer `calls` times, then raise as a Windows pipe does."""
    real = browse.select
    count = {"n": 0}

    def flaky(*args):
        count["n"] += 1
        if count["n"] > calls:
            raise OSError("select() cannot watch this descriptor")
        return real.select(*args)

    browse.select = _Proxy(real, select=flaky)
    try:
        yield
    finally:
        browse.select = real


def pipe_can_be_selected():
    read_fd, write_fd = os.pipe()
    try:
        select.select([read_fd], [], [], 0)
        return True
    except (OSError, ValueError):
        return False
    finally:
        os.close(read_fd)
        os.close(write_fd)


def use_pipe_as_stdin(encoding="utf-8"):
    read_fd, write_fd = os.pipe()
    raw = os.fdopen(read_fd, "rb", buffering=0)
    sys.stdin = io.TextIOWrapper(raw, encoding=encoding)
    return write_fd


def read_lines(browse, data, encoding="utf-8", read_size=None):
    """Write `data`, close the pipe, and read every line back."""
    write_fd = use_pipe_as_stdin(encoding)
    os.write(write_fd, data)
    os.close(write_fd)
    lines = browse._stdin_lines_with_idle_timeout(timeout_sec=10)
    if read_size is None:
        return list(lines)
    with reads_of_at_most(browse, read_size):
        return list(lines)


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
    data = b'eval (() => {\\\r\nreturn "ok"; })()\r\n# note\r\n'
    lines = read_lines(browse, data)
    commands = [c.strip() for c in browse._join_continuations(lines)]
    expected = ['eval (() => {\nreturn "ok"; })()', "# note"]
    if commands != expected:
        return f"a CRLF continuation did not join: {commands!r}"
    return None


def check_stream_decoding(browse):
    # UTF-16 read 3 bytes at a time: every other character is split across
    # two reads, and so is the bare CR that ends the first line.
    utf16 = 'eval "é"\reval "two"\n'.encode("utf-16-le")
    lines = read_lines(browse, utf16, encoding="utf-16-le", read_size=3)
    if lines != ['eval "é"\n', 'eval "two"\n']:
        return f"UTF-16 split across reads, or a bare CR, misread: {lines!r}"
    # One byte at a time: CRLF arrives as CR, then LF in the next read, and
    # must end one line, not two.
    lines = read_lines(browse, b"a\r\nb\rc\n", read_size=1)
    if lines != ["a\n", "b\n", "c\n"]:
        return f"CRLF split between reads ended two lines: {lines!r}"
    lines = read_lines(browse, b"x\r", read_size=1)
    if lines != ["x\n"]:
        return f"a trailing CR at EOF was not a line end: {lines!r}"
    lines = read_lines(browse, b"tail")
    if lines != ["tail"]:
        return f"an unterminated tail at EOF was lost: {lines!r}"
    try:
        lines = read_lines(browse, b"bad \xff\n")
    except UnicodeDecodeError:
        return None
    return f"a strict decoding error was swallowed: {lines!r}"


def check_fallback_keeps_partial_line(browse):
    prefix, rest = b'eval "par', b'tial"\n'
    write_fd = use_pipe_as_stdin()
    os.write(write_fd, prefix + rest)
    os.close(write_fd)
    # The first read stops inside the line; select() answers that once, then
    # fails as on Windows, so the fallback takes over holding a partial line.
    real = browse.os
    reads = {"n": 0}

    def first_read_partial(fd, n):
        reads["n"] += 1
        return real.read(fd, min(n, len(prefix)) if reads["n"] == 1 else n)

    browse.os = _Proxy(real, read=first_read_partial)
    try:
        with select_fails_after(browse, 1):
            lines = list(browse._stdin_lines_with_idle_timeout(timeout_sec=10))
    finally:
        browse.os = real
    if lines != ['eval "partial"\n']:
        return f"the fallback split a partial line: {lines!r}"
    return None


def check_timeout_drops_unfinished_continuation(browse):
    if not pipe_can_be_selected():
        # The reader reads blocking here: there is no timeout to test.
        return "skip"
    write_fd = use_pipe_as_stdin()
    os.write(write_fd, b'eval "head" \\\n+ 2')
    closer = threading.Timer(3, lambda: os.close(write_fd))
    closer.start()
    printed = io.StringIO()
    with contextlib.redirect_stdout(printed):
        commands = list(browse._pipe_commands(timeout_sec=1))
    closer.join()
    if commands:
        return f"the head of an unfinished command ran at the timeout: {commands!r}"
    if "No input for 1s" not in printed.getvalue():
        return f"the timeout was not reported: {printed.getvalue()!r}"
    return None


CHECKS = (
    check_no_stall,
    check_crlf_continuation,
    check_stream_decoding,
    check_fallback_keeps_partial_line,
    check_timeout_drops_unfinished_continuation,
)


def main():
    browse = load(sys.argv[1] if len(sys.argv) > 1 else DEFAULT_BROWSE)
    ran = []
    for check in CHECKS:
        try:
            failure = check(browse)
        except Exception as error:
            failure = f"{type(error).__name__}: {error}"
        if failure == "skip":
            ran.append(f"{check.__name__}(skipped)")
            continue
        if failure:
            print(f"PIPE_READER_FAIL {check.__name__}: {failure}")
            return 1
        ran.append(check.__name__)
    print("PIPE_READER_OK " + " ".join(ran))
    return 0


if __name__ == "__main__":
    sys.exit(main())
