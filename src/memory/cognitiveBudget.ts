/**
 * Cognitive Budget — Token-Economic RL (v9.0)
 *
 * ═══════════════════════════════════════════════════════════════════
 * PURPOSE:
 *   Implements a strict token economy for agent memory operations.
 *   Instead of having infinite memory budgets, agents must learn to
 *   save high-signal, compressed entries — through physics, not prompts.
 *
 * ECONOMY DESIGN:
 *   - Budget is PERSISTENT (stored in session_handoffs.cognitive_budget)
 *   - Budget belongs to the PROJECT, not the ephemeral session
 *   - This prevents the "Reset Exploit" (close & reopen to get free tokens)
 *   - Revenue comes from Universal Basic Income (time-based) + success bonuses
 *   - No retrieval-based earning (prevents the "Minting Exploit" / search spam)
 *
 * COST MULTIPLIERS:
 *   Incoming entry surprisal determines the budget cost multiplier:
 *   - Low surprisal (boilerplate): 2.0× cost — penalizes "I updated CSS"
 *   - Normal surprisal:            1.0× cost — standard rate
 *   - High surprisal (novel):      0.5× cost — rewards novel insights
 *
 * GRACEFUL DEGRADATION:
 *   Budget exhaustion produces a WARNING in the MCP response but NEVER
 *   blocks the SQL insert. We never lose agent work due to verbosity.
 *
 * MINIMUM BASE COST:
 *   Empty/trivial summaries still bleed the budget (10 token minimum)
 *   to prevent zero-cost gaming with empty saves.
 *
 * UBI (UNIVERSAL BASIC INCOME):
 *   Instead of earning through arbitrary search spam, agents earn
 *   budget passively through time elapsed since last save:
 *   - +100 tokens per hour since last ledger save (capped at +500/session)
 *   - +200 bonus for a `success` experience event
 *   - +100 bonus for a `learning` experience event
 *
 * FILES THAT IMPORT THIS:
 *   - src/tools/ledgerHandlers.ts (budget tracking + diagnostics)
 *   - src/tools/ledgerHandlers.ts (budget persistence in handoff)
 * ═══════════════════════════════════════════════════════════════════
 */

// ─── Types ────────────────────────────────────────────────────

export interface BudgetResult {
  /** Whether the save is allowed (always true — graceful degradation) */
  allowed: true;
  /** Tokens spent on this operation */
  spent: number;
  /** Remaining budget after this operation */
  remaining: number;
  /** Warning message if budget is low or exhausted */
  warning?: string;
  /** Surprisal score of the content (0.0 to 1.0) */
  surprisal?: number;
  /** Cost multiplier applied */
  costMultiplier?: number;
}

export interface BudgetStatus {
  /** Current balance */
  balance: number;
  /** Total tokens spent this session */
  totalSpent: number;
  /** Total tokens earned this session (UBI + bonuses) */
  totalEarned: number;
  /** Whether budget is exhausted */
  exhausted: boolean;
  /** Initial budget size for this project */
  initialBudget: number;
}

// ─── Constants ────────────────────────────────────────────────

/** Default initial budget per project (tokens) */
export const DEFAULT_BUDGET_SIZE = 2000;

/** Minimum base cost per save operation (tokens) — prevents zero-cost gaming */
export const MINIMUM_BASE_COST = 10;

/** UBI: tokens earned per hour since last save */
export const UBI_TOKENS_PER_HOUR = 100;

/** UBI: maximum tokens earnable via time-based UBI per session */
export const UBI_MAX_PER_SESSION = 500;

/** Bonus tokens for saving a `success` experience event */
export const SUCCESS_BONUS = 200;

/** Bonus tokens for saving a `learning` experience event */
export const LEARNING_BONUS = 100;

/** Budget warning threshold (below this, show advisory) */
export const LOW_BUDGET_THRESHOLD = 300;

// ─── Cost Multipliers ────────────────────────────────────────

/** Surprisal thresholds for cost multiplier tiers */
export const BOILERPLATE_THRESHOLD = 0.2;
export const NOVEL_THRESHOLD = 0.7;

/**
 * Compute the cost multiplier based on content surprisal.
 *
 * - Low surprisal (< 0.2): 2.0× — penalizes boilerplate
 * - Normal surprisal (0.2 - 0.7): 1.0× — standard rate
 * - High surprisal (> 0.7): 0.5× — rewards novel insights
 *
 * @param surprisal - Surprisal score in [0.0, 1.0]
 * @returns Cost multiplier
 */
export function computeCostMultiplier(surprisal: number): number {
  if (!Number.isFinite(surprisal)) return 1.0;
  if (surprisal < BOILERPLATE_THRESHOLD) return 2.0;
  if (surprisal > NOVEL_THRESHOLD) return 0.5;
  return 1.0;
}

// ─── Token Counting ───────────────────────────────────────────

/**
 * Estimate token count from text using the standard 1 token ≈ 4 chars.
 * Enforces the minimum base cost to prevent zero-cost gaming.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count (minimum: MINIMUM_BASE_COST)
 */
export function estimateTokens(text: string): number {
  if (!text || text.trim().length === 0) return MINIMUM_BASE_COST;
  return Math.max(MINIMUM_BASE_COST, Math.ceil(text.length / 4));
}

// ─── UBI Calculator ───────────────────────────────────────────

/**
 * Compute Universal Basic Income tokens earned since last save.
 *
 * @param lastSaveTime - ISO timestamp of last ledger save (or null if first save)
 * @param currentTime - Current time (default: now)
 * @returns Tokens earned via UBI (capped at UBI_MAX_PER_SESSION)
 */
