import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';

type GraphNode = { id: string; label: string; group: string; value: number };
type GraphEdge = { from: string; to: string };

const pages: JSDOM[] = [];

afterEach(() => {
  pages.splice(0).forEach(page => page.window.close());
});

describe('dashboard graph node cap', () => {
  it('retains the selected project hub and its edge when keyword nodes exceed the cap', async () => {
    const project: GraphNode = { id: 'synalux-portal', label: 'synalux-portal', group: 'project', value: 1 };
    const category: GraphNode = { id: 'category-1', label: 'category-1', group: 'category', value: 1 };
    const keywords = Array.from({ length: 205 }, (_, index): GraphNode => ({
      id: `keyword-${index}`,
      label: `keyword-${index}`,
      group: 'keyword',
      value: 1,
    }));
    const nodes = [project, category, ...keywords];
    const edges: GraphEdge[] = [
      { from: project.id, to: category.id },
      ...keywords.map(node => ({ from: project.id, to: node.id })),
    ];

    let captured: { nodes: GraphNode[]; edges: GraphEdge[] } | undefined;
    const virtualConsole = new VirtualConsole();
    const page = new JSDOM(renderDashboardHTML('test'), {
      runScripts: 'outside-only',
      virtualConsole,
    });
    pages.push(page);
    page.window.vis = {
      Network: class {
        constructor(_container: unknown, data: { nodes: GraphNode[]; edges: GraphEdge[] }) {
          captured = data;
        }

        on() {}
      },
    } as never;
    page.window.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('/api/graph')) {
        return new Response(JSON.stringify({ nodes, edges }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input).includes('/api/projects')) {
        return new Response(JSON.stringify({ projects: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof page.window.fetch;

    for (const script of page.window.document.querySelectorAll('script:not([src])')) {
      page.window.eval(script.textContent || '');
    }
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(captured).toBeDefined();
    expect(captured?.nodes).toHaveLength(200);
    expect(captured?.nodes.some(node => node.id === project.id)).toBe(true);
    expect(captured?.edges.some(edge => edge.from === project.id && edge.to === category.id)).toBe(true);
  });
});
