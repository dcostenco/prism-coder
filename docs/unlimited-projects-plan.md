# Prism Cloud Pro + Unlimited Projects — Combined Plan

## Synalux Tiers

| Tier | Price | All features inherited from Synalux pricing page |
|---|---|---|
| 🆓 **Free** | $0 | 5 tools, 100 API/day, community support |
| ⚡ **Standard** | $19/mo | All 17 tools, voice, OCR, templates |
| 🚀 **Advanced** | $49/mo | + RBAC, integrations, AI, team chat, e-sign |
| 🏢 **Enterprise** | $99/seat | All Synalux features, HIPAA, SSO, on-prem |

> All module/integration/interface details are defined in Synalux `pricing/page.tsx`. Each tier inherits everything from the tier below it.

---

## Team & Project Limits by Tier

| | Free | Standard | Advanced | Enterprise |
|---|---|---|---|---|
| Max Teams | 1 | 3 | 10 | Unlimited |
| Max Projects per Team | 1 | 3 | Unlimited | Unlimited |
| Members per Team | 1 (self) | 5 | 25 | Unlimited |
| Members per Project | 1 (self) | 3 | 10 | Unlimited |
| Role Assignment | ❌ | ✅ | ✅ | ✅ |
| Cloud Memory Sync | ❌ | ✅ | ✅ | ✅ |
| Hivemind / Dark Factory | ❌ | ✅ | ✅ | ✅ |

> GDocs, Voice/Video, QA Reports, and all other features follow the Synalux tier the user belongs to.

### Role Hierarchy
| Role | Scope | Can Create Teams | Can Create Projects | Can Delete/Archive | Other |
|---|---|---|---|---|---|
| **Admin** (Platform) | Global | ✅ | ✅ | Teams + Projects | Full platform access, manages `synalux.ai/team/admin` |
| **Team Admin** | Team | ❌ | ✅ | Projects in their team | Manages team members, configures team dashboard |
| **Editor** | Project | ❌ | ❌ | ❌ | Edit content, update status, use tier-allowed features |
| **Viewer** | Project | ❌ | ❌ | ❌ | Read-only |

### Enterprise Admin Inheritance Rule
> **Projects deployed by an Enterprise Admin inherit ALL Synalux features — every module, interface, table, integration, and permission from `platform_modules` (21 modules), `platform_permissions` (14 permissions), and all 49 migration schemas.**

| Deployer Tier | Project Feature Ceiling |
|---|---|
| Free Admin | Free-tier features only |
| Standard Admin | Standard-tier features |
| Advanced Admin | Advanced-tier features |
| **Enterprise Admin** | **Full Synalux platform** |

---

## Phase 1 — Synalux: License Table + Verify Endpoint

#### [NEW] `supabase/migrations/xxx_prism_licenses.sql`
```sql
CREATE TABLE prism_licenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id),
  license_key TEXT UNIQUE NOT NULL DEFAULT encode(gen_random_bytes(32), 'hex'),
  tier TEXT NOT NULL DEFAULT 'free' CHECK (tier IN ('free','standard','advanced','enterprise')),
  active BOOLEAN DEFAULT true,
  daily_llm_calls INT DEFAULT 0,
  daily_search_calls INT DEFAULT 0,
  last_reset_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE prism_licenses ENABLE ROW LEVEL SECURITY;
CREATE POLICY "license_readonly" ON prism_licenses FOR SELECT USING (true);
```

#### [NEW] `portal/src/app/api/v1/prism/verify/route.ts`
- Accepts `{ license_key }` → returns `{ tier, features, limits }` or 401

#### [NEW] `portal/src/app/api/v1/prism/llm/route.ts`
- Accepts `{ license_key, messages }` → validates key + rate limit → proxies to Gemini
- Standard: Gemini 2.5 Flash | Advanced/Enterprise: Gemini 3.1 Pro

#### [NEW] `portal/src/app/api/v1/prism/search/route.ts`
- Validates tier + daily limit → proxies to Firecrawl/Tavily

#### [NEW] `portal/src/app/api/v1/prism/memory/route.ts`
- Reads/writes to Synalux Supabase using managed user schema
- Free tier → 401

---

## Phase 2 — Prism: License Check + Cloud Client

#### [MODIFY] `src/server.ts`
- Startup: read `PRISM_LICENSE_KEY` → call `/verify` → cache tier in SQLite

#### [MODIFY] `src/prism-cloud.ts`
- Extend `PrismCloudLimits` with `max_projects`, `max_members_per_project`
- Add cloud proxy functions: `cloudLLM()`, `cloudSearch()`, `cloudMemoryRead/Write()`

#### [MODIFY] Tool registrations in `src/server.ts`
- Gate cloud tools behind `tier !== 'free'`
- Graceful upgrade message for free users

---

## Phase 3 — Prism: Dashboard UI Upgrades

#### [NEW] `src/dashboard/components/SubscriptionTiers.tsx`
- Side-by-side comparison of Free / Standard ($19) / Advanced ($49) / Enterprise ($99)

#### [NEW] `src/dashboard/components/StripeCheckout.tsx`
- Checkout buttons → Synalux Stripe sessions → webhook updates `prism_licenses.tier`

