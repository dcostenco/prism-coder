const DASHBOARD_SETTABLE_KEYS = new Set([
  "PRISM_STORAGE",
  "dashboard_theme", "default_context_depth", "max_tokens",
  "default_role", "agent_name", "autoload_projects",
  "auto_capture", "hivemind_enabled", "task_router_enabled",
  "embedding_provider", "embedding_model",
  "PRISM_ENABLE_HIVEMIND", "PRISM_DARK_FACTORY_ENABLED",
  "PRISM_TASK_ROUTER_ENABLED", "PRISM_SCHOLAR_ENABLED",
  "PRISM_HDC_ENABLED", "PRISM_ACTR_ENABLED",
  "PRISM_GRAPH_PRUNING_ENABLED",
]);

/** Restrict the generic settings endpoint to documented dashboard controls. */
export function isDashboardSettingKeyAllowed(key: string): boolean {
  return DASHBOARD_SETTABLE_KEYS.has(key) || key.startsWith("ttl:") ||
    key.startsWith("autoload:") || key.startsWith("repo_path:");
}

/** Validate settings that later enter tool descriptions, paths, or numeric limits. */
export function isDashboardSettingValueAllowed(key: string, value: string): boolean {
  if (value.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) return false;
  if (key === "default_context_depth") return ["quick", "standard", "deep"].includes(value);
  if (key === "dashboard_theme") return ["dark", "midnight", "purple"].includes(value);
  if (key === "PRISM_STORAGE") return ["auto", "local", "supabase"].includes(value);
  if (key === "max_tokens") return /^\d+$/.test(value) && Number(value) <= 100_000;
  if (["auto_capture", "hivemind_enabled", "task_router_enabled"].includes(key)) {
    return value === "true" || value === "false";
  }
  if (key === "agent_name") return value.length <= 80 && !/[<>]/.test(value);
  if (key === "default_role") return /^[a-zA-Z0-9._:-]{0,64}$/.test(value);
  if (key === "autoload_projects") {
    const projects = value.split(",").map((project) => project.trim()).filter(Boolean);
    return projects.length <= 20 && projects.every((project) => /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,127}$/.test(project));
  }
  return true;
}
