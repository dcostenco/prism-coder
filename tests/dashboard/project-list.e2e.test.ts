import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';

const servers: Server[] = [];
const pages: JSDOM[] = [];
afterEach(async () => {
  pages.splice(0).forEach(page => page.window.close());
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
});

async function openDashboard(status: number, body: unknown) {
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html');
      res.end(renderDashboardHTML('test'));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.url === '/api/projects' ? status : 200;
      res.end(JSON.stringify(req.url === '/api/projects' ? body : {}));
    }
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture port');
  const url = `http://127.0.0.1:${address.port}/`;
  const page = await JSDOM.fromURL(url, { runScripts: 'outside-only', virtualConsole: new VirtualConsole() });
  pages.push(page);
  // Navigate to the actual rendered page, then run its unchanged inline script
  // against HTTP responses. No production storage or browser credentials enter this test.
  page.window.fetch = (path: string | URL | Request) => fetch(new URL(String(path), url));
  for (const script of page.window.document.querySelectorAll('script:not([src])')) {
    page.window.eval(script.textContent || '');
  }
  return page.window.document;
}

describe('dashboard project-list journey', () => {
  it.each([401, 403, 503])('shows the API failure instead of an empty project list for HTTP %s', async status => {
    const message = 'Dashboard token required — open the authenticated dashboard link.';
    const doc = await openDashboard(status, { error: message });
    await vi.waitFor(() => expect(doc.getElementById('projectLoadError')?.textContent).toBe(message));
    expect(doc.getElementById('projectLoadError')?.style.display).toBe('block');
    expect(doc.getElementById('projectSelect')?.textContent).toContain('Error loading projects');
    expect(doc.getElementById('projectSelect')?.textContent).not.toContain('No projects found');
  });

  it('reserves No projects found for a successful empty response', async () => {
    const doc = await openDashboard(200, { projects: [] });
    await vi.waitFor(() => expect(doc.getElementById('projectSelect')?.textContent).toContain('No projects found'));
    expect(doc.getElementById('projectLoadError')?.style.display ?? 'none').toBe('none');
  });

  it('lists real response projects after navigating to an authorized page', async () => {
    const doc = await openDashboard(200, { projects: ['project-a', 'project-b'] });
    await vi.waitFor(() => expect(doc.querySelectorAll('#projectSelect option')).toHaveLength(3));
    expect(Array.from(doc.querySelectorAll<HTMLOptionElement>('#projectSelect option')).map(option => option.value)).toEqual(['', 'project-a', 'project-b']);
    expect(doc.getElementById('projectLoadError')?.style.display ?? 'none').toBe('none');
  });
});
