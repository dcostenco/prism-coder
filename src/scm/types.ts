/**
 * SCM Types — Synalux Interface Re-exports
 * ==========================================
 * These interfaces mirror the Synalux SCM engines.
 * Only types live in Prism — implementations stay in Synalux.
 *
 * @see synalux-private/portal/src/lib/code-search.ts
 * @see synalux-private/portal/src/lib/ai-review.ts
 * @see synalux-private/portal/src/lib/security-scanner.ts
 * @see synalux-private/portal/src/lib/dora-metrics.ts
 */

// ── Code Search ─────────────────────────────────────────────

export type SearchMode = 'exact' | 'regex' | 'semantic' | 'symbol';

export interface SearchQuery {
    query: string;
    mode: SearchMode;
    repos?: string[];
    file_patterns?: string[];
    exclude_patterns?: string[];
    max_results?: number;
    context_lines?: number;
}

export interface SearchResult {
    file: string;
    repo_full_name: string;
    line_number: number;
    content: string;
    score: number;
    match_type: SearchMode;
}

export interface SearchResponse {
    results: SearchResult[];
    total_matches: number;
    search_time_ms: number;
    truncated: boolean;
}

// ── AI Review ───────────────────────────────────────────────

export type ReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface AIReviewFinding {
    id: string;
    file: string;
    line_start: number;
    severity: ReviewSeverity;
    title: string;
    description: string;
    rule_id?: string;
}

export interface AIReviewResult {
    overall_score: number;
    total_findings: number;
    findings: AIReviewFinding[];
    auto_approve: boolean;
    model: string;
}

export interface HipaaResult {
    compliant: boolean;
    score: number;
    violations: AIReviewFinding[];
}

// ── Security Scanner ────────────────────────────────────────

export interface SecurityFinding {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    title: string;
    description: string;
    file?: string;
    line?: number;
    remediation: string;
}

export interface ScanSummary {
    total_findings: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
    pass: boolean;
    scan_duration_ms: number;
}

// ── DORA Metrics ────────────────────────────────────────────

export type DoraLevel = 'elite' | 'high' | 'medium' | 'low';

export interface DoraMetrics {
    deployment_frequency: { value: number; level: DoraLevel };
    lead_time: { value: number; level: DoraLevel };
    change_failure_rate: { value: number; level: DoraLevel };
    mttr: { value: number; level: DoraLevel };
    overall_level: DoraLevel;
    period: string;
    team_size: number;
}

// ── Workflow Triggers (v15 — GitHub Migration Parity) ──────
// These types define the CI/CD workflow engine that provides
// 100% compatibility with GitHub Actions YAML workflows.

export type WorkflowTriggerEvent =
    | 'push'
    | 'pull_request'
    | 'pull_request_review'
    | 'release'
    | 'schedule'
    | 'workflow_dispatch'
    | 'repository_dispatch';

export interface WorkflowPathFilter {
    /** Glob patterns that MUST match changed files to trigger */
    paths?: string[];
    /** Glob patterns that exclude files from triggering */
    paths_ignore?: string[];
}

export interface WorkflowTrigger {
    event: WorkflowTriggerEvent;
    /** Branch filters (e.g., ['main', 'release/*']) */
    branches?: string[];
    branches_ignore?: string[];
    /** Path-based filters for selective pipeline runs */
    path_filter?: WorkflowPathFilter;
    /** Cron expression for schedule triggers */
    cron?: string;
    /** Manual dispatch inputs */
    inputs?: Record<string, {
        description: string;
        required: boolean;
        default?: string;
        type: 'string' | 'boolean' | 'number' | 'choice';
        options?: string[];
    }>;
}

export interface WorkflowStep {
    name: string;
    /** Action reference (e.g., 'actions/checkout@v4') or 'run' */
    uses?: string;
    run?: string;
    with?: Record<string, string | number | boolean>;
    env?: Record<string, string>;
    /** Conditional execution expression */
    if?: string;
    /** Timeout in minutes */
    timeout_minutes?: number;
}

export interface WorkflowJob {
    name: string;
    runs_on: string;
    needs?: string[];
    steps: WorkflowStep[];
    env?: Record<string, string>;
    /** Concurrency group for preventing duplicate runs */
    concurrency?: {
        group: string;
        cancel_in_progress: boolean;
    };
    permissions?: Record<string, 'read' | 'write' | 'none'>;
}

export interface WorkflowConfig {
    name: string;
    on: WorkflowTrigger[];
    jobs: Record<string, WorkflowJob>;
    /** Global environment variables */
    env?: Record<string, string>;
}

