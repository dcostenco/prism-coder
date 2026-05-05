/**
 * OpenTelemetry Telemetry Initializer (v4.6.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Singleton NodeTracerProvider that wires Prism's instrumentation to an OTLP
 *   collector (Jaeger, Zipkin, Grafana Tempo, Datadog, etc.).
 *
 * DESIGN PRINCIPLES:
 *
 *   1. DASHBOARD-DRIVEN CONFIG (no .env required)
 *      All three OTel settings are read from configStorage — the same mechanism
 *      used for AI provider keys and storage backends. Users toggle OTel from
 *      the Dashboard "Observability" tab.
 *        otel_enabled      → "true" | "false"  (default: "false")
 *        otel_endpoint     → e.g. "http://localhost:4318/v1/traces"
 *        otel_service_name → e.g. "prism-mcp-server"
 *
 *   2. GRACEFUL NO-OP (zero guards in caller code)
 *      When otel_enabled is false, getTracer() returns the SDK's built-in no-op
 *      tracer — every span call becomes a zero-cost no-op. No `if (otelEnabled)`
 *      guards are needed in any instrumented file.
 *
 *   3. RESTART REQUIRED FOR CHANGES
 *      initTelemetry() runs once at startup after initConfigStorage() has
 *      populated the settings cache. Toggling OTel requires a server restart
 *      (same behavior as changing PRISM_STORAGE). The Dashboard Observability
 *      tab shows a restart banner when these settings change.
 *
 *   4. SHUTDOWN FLUSH (Data integrity on SIGTERM/disconnect)
 *      BatchSpanProcessor holds spans in memory for up to 5 seconds before
 *      exporting. A SIGTERM or MCP client disconnect would silently lose
 *      buffered spans without explicit flushing. shutdownTelemetry() is called
 *      FIRST in lifecycle.ts shutdown() — before any DB connections close —
 *      so spans referencing DB operations are exported while context is intact.
 *
 *   5. BRIDGE TO EXISTING TRACING (src/utils/tracing.ts)
 *      The Phase-1 MemoryTrace system (per-search explainability, content[1])
 *      is orthogonal to OTel. Both coexist. OTel answers "latency waterfall";
 *      MemoryTrace answers "why was this memory returned?". Exactly as
 *      tracing.ts lines 26-29 predicted: "OTel integration layers on top in
 *      a follow-up without any code changes to the MemoryTrace types."
 *
 * STARTUP (server.ts startServer()):
 *   await initConfigStorage();   // warm the settings cache first
 *   initTelemetry();             // synchronous read from warm cache
 *   const server = createServer();
 *
 * SHUTDOWN (lifecycle.ts shutdown()):
 *   await shutdownTelemetry();   // flush BatchSpanProcessor buffer FIRST
 *   closeConfigStorage();        // then close DB connections
 *
 * API:
 *   initTelemetry()      — call once at startup, idempotent
 *   getTracer()          — returns the active tracer (or no-op if disabled)
 *   shutdownTelemetry()  — flushes and shuts down the provider
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { trace, Tracer } from "@opentelemetry/api";
import {
  NodeTracerProvider,
  BatchSpanProcessor,
} from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SEMRESATTRS_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { getSettingSync } from "../storage/configStorage.js";

// ─── Module-level singleton ───────────────────────────────────────────────────
// Null when OTel is disabled or before initTelemetry() is called.
let _provider: NodeTracerProvider | null = null;

// Tracer name — appears in every span's instrumentation.name field in the UI.
const TRACER_NAME = "prism-mcp";

// ─────────────────────────────────────────────────────────────────────────────
// initTelemetry()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve OTel settings with the standard precedence:
 *   1. OTEL_* env vars (industry-standard names — self-host friendly)
 *   2. Dashboard system_settings via getSettingSync
 *   3. Hard-coded default
 *
 * Standard env var names are documented at:
 *   https://opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables/
 *
 * Supported here:
 *   OTEL_SDK_DISABLED                       — "true" disables, anything else enables
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT      — full traces endpoint (most specific)
 *   OTEL_EXPORTER_OTLP_ENDPOINT             — base endpoint; /v1/traces is appended
 *   OTEL_SERVICE_NAME                       — service.name resource attribute
 *
 * Why follow the standard names: any user who already runs an OTEL-aware
 * stack (Jaeger, Honeycomb, Datadog) has these env vars set in their
 * deployment. Reading the same names means prism-mcp "just works" with
 * zero extra config in those environments.
 */
// Exported for unit testing only — production code should not call these
// directly; they're called internally by initTelemetry().
export function resolveOtelEnabled(): boolean {
  // OTEL_SDK_DISABLED takes precedence (matches the spec). Hard kill switch.
  const sdkDisabled = process.env.OTEL_SDK_DISABLED?.trim().toLowerCase();
  if (sdkDisabled === "true") return false;
  // PRISM_OTEL_ENABLED is our explicit on-switch — useful for OSS / container
  // deploys where the user wants to enable OTel without standing up a
  // dashboard. There's no standard "enable" env var in the OTel spec
  // (SDKs are typically opt-out, but ours is opt-in), so this lives under
  // the PRISM_ namespace alongside PRISM_TEXT_PROVIDER etc.
  const prismOtel = process.env.PRISM_OTEL_ENABLED?.trim().toLowerCase();
  if (prismOtel === "true") return true;
  // No env-var override → fall back to dashboard. Dashboard default is "false".
  return getSettingSync("otel_enabled", "false") === "true";
}