export function computeUBI(
  lastSaveTime: string | null | undefined,
  currentTime: Date = new Date(),
): number {
  if (!lastSaveTime) return 0; // First save — no UBI

  const lastSave = new Date(lastSaveTime);
  if (isNaN(lastSave.getTime())) return 0;

  const hoursSinceLastSave = (currentTime.getTime() - lastSave.getTime()) / (1000 * 60 * 60);
  if (hoursSinceLastSave <= 0) return 0;

  // NOTE: Do NOT use Math.floor here — it destroys fractional earnings.
  // An agent saving every 15 min computes floor(0.25 * 100) = 0 tokens.
  // Since cognitive_budget is REAL (SQLite) / float8 (Postgres), fractional
  // values are natively supported. Only round at the UI display layer.
  const earned = hoursSinceLastSave * UBI_TOKENS_PER_HOUR;
  return Math.min(earned, UBI_MAX_PER_SESSION);
}

/**
 * Compute bonus tokens for specific experience event types.
 *
 * @param eventType - The experience event type
 * @returns Bonus tokens to add to budget
 */
export function computeEventBonus(eventType: string | undefined): number {
  switch (eventType) {
    case 'success': return SUCCESS_BONUS;
    case 'learning': return LEARNING_BONUS;
    default: return 0;
  }
}

// ─── Budget Manager ───────────────────────────────────────────

/**
 * Stateless budget operations.
 *
 * The budget is stored as a number in session_handoffs.cognitive_budget.
 * These functions compute the new balance — they don't persist anything.
 * The caller (ledgerHandlers.ts) is responsible for persistence.
 */

/**
 * Process a budget spend operation.
 *
 * @param currentBalance - Current budget balance
 * @param rawTokenCost - Raw token cost of the entry
 * @param surprisal - Surprisal score of the content [0, 1]
 * @param budgetSize - Initial budget size (for diagnostics)
 * @returns BudgetResult with new balance, warnings, and diagnostics
 */
export function spendBudget(
  currentBalance: number,
  rawTokenCost: number,
  surprisal: number,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
): BudgetResult {
  const safeCost = Math.max(MINIMUM_BASE_COST, rawTokenCost);
  const multiplier = computeCostMultiplier(surprisal);
  const adjustedCost = Math.ceil(safeCost * multiplier);

  const newBalance = currentBalance - adjustedCost;
  const remaining = Math.max(0, newBalance);

  let warning: string | undefined;

  if (newBalance <= 0) {
    warning = `⚠️ Cognitive budget exhausted (${remaining}/${budgetSize} tokens). ` +
      'Consider saving more concise, high-signal entries. ' +
      'Budget recovers passively over time (+100 tokens/hour).';
  } else if (newBalance < LOW_BUDGET_THRESHOLD) {
    warning = `⚡ Cognitive budget running low (${remaining}/${budgetSize} tokens). ` +
      'Prioritize novel, dense entries to reduce cost.';
  }

  return {
    allowed: true, // Always allow — graceful degradation
    spent: adjustedCost,
    remaining,
    warning,
    surprisal,
    costMultiplier: multiplier,
  };
}

/**
 * Apply Universal Basic Income + event bonuses to a budget balance.
 *
 * @param currentBalance - Current budget balance
 * @param lastSaveTime - ISO timestamp of last save
 * @param eventType - Optional event type for bonus
 * @param budgetSize - Maximum budget cap
 * @returns New balance after UBI + bonuses (capped at budgetSize)
 */
export function applyEarnings(
  currentBalance: number,
  lastSaveTime: string | null | undefined,
  eventType: string | undefined,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
): { newBalance: number; ubiEarned: number; bonusEarned: number } {
  const ubiEarned = computeUBI(lastSaveTime);
  const bonusEarned = computeEventBonus(eventType);

  // Cap at initial budget size — can't exceed maximum
  const newBalance = Math.min(budgetSize, currentBalance + ubiEarned + bonusEarned);

  return { newBalance, ubiEarned, bonusEarned };
}

/**
 * Format budget diagnostics for inclusion in MCP response text.
 *
 * @param result - The BudgetResult from spendBudget()
 * @param budgetSize - Initial budget size
 * @param ubiEarned - Tokens earned from UBI this operation
 * @param bonusEarned - Tokens earned from event bonus
 * @returns Formatted diagnostic string
 */
export function formatBudgetDiagnostics(
  result: BudgetResult,
  budgetSize: number = DEFAULT_BUDGET_SIZE,
  ubiEarned: number = 0,
  bonusEarned: number = 0,
): string {
  const parts: string[] = [];

  // Budget line
  const barLength = 20;
  const fillLength = Math.round((result.remaining / budgetSize) * barLength);
  const bar = '█'.repeat(Math.max(0, fillLength)) + '░'.repeat(Math.max(0, barLength - fillLength));
  parts.push(`💰 Budget: ${bar} ${result.remaining}/${budgetSize}`);

  // Surprisal line
  if (result.surprisal !== undefined) {
    const surprisalLabel = result.surprisal < BOILERPLATE_THRESHOLD ? 'boilerplate'
      : result.surprisal > NOVEL_THRESHOLD ? 'novel'
      : 'standard';
    parts.push(`📊 Surprisal: ${result.surprisal.toFixed(2)} (${surprisalLabel}) — cost: ${result.costMultiplier?.toFixed(1)}×`);
  }

  // Cost line
  parts.push(`🪙 Spent: ${result.spent} tokens`);

  // Earnings line (if any)
  if (ubiEarned > 0 || bonusEarned > 0) {
    const earningParts: string[] = [];
    if (ubiEarned > 0) earningParts.push(`+${Math.round(ubiEarned)} UBI`);
    if (bonusEarned > 0) earningParts.push(`+${Math.round(bonusEarned)} bonus`);
    parts.push(`📈 Earned: ${earningParts.join(', ')}`);
  }

  return parts.join('\n');
}
