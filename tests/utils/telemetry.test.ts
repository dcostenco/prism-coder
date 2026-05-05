/**
 * Telemetry env-var precedence tests
 *
 * Pins the contract that OTel SDK can be configured purely via standard
 * env vars (CUSTOMER_FEEDBACK § #10 — self-host story). Tests run the
 * three resolver helpers in isolation; we don't init the actual OTel
 * SDK here because that requires a real OTLP collector.
 *
 * Precedence rules (high → low):
 *   Enabled?  OTEL_SDK_DISABLED=true wins (off)
 *           > PRISM_OTEL_ENABLED=true wins (on)
 *           > dashboard otel_enabled
 *
 *   Endpoint: OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (most specific)
 *           > OTEL_EXPORTER_OTLP_ENDPOINT (base + /v1/traces appended)
 *           > dashboard otel_endpoint
 *
 *   Service:  OTEL_SERVICE_NAME
 *           > dashboard otel_service_name
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock configStorage so tests don't need a real DB. The mock returns
// per-test settings via mockSettings.
const mockSettings: Record<string, string> = {};
vi.mock("../../src/storage/configStorage.js", () => ({
  getSettingSync: (key: string, def: string) => mockSettings[key] ?? def,
}));

import {
  resolveOtelEnabled,
  resolveOtelEndpoint,
  resolveOtelServiceName,
} from "../../src/utils/telemetry.js";

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  // Reset env + dashboard mocks between tests so precedence is deterministic.
  process.env = { ...ORIGINAL_ENV };
  delete process.env.OTEL_SDK_DISABLED;
  delete process.env.PRISM_OTEL_ENABLED;
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  delete process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  delete process.env.OTEL_SERVICE_NAME;
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
});

describe("resolveOtelEnabled — precedence", () => {
  it("defaults to false when nothing is configured", () => {
    expect(resolveOtelEnabled()).toBe(false);
  });

  it("dashboard otel_enabled=true → true", () => {
    mockSettings.otel_enabled = "true";
    expect(resolveOtelEnabled()).toBe(true);
  });

  it("PRISM_OTEL_ENABLED=true beats dashboard=false", () => {
    mockSettings.otel_enabled = "false";
    process.env.PRISM_OTEL_ENABLED = "true";
    expect(resolveOtelEnabled()).toBe(true);
  });

  it("OTEL_SDK_DISABLED=true beats PRISM_OTEL_ENABLED=true (kill switch)", () => {
    process.env.PRISM_OTEL_ENABLED = "true";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(resolveOtelEnabled()).toBe(false);
  });

  it("OTEL_SDK_DISABLED=true beats dashboard=true (kill switch)", () => {
    mockSettings.otel_enabled = "true";
    process.env.OTEL_SDK_DISABLED = "true";
    expect(resolveOtelEnabled()).toBe(false);
  });

  it("env values are case + whitespace tolerant", () => {
    process.env.PRISM_OTEL_ENABLED = "  TRUE  ";
    expect(resolveOtelEnabled()).toBe(true);
  });

  it("OTEL_SDK_DISABLED=anything-other-than-true does NOT disable", () => {
    // Common mistake: setting OTEL_SDK_DISABLED=false thinking it enables OTel.
    // Per the spec, only "true" disables. "false" is the same as unset.
    mockSettings.otel_enabled = "true";
    process.env.OTEL_SDK_DISABLED = "false";
    expect(resolveOtelEnabled()).toBe(true);
  });
});

describe("resolveOtelEndpoint — precedence", () => {
  it("defaults to localhost:4318/v1/traces", () => {
    expect(resolveOtelEndpoint()).toBe("http://localhost:4318/v1/traces");
  });

  it("dashboard otel_endpoint wins over default", () => {
    mockSettings.otel_endpoint = "http://my-collector:4318/v1/traces";
    expect(resolveOtelEndpoint()).toBe("http://my-collector:4318/v1/traces");
  });

  it("OTEL_EXPORTER_OTLP_ENDPOINT base value gets /v1/traces appended", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318";
    expect(resolveOtelEndpoint()).toBe("http://otel-collector:4318/v1/traces");
  });

  it("trailing slash on base endpoint doesn't double up", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://otel-collector:4318/";
    expect(resolveOtelEndpoint()).toBe("http://otel-collector:4318/v1/traces");
  });

  it("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT (specific) wins over base", () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://wrong:4318";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "https://api.honeycomb.io/v1/traces";
    expect(resolveOtelEndpoint()).toBe("https://api.honeycomb.io/v1/traces");
  });

  it("env wins over dashboard", () => {
    mockSettings.otel_endpoint = "http://dashboard:4318/v1/traces";
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT = "http://env:4318/v1/traces";
    expect(resolveOtelEndpoint()).toBe("http://env:4318/v1/traces");
  });
});

describe("resolveOtelServiceName — precedence", () => {
  it("defaults to prism-mcp-server", () => {
    expect(resolveOtelServiceName()).toBe("prism-mcp-server");
  });

  it("dashboard wins over default", () => {
    mockSettings.otel_service_name = "my-prism-staging";
    expect(resolveOtelServiceName()).toBe("my-prism-staging");
  });

  it("OTEL_SERVICE_NAME wins over dashboard", () => {
    mockSettings.otel_service_name = "ignored";
    process.env.OTEL_SERVICE_NAME = "prism-prod-us-east";
    expect(resolveOtelServiceName()).toBe("prism-prod-us-east");
  });

  it("empty/whitespace env value falls back to dashboard", () => {
    mockSettings.otel_service_name = "from-dashboard";
    process.env.OTEL_SERVICE_NAME = "   ";
    expect(resolveOtelServiceName()).toBe("from-dashboard");
  });
});
