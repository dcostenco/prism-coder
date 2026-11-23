import { afterEach, describe, expect, it, vi } from 'vitest';
import { JSDOM, VirtualConsole } from 'jsdom';
import { renderDashboardHTML } from '../../src/dashboard/ui.js';

type GraphNode = { id: string; label: string; group: string; value: number };
type GraphEdge = { from: string; to: string };

const pages: JSDOM[] = [];

afterEach(() => {
  pages.splice(0).forEach(page => page.window.close());
});

describe('dashboard graph node cap', () => {
  it('opens the read-only quiz for a hosted memory and explains the older Portal projection', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let clickGraph: ((params: { nodes: string[] }) => void) | undefined;
    const requests: string[] = [];
    const page = new JSDOM(renderDashboardHTML('test'), {
      runScripts: 'dangerously',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.vis = { Network: class {
          on(name: string, callback: typeof clickGraph) { if (name === 'click') clickGraph = callback; }
          setData() {}
          destroy() {}
        } } as never;
        window.fetch = (async (input: string | URL | Request) => {
          const path = String(input);
          if (path.startsWith('/api/graph/test-me?')) {
            requests.push(path);
            return new Response(JSON.stringify({ reason: 'portal_projection_unavailable', questions: [] }));
          }
          if (path === '/api/graph' || path.startsWith('/api/graph?')) {
            return new Response(JSON.stringify({
              graphType: 'memory', nodes: [{ id, label: 'Selected cloud memory', group: 'memory' }], edges: [],
            }));
          }
          return new Response('{}');
        }) as typeof window.fetch;
      },
    });
    pages.push(page);
    await vi.waitFor(() => expect(clickGraph).toBeDefined());
    const doc = page.window.document;
    const graphProject = doc.getElementById('graphProjectFilter') as HTMLSelectElement;
    graphProject.add(new page.window.Option('Example', 'example-project'));
    graphProject.value = 'example-project';
    await (page.window as typeof page.window & { loadGraph(): Promise<void> }).loadGraph();
    clickGraph!({ nodes: [id] });
    expect(doc.getElementById('nodeEditorPanel')?.style.display).toBe('block');
    expect(doc.getElementById('nodeEditControls')?.hidden).toBe(true);
    doc.getElementById('testMeBtn')!.click();

    await vi.waitFor(() => expect(doc.getElementById('testMeContainer')?.textContent).toMatch(/Synalux Portal.*updated/i));
    expect(requests).toHaveLength(1);
    expect(new URL(requests[0], 'http://localhost').searchParams.get('group')).toBe('memory');
    expect(new URL(requests[0], 'http://localhost').searchParams.get('id')).toBe(id);
  });

  it('ignores a quiz from the previous graph project even when the new graph displays the same node ID', async () => {
    const id = '11111111-1111-4111-8111-111111111111';
    let selectNode: ((params: { nodes: string[] }) => void) | undefined;
    let resolveOldQuiz!: (response: Response) => void;
    const oldQuiz = new Promise<Response>(resolve => { resolveOldQuiz = resolve; });
    const quizProjects: string[] = [];
    const page = new JSDOM(renderDashboardHTML('test'), {
      runScripts: 'dangerously',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.vis = { Network: class {
          on(name: string, cb: typeof selectNode) { if (name === 'click') selectNode = cb; }
          setData() {}
          destroy() {}
        } } as never;
        window.fetch = (async (input: string | URL | Request) => {
          const url = new URL(String(input), 'http://localhost');
          if (url.pathname === '/api/graph/test-me') {
            const project = url.searchParams.get('project')!;
            quizProjects.push(project);
            return project === 'first-project'
              ? oldQuiz
              : Response.json({ questions: [{ q: 'Current project quiz', a: 'Current answer' }] });
          }
          if (url.pathname === '/api/graph') {
            return Response.json({ graphType: 'memory', nodes: [{ id, label: 'Selected memory', group: 'memory' }], edges: [] });
          }
          return Response.json({});
        }) as typeof window.fetch;
      },
    });
    pages.push(page);
    const window = page.window as typeof page.window & { loadGraph(): Promise<void>; triggerTestMe(): Promise<void> };
    await vi.waitFor(() => expect(selectNode).toBeDefined());
    const doc = window.document;
    const filter = doc.getElementById('graphProjectFilter') as HTMLSelectElement;
    const container = doc.getElementById('testMeContainer');
    for (const project of ['first-project', 'second-project']) filter.add(new window.Option(project, project));
    filter.value = 'first-project';
    await window.loadGraph();
    selectNode!({ nodes: [id] });
    const pending = window.triggerTestMe();
    expect(quizProjects).toEqual(['first-project']);

    filter.value = 'second-project';
    await window.loadGraph();
    expect(doc.getElementById('nodeEditorPanel')?.style.display).toBe('none');
    await window.triggerTestMe();
    expect(quizProjects).toEqual(['first-project']);
    selectNode!({ nodes: [id] });
    await window.triggerTestMe();
    expect(quizProjects).toEqual(['first-project', 'second-project']);
    expect(container?.textContent).toContain('Current project quiz');

    resolveOldQuiz(Response.json({ questions: [{ q: 'Previous project quiz', a: 'Old answer' }] }));
    await pending;
    expect(container?.textContent).toContain('Current project quiz');
    expect(container?.textContent).not.toContain('Previous project quiz');
  });

  it('binds quizzes to an explicit graph project instead of the separate header project', async () => {
    const topic = 'debugging';
    const quizProjects: string[] = [];
    let selectNode: ((params: { nodes: string[] }) => void) | undefined;
    const page = new JSDOM(renderDashboardHTML('test'), {
      runScripts: 'dangerously',
      virtualConsole: new VirtualConsole(),
      beforeParse(window) {
        window.vis = { Network: class {
          on(name: string, callback: typeof selectNode) { if (name === 'click') selectNode = callback; }
          setData() {}
          destroy() {}
        } } as never;
        window.fetch = (async (input: string | URL | Request) => {
          const url = new URL(String(input), 'http://localhost');
          if (url.pathname === '/api/graph/test-me') {
            quizProjects.push(url.searchParams.get('project')!);
            return Response.json({ questions: [{ q: 'Scoped question', a: 'Scoped answer' }] });
          }
          if (url.pathname === '/api/graph') {
            return Response.json({ nodes: [{ id: topic, label: 'Debugging', group: 'keyword' }], edges: [] });
          }
          return Response.json({});
        }) as typeof window.fetch;
      },
    });
    pages.push(page);
    const window = page.window as typeof page.window & { loadGraph(): Promise<void>; triggerTestMe(): Promise<void> };
    await vi.waitFor(() => expect(selectNode).toBeDefined());
    const doc = window.document;
    const header = doc.getElementById('projectSelect') as HTMLSelectElement;
    const filter = doc.getElementById('graphProjectFilter') as HTMLSelectElement;
    const quiz = doc.getElementById('testMeBtn') as HTMLButtonElement;
    const content = doc.getElementById('testMeContainer');
    header.add(new window.Option('Other project', 'other-project'));
    header.value = 'other-project';
    selectNode!({ nodes: [topic] });

    await window.triggerTestMe();
    expect(quizProjects).toEqual([]);
    expect(quiz.disabled).toBe(true);
    expect(content?.textContent).toMatch(/choose a project in the graph filter/i);

    filter.add(new window.Option('Graph project', 'graph-project'));
    filter.value = 'graph-project';
    await window.loadGraph();
    selectNode!({ nodes: [topic] });
    expect(quiz.disabled).toBe(false);
    await window.triggerTestMe();
    expect(quizProjects).toEqual(['graph-project']);
    expect(content?.textContent).toContain('Scoped question');
  });

  it('labels a cloud memory graph as sessions and stored links', async () => {
    const nodes = [
      { id: 'a', label: 'First session', group: 'memory', value: 1 },
      { id: 'b', label: 'Second session', group: 'memory', value: 1 },
    ];
    const edges = [{ from: 'a', to: 'b', label: 'synthesized_from' }];
    const page = new JSDOM(renderDashboardHTML('test'), { runScripts: 'outside-only' });
    pages.push(page);
    page.window.vis = { Network: class { on() {} } } as never;
    page.window.fetch = (async (input: string | URL | Request) => {
      if (String(input).includes('/api/graph')) {
        return new Response(JSON.stringify({ graphType: 'memory', entryCount: 2, nodes, edges }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (String(input).includes('/api/projects')) {
        return new Response(JSON.stringify({ projects: [] }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { headers: { 'content-type': 'application/json' } });
    }) as typeof page.window.fetch;

    for (const script of page.window.document.querySelectorAll('script:not([src])')) {
      page.window.eval(script.textContent || '');
    }
    await new Promise(resolve => setTimeout(resolve, 25));

    expect(page.window.document.querySelector('.graph-stats')?.textContent).toBe('2 sessions · 1 stored links');
  });

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