export function resolveOtelEndpoint(): string {
  // Most specific env wins.
  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim();
  if (tracesEndpoint) return tracesEndpoint;
  // Base endpoint — the OTel spec says we should append /v1/traces.
  const baseEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (baseEndpoint) {
    // Strip any trailing slash to avoid "//" in the resulting URL.
    return `${baseEndpoint.replace(/\/$/, "")}/v1/traces`;
  }
  return getSettingSync("otel_endpoint", "http://localhost:4318/v1/traces");
}

export function resolveOtelServiceName(): string {
  const fromEnv = process.env.OTEL_SERVICE_NAME?.trim();
  if (fromEnv) return fromEnv;
  return getSettingSync("otel_service_name", "prism-mcp-server");
}

/**
 * Initialize the OpenTelemetry SDK.
 *
 * Must be called after initConfigStorage() so the settings cache is warm.
 * Idempotent — calling more than once is a safe no-op.
 * Errors are caught and logged; the server always continues normally.
 */
export function initTelemetry(): void {
  if (_provider) return; // Already initialized

  const enabled     = resolveOtelEnabled();
  const endpoint    = resolveOtelEndpoint();
  const serviceName = resolveOtelServiceName();

  if (!enabled) {
    // OTel is disabled. getTracer() will return the SDK global no-op tracer.
    // No NodeTracerProvider is created; no OTLP connections are attempted.
    return;
  }

  try {
    // REVIEWER NOTE: resourceFromAttributes() is the v2 API for Resource.
    // SEMRESATTRS_SERVICE_NAME resolves to the stable "service.name" string
    // which is the primary label in Jaeger/Zipkin/Grafana Tempo trace UIs.
    const resource = resourceFromAttributes({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
    });

    // REVIEWER NOTE: BatchSpanProcessor is mandatory for production.
    // SimpleSpanProcessor (sync, one-by-one) would block the Node.js event
    // loop during each 500ms OTLP export — freezing MCP request handling.
    // BatchSpanProcessor runs on a timer in the background.
    const exporter = new OTLPTraceExporter({ url: endpoint });
    const processor = new BatchSpanProcessor(exporter, {
      // Flush at most 512 spans per batch — prevents memory blow-up when the
      // collector is temporarily unreachable (backpressure safety).
      maxExportBatchSize: 512,
      // 10s timeout per export batch — balances reliability vs shutdown delay.
      exportTimeoutMillis: 10_000,
      // Export every 5 seconds — good balance of latency visibility vs I/O.
      scheduledDelayMillis: 5_000,
    });

    // REVIEWER NOTE: v2 API — spanProcessors passed in constructor config,
    // not via addSpanProcessor(). resource + spanProcessors are both config
    // properties. The provider must be .register()'d to become the global
    // tracer provider, enabling AsyncLocalStorage context propagation.
    _provider = new NodeTracerProvider({
      resource,
      spanProcessors: [processor],
    });
    _provider.register();

    console.error(
      `[Telemetry] OpenTelemetry initialized. ` +
      `Service: "${serviceName}", Endpoint: "${endpoint}"`
    );
  } catch (err) {
    // OTel init errors must NEVER crash the server. Log and continue.
    console.error(`[Telemetry] Failed to initialize OTel (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    _provider = null; // Clean state so getTracer() returns no-op
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// getTracer()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Returns the active OTel Tracer.
 *
 * When _provider is null (OTel disabled or init failed), trace.getTracer()
 * returns the SDK's built-in no-op tracer — every span call is zero-cost.
 * Callers never need `if (otelEnabled)` guards.
 *
 * @example
 *   const span = getTracer().startSpan("mcp.call_tool", { attributes: { "tool.name": name } });
 *   span.end();
 */
export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

// ─────────────────────────────────────────────────────────────────────────────
// shutdownTelemetry()
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Flush all buffered spans and shut down the NodeTracerProvider.
 *
 * CRITICAL ORDERING — Must be called BEFORE closing any DB connections.
 * BatchSpanProcessor holds spans that may reference DB operations. If the DB
 * closes first, those spans' context becomes incomplete in the trace UI.
 *
 * In lifecycle.ts registerShutdownHandlers():
 *   await shutdownTelemetry();  // ← step 0: flush spans FIRST
 *   closeConfigStorage();       // ← step 1: close config DB
 *   await storage.close();      // ← step 2: close ledger DB
 *
 * When OTel is disabled (_provider === null), this resolves immediately.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (!_provider) return;

  try {
    await _provider.shutdown();
    console.error("[Telemetry] Flushed remaining spans and shut down.");
  } catch (err) {
    // Log but don't rethrow — shutdown errors must not prevent DB cleanup.
    console.error(`[Telemetry] Error during shutdown (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
  }
}
