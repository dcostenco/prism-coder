-- ─── v7.5: Semantic Knowledge ────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.semantic_knowledge (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  user_id TEXT NOT NULL DEFAULT 'default',
  concept TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  confidence REAL DEFAULT 0.5,
  instances INTEGER DEFAULT 1,
  related_entities TEXT DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_semantic_knowledge_project_concept
ON public.semantic_knowledge(project, concept);

CREATE INDEX IF NOT EXISTS idx_semantic_knowledge_user_project
ON public.semantic_knowledge(user_id, project);

ALTER TABLE public.semantic_knowledge ENABLE ROW LEVEL SECURITY;

CREATE POLICY "semantic_knowledge_user_isolation" ON public.semantic_knowledge
  FOR ALL
  USING (true)
  WITH CHECK (true);