export type WorkflowRunStatus =
    | 'queued'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'timed_out';

export interface WorkflowRun {
    id: string;
    workflow_name: string;
    status: WorkflowRunStatus;
    conclusion?: 'success' | 'failure' | 'cancelled' | 'skipped';
    /** Trigger event that started this run */
    trigger_event: WorkflowTriggerEvent;
    /** Files that changed and triggered this run */
    changed_files?: string[];
    /** Commit SHA that triggered the run */
    head_sha: string;
    /** Branch name */
    head_branch: string;
    started_at: string;
    completed_at?: string;
    /** Artifact output paths */
    artifacts?: { name: string; size_bytes: number; url: string }[];
}

// ── SCM Tiers ───────────────────────────────────────────────

export type ScmTier = 'free' | 'standard' | 'advanced' | 'enterprise';

export interface ScmTierLimits {
    public_repos: number;
    private_repos: number;
    collaborators_per_repo: number;
    storage_bytes: number;
    ai_reviews_per_month: number;
    api_calls_per_day: number;
    ci_minutes_per_month: number;
    webhooks_per_repo: number;
    ide_hours_per_day: number;
    stacked_prs: boolean;
    dora_metrics: 'none' | 'basic' | 'full' | 'custom';
    search_modes: SearchMode[];
    hipaa_compliance: boolean;
    sso_saml: boolean;
    /** Max concurrent VMs (see src/vm/types.ts VM_TIERS for full VM limits) */
    vm_concurrent: number;
    /** VMware/Parallels import support */
    vm_import: boolean;
    /** User-defined custom device parameters */
    custom_devices: boolean;
    /** Max deploys per day */
    deploys_per_day: number;
    /** Thin-client proxy to Synalux Cloud */
    thin_client: boolean;
}

export const SCM_TIERS: Record<ScmTier, ScmTierLimits> = {
    free: {
        public_repos: 3, private_repos: 1, collaborators_per_repo: 2,
        storage_bytes: 200 * 1024 * 1024, ai_reviews_per_month: 5,
        api_calls_per_day: 100, ci_minutes_per_month: 50,
        webhooks_per_repo: 2, ide_hours_per_day: 1,
        stacked_prs: false, dora_metrics: 'none',
        search_modes: ['exact'], hipaa_compliance: false, sso_saml: false,
        vm_concurrent: 1, vm_import: false, custom_devices: false, deploys_per_day: 3, thin_client: false,
    },
    standard: {
        public_repos: 20, private_repos: 10, collaborators_per_repo: 5,
        storage_bytes: 2 * 1024 * 1024 * 1024, ai_reviews_per_month: 50,
        api_calls_per_day: 2_000, ci_minutes_per_month: 500,
        webhooks_per_repo: 10, ide_hours_per_day: 4,
        stacked_prs: true, dora_metrics: 'basic',
        search_modes: ['exact', 'regex', 'symbol'], hipaa_compliance: false, sso_saml: false,
        vm_concurrent: 3, vm_import: true, custom_devices: true, deploys_per_day: 25, thin_client: true,
    },
    advanced: {
        public_repos: Infinity, private_repos: 50, collaborators_per_repo: 25,
        storage_bytes: 10 * 1024 * 1024 * 1024, ai_reviews_per_month: 500,
        api_calls_per_day: 5_000, ci_minutes_per_month: 5_000,
        webhooks_per_repo: 50, ide_hours_per_day: 12,
        stacked_prs: true, dora_metrics: 'full',
        search_modes: ['exact', 'regex', 'symbol', 'semantic'], hipaa_compliance: true, sso_saml: false,
        vm_concurrent: 8, vm_import: true, custom_devices: true, deploys_per_day: 100, thin_client: true,
    },
    enterprise: {
        public_repos: Infinity, private_repos: Infinity, collaborators_per_repo: Infinity,
        storage_bytes: 100 * 1024 * 1024 * 1024, ai_reviews_per_month: Infinity,
        api_calls_per_day: Infinity, ci_minutes_per_month: Infinity,
        webhooks_per_repo: Infinity, ide_hours_per_day: Infinity,
        stacked_prs: true, dora_metrics: 'custom',
        search_modes: ['exact', 'regex', 'symbol', 'semantic'], hipaa_compliance: true, sso_saml: true,
        vm_concurrent: Infinity, vm_import: true, custom_devices: true, deploys_per_day: Infinity, thin_client: true,
    },
};
