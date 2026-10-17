import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Prism Browser's pipe reader waited on select() for new pipe data while
// readline() had already buffered the commands sent so far: those ran only
// on the producer's next write, and never if the idle timeout came first. A
// producer that pauses between blocks, waiting on a result those commands
// would produce, stalled until the timeout (found by a POS e2e script,
// 2026-10-16). The check also covers CRLF continuations, the stream's own
// decoding, and a continued command left unfinished at the timeout.
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
  it.skipIf(!py)(
    'hands over arrived commands, joins CRLF continuations, decodes as the stream did',
    () => {
      expect(existsSync(script)).toBe(true);
      const result = spawnSync(py as string, ['-I', script], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      expect(result.stdout + result.stderr).toContain('PIPE_READER_OK');
      expect(result.status).toBe(0);
    },
    70_000,
  );
});