#### [NEW] `src/dashboard/components/UsageQuotas.tsx`
- Progress bars for daily LLM/Search calls, fetched from `/verify`

#### [MODIFY] `src/dashboard/ui.ts`
- Integrate tier cards, usage dashboard, and Projects tab

#### [MODIFY] `src/dashboard/server.ts`
- API routes for project CRUD and subscription display

---

## Phase 4 — Prism: Unlimited Projects + Teams

#### [MODIFY] `src/storage/sqlite.ts` — Add tables:
```sql
CREATE TABLE IF NOT EXISTS prism_projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'draft',  -- draft, active, on_hold, completed, archived
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prism_project_members (
  project_id TEXT NOT NULL REFERENCES prism_projects(id),
  user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',  -- owner, editor, viewer
  assigned_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, user_id)
);
```

#### [MODIFY] `src/storage/supabase.ts`
- Mirror tables for cloud sync (Advanced/Enterprise)

#### [NEW] `src/tools/projects.ts`
- `project_create` / `project_list` / `project_update` / `project_delete`
- `project_assign_member` / `project_remove_member`
- All enforce tier limits via `getCloudLimits()`

#### [MODIFY] `src/server.ts`
- Register project tools

---

## Phase 5 — Synalux: Dynamic Team Dashboards

Each team gets a live dashboard at `synalux.ai/team/[team-slug]`. Admin manages all teams from `synalux.ai/team/admin`.

#### [NEW] `portal/src/app/team/admin/page.tsx`
Admin panel: create/archive/delete teams, view all teams, manage team admins

#### [NEW] `portal/src/app/team/[slug]/page.tsx`
Dynamic team dashboard: shows team projects, members, status, activity feed

#### [NEW] `portal/src/app/team/[slug]/layout.tsx`
Team-scoped layout with sidebar nav (Projects, Members, Settings)

#### [NEW] `portal/src/app/team/[slug]/projects/page.tsx`
Team project list: create/archive/delete projects (Team Admin+), status tracking

#### [NEW] `portal/src/app/team/[slug]/members/page.tsx`
Team member management: invite, assign roles, remove

#### [NEW] `portal/src/app/team/[slug]/settings/page.tsx`
Team settings: name, slug, branding, archive/delete team

#### [NEW] `supabase/migrations/xxx_teams_and_projects.sql`
```sql
CREATE TABLE teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  created_by UUID REFERENCES auth.users(id),
  status TEXT DEFAULT 'active' CHECK (status IN ('active','archived','deleted')),
  created_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE TABLE team_members (
  team_id UUID REFERENCES teams(id),
  user_id UUID REFERENCES auth.users(id),
  role TEXT NOT NULL CHECK (role IN ('team_admin','editor','viewer')),
  PRIMARY KEY (team_id, user_id)
);
CREATE TABLE team_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id UUID REFERENCES teams(id),
  name TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft','active','on_hold','completed','archived','deleted')),
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE TABLE team_project_members (
  project_id UUID REFERENCES team_projects(id),
  user_id UUID REFERENCES auth.users(id),
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);
```

#### [NEW] `portal/src/app/api/v1/teams/route.ts`
CRUD for teams — Admin only can create; Team Admin can update

#### [NEW] `portal/src/app/api/v1/teams/[id]/projects/route.ts`
CRUD for projects — Team Admin+ can create; enforce tier limits

#### [NEW] `portal/src/app/api/v1/teams/[id]/members/route.ts`
Member assignment — Team Admin+ can invite/remove

---

## Phase 6 — Synalux: Visual App/Site Builder

#### [NEW] `portal/src/app/app/team-builder/page.tsx`
Full-screen builder shell: Top Nav + Palette + Canvas + Properties Panel

#### [NEW] `portal/src/app/app/team-builder/components/BuilderCanvas.tsx`
Drag-and-drop canvas for assembling components

#### [NEW] `portal/src/app/app/team-builder/components/Palette.tsx`
Searchable component directory (Layouts, UI, Data, Base elements)
- **Tier-gated:** Data Grids, Webhooks locked for `tier < Advanced`

#### [NEW] `portal/src/app/app/team-builder/components/PropertiesPanel.tsx`
Context-aware config: Typography, Spacing, Colors, Database Connection tab

#### [NEW] `portal/src/app/app/team-builder/lib/registry.ts`
Static component definitions (hero, grid, text, button) with data binding hooks

#### [NEW] `portal/src/lib/builder-hooks.ts`
Securely scoped SWR/Supabase hooks for live data binding (`{{ row.field }}`)

---

## Verification
- `npx tsc --noEmit` — zero errors (both repos)
- `npm test` — all pass
- `curl /api/v1/prism/verify` — valid/invalid keys
- Rate limits: exceed daily → 429
- Free tier: 1 team, 1 project max enforced
- Standard tier: 3 teams, 3 projects/team enforced
- Advanced: unlimited projects verified
- Admin creates team → `synalux.ai/team/[slug]` resolves
- Team Admin creates project → appears in team dashboard
- Archive/delete teams and projects verified
- Builder: drag-and-drop, data binding, tier gating tested
