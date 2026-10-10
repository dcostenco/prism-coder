import { afterEach, describe, expect, it, vi } from 'vitest';
import { VerificationRunner } from '../../src/verification/runner.js';

afterEach(() => vi.unstubAllGlobals());
const run = (target: string) => VerificationRunner.runSuite(JSON.stringify({ tests: [{ id: 'network', layer: 'pipeline', description: 'HTTP verification respects private-network boundaries', severity: 'gate', assertion: { type: 'http_status', target, expected: 200 } }] }));

describe('HTTP verification literal address boundaries', () => {
  it.each(['http://[::1]/', 'http://[fd00::1]/', 'http://[fe80::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:169.254.169.254]/', 'http://[::ffff:10.1.1.1]/', 'http://[::ffff:192.168.0.1]/', 'http://[::ffff:172.16.0.1]/', 'http://[::ffff:100.64.0.1]/'])('blocks %s before making a network request', async target => {
    const fetch = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect((await run(target)).passed).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['https://example.org/', 'http://[2606:4700:4700::1111]/', 'http://[::ffff:8.8.8.8]/'])('preserves public targets and refuses redirects for %s', async target => {
    const fetch = vi.fn(async () => ({ status: 200 }));
    vi.stubGlobal('fetch', fetch);
    expect((await run(target)).passed).toBe(true);
    expect(fetch).toHaveBeenCalledWith(target, { redirect: 'error' });
  });
});
