export interface IntentHealthResult {
  score: number;
  staleness_days: number;
  open_todo_count: number;
  has_active_decisions: boolean;
  signals: Array<{
    type: string;
    message: string;
    severity: "ok" | "warn" | "critical";
  }>;
}

export function computeIntentHealth(
  ctx: any,
  staleThresholdDays: number = 30,
  nowMs: number = Date.now()
): IntentHealthResult {
  if (!Number.isFinite(staleThresholdDays) || staleThresholdDays <= 0) staleThresholdDays = 30; // Guard against NaN / zero / negative

  // 2. Compute staleness (Days since last session)
  let stalenessDays = 0;
  if (ctx.recent_sessions && ctx.recent_sessions.length > 0) {
    const lastTimestamp = ctx.recent_sessions[0].created_at ? new Date(ctx.recent_sessions[0].created_at).getTime() : NaN;
    stalenessDays = isNaN(lastTimestamp) ? 0 : Math.max(0, (nowMs - lastTimestamp) / (1000 * 60 * 60 * 24));
  }

  // 3. Count TODOs and Decisions
  const todoCount = ctx.pending_todo?.length || 0;
  const hasDecisions = ctx.recent_sessions?.some(
    (s: any) => Array.isArray(s.decisions) && s.decisions.length > 0
  ) ?? false;

  // 4. Execute Intent Debt Scoring Algorithm
  // Staleness (50 points): Linear decay until threshold
  const stalenessScore = Math.max(0, 50 - (stalenessDays / staleThresholdDays) * 50);

  // Open TODOs (30 points)
  let todoScore = 30;
  if (todoCount >= 10) todoScore = 0;
  else if (todoCount >= 7) todoScore = 5;
  else if (todoCount >= 4) todoScore = 15;
  else if (todoCount >= 1) todoScore = 25;

  // Decisions (20 points): 70% of max if missing
  const decisionScore = hasDecisions ? 20 : 14;

  const totalScore = Math.min(100, Math.round(stalenessScore + todoScore + decisionScore));

  // 5. Generate Actionable Signals
  const signals: Array<{ type: string; message: string; severity: "ok" | "warn" | "critical" }> = [];

  if (stalenessDays > staleThresholdDays) {
    signals.push({ type: "staleness", message: `Stale: Last updated ${Math.round(stalenessDays)} days ago`, severity: "critical" });
  } else if (stalenessDays > staleThresholdDays / 2) {
    signals.push({ type: "staleness", message: `Aging: Last updated ${Math.round(stalenessDays)} days ago`, severity: "warn" });
  } else {
    signals.push({ type: "staleness", message: `Fresh: Last updated ${Math.round(stalenessDays)} days ago`, severity: "ok" });
  }

  if (todoCount >= 10) {
    signals.push({ type: "todos", message: `${todoCount} TODOs pending (Overwhelming)`, severity: "critical" });
  } else if (todoCount >= 4) {
    signals.push({ type: "todos", message: `${todoCount} TODOs pending`, severity: "warn" });
  } else {
    signals.push({ type: "todos", message: `${todoCount} TODOs pending`, severity: "ok" });
  }

  if (hasDecisions) {
    signals.push({ type: "decisions", message: "Active decisions captured", severity: "ok" });
  } else {
    signals.push({ type: "decisions", message: "No active decisions documented", severity: "warn" });
  }

  return {
    score: totalScore,
    staleness_days: Math.round(stalenessDays),
    open_todo_count: todoCount,
    has_active_decisions: hasDecisions,
    signals: signals
  };
}
