import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';
import { DASHBOARD_READ_MESSAGES } from '../../src/dashboard/readMessages.js';
import { getGraphMetricsSnapshot } from '../../src/observability/graphMetrics.js';

const pages: JSDOM[] = [];
const SCAN_PROVENANCE = { scope: 'account', backend: 'local', coverage: 'backend_scan' };
afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 10));
  pages.splice(0).forEach(page => page.window.close());
});
function dashboard(readHealth?: () => Promise<Response>, metrics?: unknown | (() => Promise<Response>)) {
  const page = new JSDOM(renderDashboardHTML('review'), {
    runScripts: 'dangerously', virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      window.fetch = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url === '/api/health' && readHealth) return readHealth();
        if (url === '/api/graph/metrics' && metrics) return typeof metrics === 'function' ? metrics() : new Response(JSON.stringify(metrics));
        return new Response(JSON.stringify(url.startsWith('/api/graph') ? { nodes: [], edges: [] }
          : url.startsWith('/api/projects') ? { projects: [] } : {}));
      }) as typeof window.fetch;
    },
  });
  pages.push(page); return page.window.document;
}

describe('unconnected dashboard panels cannot impersonate live products or controls', () => {
  it('preserves all tabs while refusing to certify canned enforcement or audit data', () => {
    const document = dashboard();
    expect(document.getElementById('mtab-compliance')).not.toBeNull();
    const panel = document.getElementById('compliance-content')!;
    expect(panel.textContent).toContain(DASHBOARD_READ_MESSAGES.complianceUnavailable);
    expect(panel.textContent).toContain(DASHBOARD_READ_MESSAGES.auditUnavailable);
    expect(panel.querySelectorAll('.cl-status.active, tbody tr')).toHaveLength(0);
  });

  it('does not invent a VM inventory or imply that zero instances were measured', () => {
    const document = dashboard();
    expect(document.getElementById('mtab-vm')).not.toBeNull();
    expect(document.getElementById('vm-content')?.textContent).toContain(DASHBOARD_READ_MESSAGES.vmUnavailable);
    expect(document.getElementById('vm-content')?.textContent).not.toMatch(/0 running|14 templates/i);
  });

  it('does not advertise static products, prices, or unverified payout terms', () => {
    const document = dashboard();
    expect(document.getElementById('mtab-marketplace')).not.toBeNull();
    const panel = document.getElementById('marketplace-content')!;
    expect(panel.textContent).toContain(DASHBOARD_READ_MESSAGES.marketplaceUnavailable);
    expect(panel.textContent).not.toMatch(/\$\d|70%|@studioflow|@renderlab/);
    (panel.querySelector('button') as HTMLButtonElement).click();
    expect(document.getElementById('fixedToast')?.textContent).toContain(DASHBOARD_READ_MESSAGES.marketplaceActionUnavailable);
    expect(document.getElementById('fixedToast')?.classList.contains('show')).toBe(true);
  });

  it('explains the account-backed embedding path without hiding direct-provider settings', () => {
    const document = dashboard();
    expect(document.getElementById('spanel-providers')?.textContent).toContain(DASHBOARD_READ_MESSAGES.directGeminiKey);
    expect(document.getElementById('select-embedding-provider')).not.toBeNull();
    expect(document.getElementById('spanel-skills')?.textContent).toContain(DASHBOARD_READ_MESSAGES.customRoleInstructions);
  });

  it('discloses partial cloud coverage instead of certifying an overall healthy system', () => {
    const document = dashboard();
    const window = document.defaultView as unknown as { applyHealthReport(data: unknown): void };
    window.applyHealthReport({ ...SCAN_PROVENANCE, backend: 'synalux', status: 'healthy', coverage: 'embedding_inventory',
      totals: { activeEntries: 3, handoffs: 1, rollups: 0 }, issues: [] });
    expect(document.getElementById('healthLabel')?.textContent).toBe(DASHBOARD_READ_MESSAGES.partialScan);
    expect(document.getElementById('healthCoverageNote')?.textContent).toBe(DASHBOARD_READ_MESSAGES.partialCoverage);
    expect(document.getElementById('healthSummary')?.textContent).not.toContain('rollups');
    expect(document.getElementById('cleanupBtn')?.style.display).toBe('none');
    expect(document.getElementById('healthRefreshBtn')).not.toBeNull();
  });

  it('offers destructive cleanup only for the repairs that its handler can actually perform', () => {
    const document = dashboard();
    const window = document.defaultView as unknown as { applyHealthReport(data: unknown): void };
    const totals = { activeEntries: 3, handoffs: 1, rollups: 0 };
    window.applyHealthReport({ ...SCAN_PROVENANCE, status: 'degraded', totals, issues: [{ check: 'duplicates', count: 1, message: 'Duplicate summaries reported' }] });
    expect(document.getElementById('cleanupBtn')?.style.display).toBe('none');
    window.applyHealthReport({ ...SCAN_PROVENANCE, status: 'degraded', totals, issues: [{ check: 'missing_embeddings', count: 1, message: 'Missing embeddings reported' }] });
    expect(document.getElementById('cleanupBtn')?.style.display).toBe('inline-block');
  });

  it('shows unavailable health data instead of a successful empty result after a failed read', async () => {
    const document = dashboard(async () => new Response(JSON.stringify({ error: 'Unavailable' }), { status: 503 }));
    const window = document.defaultView as unknown as { refreshHealthScan(): Promise<void> };
    await window.refreshHealthScan();
    expect(document.getElementById('healthLabel')?.textContent).toBe(DASHBOARD_READ_MESSAGES.scanUnavailable);
    expect(document.getElementById('healthSummary')?.textContent).toBe('—');
    expect(document.getElementById('cleanupBtn')?.style.display).toBe('none');
    expect(document.getElementById('healthCoverageNote')?.textContent).toBe(DASHBOARD_READ_MESSAGES.coverageUnavailable);
  });

  it('rejects unmeasured or unqualified scan totals instead of certifying a healthy empty account', () => {
    const document = dashboard();
    const window = document.defaultView as unknown as { applyHealthReport(data: unknown): void };
    const report = { status: 'healthy', totals: { activeEntries: 0, handoffs: 0, rollups: 0 }, issues: [] };
    for (const provenance of [{}, { ...SCAN_PROVENANCE, coverage: 'unavailable' }, { ...SCAN_PROVENANCE, backend: 'unknown' },
      { ...SCAN_PROVENANCE, backend: 'synalux' }]) {
      window.applyHealthReport({ ...report, ...provenance });
      expect(document.getElementById('healthSummary')?.textContent).toBe('—');
      expect(document.getElementById('healthLabel')?.textContent).toBe(DASHBOARD_READ_MESSAGES.scanUnavailable);
    }
  });

  it('clears an earlier success immediately and ignores older health refresh responses', async () => {
    const responses: Array<(response: Response) => void> = [];
    const document = dashboard(() => new Promise(resolve => responses.push(resolve)));
    const window = document.defaultView as unknown as { applyHealthReport(data: unknown): void; refreshHealthScan(): Promise<void> };
    const report = { ...SCAN_PROVENANCE, status: 'healthy', totals: { activeEntries: 4, handoffs: 1, rollups: 0 }, issues: [] };
    window.applyHealthReport(report);
    const older = window.refreshHealthScan();
    expect(document.getElementById('healthSummary')?.textContent).toBe('—');
    expect(document.getElementById('healthLabel')?.textContent).toBe(DASHBOARD_READ_MESSAGES.scanLoading);
    const newer = window.refreshHealthScan();
    responses[1](new Response(JSON.stringify(report)));
    await newer;
    responses[0](new Response(JSON.stringify({ error: 'Old outage' }), { status: 503 }));
    await older;
    expect(document.getElementById('healthSummary')?.textContent).toContain('4 entries');
  });

  it('does not invent a successful sweep or measured pruning ratio before work has run', async () => {
    const document = dashboard(undefined, getGraphMetricsSnapshot());
    const window = document.defaultView as unknown as { loadGraphMetrics(): Promise<void> };
    await window.loadGraphMetrics();
    const text = document.getElementById('graphMetricsContent')!.textContent!;
    expect(text).toContain(DASHBOARD_READ_MESSAGES.lastDirectLinks + ': —');
    expect(text).toContain(DASHBOARD_READ_MESSAGES.lastPrune + ': —');
    expect(text).not.toContain(DASHBOARD_READ_MESSAGES.schedulerOutcome);
    expect(text).not.toContain('Net links: 0');
  });

  it('keeps scheduler failures separate from direct synthesis results', async () => {
    const snapshot = getGraphMetricsSnapshot();
    const metrics = { ...snapshot,
      scheduler: { ...snapshot.scheduler, last_sweep_at: new Date().toISOString(), projects_succeeded_last: 0, projects_failed_last: 21, projects_processed_last: 21 },
      synthesis: { ...snapshot.synthesis, last_run_at: new Date().toISOString(), last_links_created: 4 },
    };
    const document = dashboard(undefined, metrics);
    const window = document.defaultView as unknown as { loadGraphMetrics(): Promise<void> };
    await window.loadGraphMetrics();
    const text = document.getElementById('graphMetricsContent')!.textContent!;
    expect(text).toContain('0 succeeded · 21 failed · 21 attempted');
    expect(text).toContain(DASHBOARD_READ_MESSAGES.lastDirectLinks + ': 4');
    expect(text).not.toContain('Net links:');
  });

  it('keeps late graph metrics from replacing the latest scheduler outcome', async () => {
    const responses: Array<(response: Response) => void> = [];
    const document = dashboard(undefined, () => new Promise<Response>(resolve => responses.push(resolve)));
    const window = document.defaultView as unknown as { loadGraphMetrics(): Promise<void> };
    const older = window.loadGraphMetrics();
    const newer = window.loadGraphMetrics();
    const snapshot = getGraphMetricsSnapshot();
    const metrics = { ...snapshot, scheduler: { ...snapshot.scheduler, last_sweep_at: new Date().toISOString(), projects_failed_last: 21 } };
    responses[responses.length - 1](new Response(JSON.stringify(metrics)));
    await newer;
    responses[responses.length - 2](new Response(JSON.stringify({ error: 'Old outage' }), { status: 503 }));
    await older;
    expect(document.getElementById('graphMetricsContent')?.textContent).toContain('21 failed');
  });
});
