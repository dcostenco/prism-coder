import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Prism Browser's pipe reader waited on select() for new pipe data while
// readline() had already buffered the commands sent so far: those ran only
// on the producer's next write, or at the idle timeout. A producer that
// pauses between blocks, waiting on a result those commands would produce,
// deadlocked until the timeout (found by a POS e2e script, 2026-10-16).
const script = fileURLToPath(new URL('./pipe-reader-check.py', import.meta.url));

// browse.py needs Python 3.9 (it uses `dict[str, dict]` annotations).
function python(): string | null {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(
      candidate,
      ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'],
      { encoding: 'utf8', timeout: 10_000 },
    );
    if (probe.status === 0) return candidate;
  }
  return null;
}

const py = python();

describe('prism browser pipe reader', () => {
  (py ? it : it.skip)('hands over a command that has already arrived, and joins a CRLF continuation', () => {
    expect(existsSync(script)).toBe(true);
    const result = spawnSync(py as string, ['-I', script], { encoding: 'utf8', timeout: 60_000 });
    expect(result.stdout + result.stderr).toContain('PIPE_READER_OK');
    expect(result.status).toBe(0);
  }, 70_000);
});
