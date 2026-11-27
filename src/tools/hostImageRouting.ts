import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export const HOST_IMAGE_ROUTING_GUIDANCE =
  "For a request to actually generate an image, use session_route_prompt before generation, including " +
  "on the first turn after startup. Pass image_generation with available_tools listing only image tools " +
  "callable in this session. Include host_model only if runtime metadata identifies the selected chat model. " +
  "Omit unknown model IDs. An empty tool list is valid. " +
  "Call the router on its own and wait for the prism_image_route result before deciding to generate. " +
  "Do not batch or parallelize the route call with any image tool call. " +
  "When prism_image_route names a host tool, use that tool for the request. If the route is unavailable, " +
  "report the missing capability. A handoff is not a generated image. Report the exact rendering model " +
  "only when the image tool or artifact identifies it. Never switch providers automatically after a refusal or timeout.";

const IMAGE_TOOLS = {
  codex: new Set(["image_gen", "image_gen__imagegen", "imagegen"]),
  gemini: new Set(["mcp_nanobanana_generate_image"]),
  cursor: new Set(["generateimage", "generate_image"]),
  claude: new Set(["mcp__nanobanana__generate_image"]),
} as const;

type ImageHost = keyof typeof IMAGE_TOOLS | "unknown";
const CHAT_MODEL_ID = /^[a-z0-9][a-z0-9_.:/-]{0,127}$/i;
const MAX_REPORTED_TOOLS = 32;

function identifyHost(clientName?: string): ImageHost {
  const tokens = new Set(clientName?.toLowerCase().split(/[^a-z0-9]+/));
  for (const host of Object.keys(IMAGE_TOOLS) as (keyof typeof IMAGE_TOOLS)[]) {
    if (tokens.has(host)) return host;
  }
  return "unknown";
}

export function getHostImageRoute(args: unknown, clientName?: string) {
  const report = (args as { image_generation?: { available_tools?: unknown; host_model?: unknown } } | null)
    ?.image_generation;
  if (!report || !Array.isArray(report.available_tools)) return undefined;
  const host = identifyHost(clientName);
  const available = report.available_tools.slice(0, MAX_REPORTED_TOOLS);
  const tool = host === "unknown" ? null : available.find((name): name is string =>
    typeof name === "string" && IMAGE_TOOLS[host].has(name.toLowerCase())) ?? null;
  const hostModel = typeof report.host_model === "string" && CHAT_MODEL_ID.test(report.host_model)
    ? report.host_model : null;
  return { target: tool ? "host" : "unavailable", host, reported_host_model: hostModel, tool, image_model: null } as const;
}

export function appendHostImageRoute(result: CallToolResult, args: unknown, clientName?: string): CallToolResult {
  const route = getHostImageRoute(args, clientName);
  if (!route || result.isError) return result;
  const line = `<prism_image_route>${JSON.stringify(route)}</prism_image_route>`;
  const index = result.content.findIndex(item => item.type === "text");
  if (index < 0) return { ...result, content: [...result.content, { type: "text", text: line }] };
  const content = result.content.map((item, i) =>
    i === index && item.type === "text" ? { ...item, text: `${item.text}\n\n${line}` } : item);
  return { ...result, content };
}
