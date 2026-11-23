import { describe, expect, it, vi } from "vitest";
import { handleGraphRoutes } from "../../src/dashboard/graphRouter.js";
import { SynaluxStorage } from "../../src/storage/synalux.js";

const quizProvider = vi.hoisted(() => ({
  generateText: vi.fn(async () => JSON.stringify([
    { q: "What changed?", a: "A scoped fix." },
    { q: "Why?", a: "To preserve the boundary." },
    { q: "How is it checked?", a: "An authenticated projection." },
  ])),
}));
vi.mock("../../src/utils/llm/factory.js", async original => ({
  ...await original<typeof import("../../src/utils/llm/factory.js")>(),
  getLLMProvider: () => quizProvider,
}));

function responseRecorder() {
  let statusCode = 0;
  let body = "";
  return {
    response: {
      writeHead(code: number) { statusCode = code; },
      end(value?: string) { body = value ?? ""; },
    } as any,
    read: () => ({ statusCode, body }),
  };
}

describe("cloud dashboard graph reads", () => {
  it("renders the selected cloud project as its real session graph", async () => {
    const getDashboardMemoryGraph = vi.fn().mockResolvedValue({
      nodes: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          project: "example-project",
          summary: "Investigated the graph path",
          keywords: [],
          created_at: "2026-09-18T00:00:00.000Z",
          importance: 1,
          last_accessed_at: null,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          project: "example-project",
          summary: "Fixed Portal-mediated embeddings",
          keywords: [],
          created_at: "2026-09-19T00:00:00.000Z",
          importance: 2,
          last_accessed_at: "2026-09-19T01:00:00.000Z",
        },
      ],
      edges: [{
        source_id: "11111111-1111-4111-8111-111111111111",
        target_id: "22222222-2222-4222-8222-222222222222",
        link_type: "synthesized_from",
        strength: 0.88,
      }],
      truncated: false,
    });
    const getDashboardGraphEntries = vi.fn(() => { throw new Error("keyword projection must not replace the memory graph"); });
    const recorder = responseRecorder();

    await handleGraphRoutes(
      new URL("http://localhost:3000/api/graph?project=example-project&days=30"),
      { method: "GET" } as any,
      recorder.response,
      async () => ({ getDashboardMemoryGraph, getDashboardGraphEntries }) as any,
    );

    expect(recorder.read().statusCode).toBe(200);
    expect(getDashboardMemoryGraph).toHaveBeenCalledWith(expect.objectContaining({
      project: "example-project",
      createdAfter: expect.any(String),
      limit: 200,
    }));
    expect(getDashboardGraphEntries).not.toHaveBeenCalled();
    expect(JSON.parse(recorder.read().body)).toMatchObject({
      graphType: "memory",
      entryCount: 2,
      truncated: false,
      nodes: [
        expect.objectContaining({ id: "11111111-1111-4111-8111-111111111111", group: "memory", label: "Investigated the graph path" }),
        expect.objectContaining({ id: "22222222-2222-4222-8222-222222222222", group: "memory", label: "Fixed Portal-mediated embeddings" }),
      ],
      edges: [expect.objectContaining({
        from: "11111111-1111-4111-8111-111111111111",
        to: "22222222-2222-4222-8222-222222222222",
        label: "synthesized_from",
      })],
    });
  });

  it("preserves direct graph reads when the optional cloud method is absent", async () => {
    const getLedgerEntries = vi.fn().mockResolvedValue([
      { project: "example-project", keywords: ["debugging"], created_at: "2026-09-18T00:00:00.000Z" },
    ]);
    const recorder = responseRecorder();

    await handleGraphRoutes(
      new URL("http://localhost:3000/api/graph"),
      { method: "GET" } as any,
      recorder.response,
      async () => ({ getLedgerEntries }) as any,
    );

    expect(recorder.read().statusCode).toBe(200);
    expect(getLedgerEntries).toHaveBeenCalledWith({
      order: "created_at.desc",
      select: "project,keywords,created_at,importance,last_accessed_at",
      limit: "30",
    });
    expect(JSON.parse(recorder.read().body).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example-project", group: "project" }),
    ]));
  });

  it("uses the portal graph projection for the all-project view", async () => {
    const getDashboardGraphEntries = vi.fn().mockResolvedValue([
      {
        project: "example-project",
        keywords: ["debugging"],
        created_at: "2026-09-18T00:00:00.000Z",
        importance: 1,
        last_accessed_at: null,
      },
    ]);
    const getLedgerEntries = vi.fn(() => { throw new Error("direct Supabase must not be used"); });
    const storage = { getDashboardGraphEntries, getLedgerEntries };
    const recorder = responseRecorder();

    const handled = await handleGraphRoutes(
      new URL("http://localhost:3000/api/graph"),
      { method: "GET" } as any,
      recorder.response,
      async () => storage as any,
    );

    expect(handled).toBe(true);
    expect(recorder.read().statusCode).toBe(200);
    expect(JSON.parse(recorder.read().body).nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "example-project", group: "project" }),
    ]));
    expect(getDashboardGraphEntries).toHaveBeenCalledWith({ limit: 30 });
    expect(getLedgerEntries).not.toHaveBeenCalled();
  });

  it("passes project, date, importance, and limit filters to the portal projection", async () => {
    const getDashboardGraphEntries = vi.fn().mockResolvedValue([]);
    const storage = { getDashboardGraphEntries, getLedgerEntries: vi.fn() };
    const recorder = responseRecorder();

    await handleGraphRoutes(
      new URL("http://localhost:3000/api/graph?project=example-project&days=7&min_importance=1"),
      { method: "GET" } as any,
      recorder.response,
      async () => storage as any,
    );

    expect(recorder.read().statusCode).toBe(200);
    expect(getDashboardGraphEntries).toHaveBeenCalledWith(expect.objectContaining({
      project: "example-project",
      minImportance: 1,
      limit: 200,
      createdAfter: expect.any(String),
    }));
    expect(storage.getLedgerEntries).not.toHaveBeenCalled();
  });

  it.each(["keyword", "category"])("uses scoped search for a symbolic keyword selection (%s)", async group => {
    const id = group === "category" ? "cat:debugging" : "debugging";
    const getLinkedLedgerSummaries = vi.fn(async () => { throw new Error("A symbolic node is not a ledger ID"); });
    const searchKnowledge = vi.fn(async () => ({ results: [{ id: "scoped", summary: "Project evidence" }] }));
    const recorder = responseRecorder();
    await handleGraphRoutes(new URL("http://localhost/api/graph/test-me?"
      + new URLSearchParams({ id, project: "example-project", group })), { method: "GET" } as any,
      recorder.response, async () => ({ getLinkedLedgerSummaries, searchKnowledge }) as any);

    expect(getLinkedLedgerSummaries).not.toHaveBeenCalled();
    expect(searchKnowledge).toHaveBeenCalledWith(expect.objectContaining({ project: "example-project", keywords: [id] }));
    expect(JSON.parse(recorder.read().body).questions).toHaveLength(3);
  });

  it("reports the missing older Portal projection through the Test Me endpoint", async () => {
    const storage = Object.create(SynaluxStorage.prototype) as SynaluxStorage;
    const portalRead = vi.spyOn(storage as any, "portalGet").mockResolvedValue({ links: [] });
    const recorder = responseRecorder();
    const countBefore = quizProvider.generateText.mock.calls.length;

    await handleGraphRoutes(new URL("http://localhost/api/graph/test-me?id=11111111-1111-4111-8111-111111111111&project=example-project&group=memory"),
      { method: "GET" } as any, recorder.response, async () => storage);

    expect(portalRead).toHaveBeenCalledWith(expect.stringContaining("include_target_summaries=true"));
    expect(JSON.parse(recorder.read().body)).toEqual({ questions: [], reason: "portal_projection_unavailable" });
    expect(quizProvider.generateText).toHaveBeenCalledTimes(countBefore);
  });

  it("generates Test Me questions for the selected memory using only its linked context", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const storage = {
      getLinkedLedgerSummaries: vi.fn(async () => [{ id: "linked-memory", summary: "A verified linked fact" }]),
      searchKnowledge: vi.fn(),
    };
    const recorder = responseRecorder();
    await handleGraphRoutes(new URL("http://localhost/api/graph/test-me?"
      + new URLSearchParams({ id, project: "example-project", group: "memory" })), { method: "GET" } as any,
      recorder.response, async () => storage as any);

    expect(storage.getLinkedLedgerSummaries).toHaveBeenCalledWith(id, 5);
    expect(storage.searchKnowledge).not.toHaveBeenCalled();
    const prompt = quizProvider.generateText.mock.calls.at(-1)?.[0] as unknown as string;
    expect(prompt).toContain("A verified linked fact");
    expect(prompt).not.toContain(id);
    expect(JSON.parse(recorder.read().body).questions).toHaveLength(3);
  });
});
