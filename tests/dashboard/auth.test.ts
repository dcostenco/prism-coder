/**
 * Dashboard Auth Tests — Unit + HTTP Integration (v6.5.1)
 *
 * ═══════════════════════════════════════════════════════════════════
 * SCOPE:
 *   Comprehensive tests for the dashboard authentication system:
 *
 *   Part 1: Unit tests for authUtils.ts functions
 *     - safeCompare (timing-safe string comparison)
 *     - generateToken (random hex token generation)
 *     - isAuthenticated (cookie + Basic Auth validation)
 *     - createRateLimiter (sliding window rate limiting)
 *
 *   Part 2: HTTP integration tests for server.ts auth endpoints
 *     - POST /api/auth/login (credential exchange)
 *     - POST /api/auth/logout (session invalidation)
 *     - Auth gate (401 for unauthenticated requests)
 *     - Rate limiting (429 after 5 attempts)
 *     - CORS headers (dynamic vs wildcard)
 *     - Auth disabled pass-through
 *
 * APPROACH:
 *   Unit tests exercise pure functions directly.
 *   Integration tests spin up a real HTTP server with auth enabled
 *   and make actual HTTP requests against it.
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import * as http from "http";
import {
  safeCompare,
  generateToken,
  isAuthenticated,
  createRateLimiter,
  type AuthConfig,
} from "../../src/dashboard/authUtils.js";

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/** Create a mock IncomingMessage with specified headers */
function mockRequest(headers: Record<string, string> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage;
}

/** Encode credentials as Basic Auth header value */
function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Make a default auth config for testing */
function makeConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    authEnabled: true,
    authUser: "admin",
    authPass: "s3cret",
    activeSessions: new Map<string, number>(),
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════
// PART 1: UNIT TESTS — authUtils.ts
// ═════════════════════════════════════════════════════════════════

describe("safeCompare", () => {
  it("returns true for identical strings", () => {
    expect(safeCompare("hello", "hello")).toBe(true);
    expect(safeCompare("", "")).toBe(true);
    expect(safeCompare("a", "a")).toBe(true);
  });

  it("returns false for different strings of same length", () => {
    expect(safeCompare("hello", "world")).toBe(false);
    expect(safeCompare("abc", "abd")).toBe(false);
    expect(safeCompare("a", "b")).toBe(false);
  });

  it("returns false for strings of different lengths", () => {
    expect(safeCompare("short", "longer")).toBe(false);
    expect(safeCompare("", "x")).toBe(false);
    expect(safeCompare("abc", "ab")).toBe(false);
  });

  it("handles special characters", () => {
    expect(safeCompare("p@$$w0rd!", "p@$$w0rd!")).toBe(true);
    expect(safeCompare("p@$$w0rd!", "p@$$w0rd?")).toBe(false);
  });

  it("handles unicode characters", () => {
    expect(safeCompare("🔒secret", "🔒secret")).toBe(true);
    expect(safeCompare("🔒secret", "🔓secret")).toBe(false);
  });

  it("is consistent across multiple calls (no state leakage)", () => {
    for (let i = 0; i < 100; i++) {
      expect(safeCompare("test", "test")).toBe(true);
      expect(safeCompare("test", "nope")).toBe(false);
    }
  });
});

describe("generateToken", () => {
  it("generates a 64-character string", () => {
    const token = generateToken();
    expect(token).toHaveLength(64);
  });

  it("contains only hex characters", () => {
    const token = generateToken();
    expect(token).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates unique tokens across multiple calls", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateToken());
    }
    // All 100 should be unique (collision probability is astronomically low)
    expect(tokens.size).toBe(100);
  });
});

describe("isAuthenticated", () => {
  it("returns true when auth is disabled (pass-through)", async () => {
    const config = makeConfig({ authEnabled: false });
    const req = mockRequest({});
    expect(await isAuthenticated(req, config)).toBe(true);
  });

  it("returns false when auth is enabled and no credentials provided", async () => {
    const config = makeConfig();
    const req = mockRequest({});
    expect(await isAuthenticated(req, config)).toBe(false);
  });

  // ─── Cookie-based auth ───

  it("authenticates with a valid session cookie", async () => {
    const config = makeConfig();
    const token = "a".repeat(64);
    config.activeSessions.set(token, Date.now() + 86400_000);
    const req = mockRequest({ cookie: `prism_session=${token}` });
    expect(await isAuthenticated(req, config)).toBe(true);
  });

  it("rejects an expired session cookie and cleans it up (lazy cleanup)", async () => {
    const config = makeConfig();
    const token = "b".repeat(64);
    config.activeSessions.set(token, Date.now() - 1000); // Expired 1s ago
    const req = mockRequest({ cookie: `prism_session=${token}` });
    expect(await isAuthenticated(req, config)).toBe(false);
    // Verify lazy cleanup removed the expired token
    expect(config.activeSessions.has(token)).toBe(false);
  });

  it("rejects an unknown session cookie", async () => {
    const config = makeConfig();
    const token = "c".repeat(64);
    const req = mockRequest({ cookie: `prism_session=${token}` });
    expect(await isAuthenticated(req, config)).toBe(false);
  });

  it("handles malformed cookie strings gracefully", async () => {
    const config = makeConfig();
    // Weird cookie formats that should not crash
    expect(await isAuthenticated(mockRequest({ cookie: "" }), config)).toBe(false);
    expect(await isAuthenticated(mockRequest({ cookie: ";;=;" }), config)).toBe(false);
    expect(await isAuthenticated(mockRequest({ cookie: "prism_session=" }), config)).toBe(false);
    expect(await isAuthenticated(mockRequest({ cookie: "prism_session=tooshort" }), config)).toBe(false);
    expect(await isAuthenticated(mockRequest({ cookie: "prism_session=ZZZZ" + "0".repeat(60) }), config)).toBe(false); // uppercase Z not in [a-f0-9]
    expect(await isAuthenticated(mockRequest({ cookie: "other_cookie=value; prism_session=short" }), config)).toBe(false);
  });

  it("extracts cookie correctly when mixed with other cookies", async () => {
    const config = makeConfig();
    const token = "d".repeat(64);
    config.activeSessions.set(token, Date.now() + 86400_000);
    const req = mockRequest({
      cookie: `other=abc; prism_session=${token}; another=xyz`,
    });
    expect(await isAuthenticated(req, config)).toBe(true);
  });

  // ─── Basic Auth ───

  it("authenticates with valid Basic Auth credentials", async () => {
    const config = makeConfig();
    const req = mockRequest({ authorization: basicAuth("admin", "s3cret") });
    expect(await isAuthenticated(req, config)).toBe(true);
  });

  it("rejects invalid Basic Auth credentials", async () => {
    const config = makeConfig();
    expect(await isAuthenticated(
      mockRequest({ authorization: basicAuth("admin", "wrong") }),
      config,
    )).toBe(false);
    expect(await isAuthenticated(
      mockRequest({ authorization: basicAuth("wrong", "s3cret") }),
      config,
    )).toBe(false);
    expect(await isAuthenticated(
      mockRequest({ authorization: basicAuth("", "") }),
      config,
    )).toBe(false);
  });

  it("handles passwords containing colons", async () => {
    const config = makeConfig({ authPass: "pass:with:colons" });
    const req = mockRequest({ authorization: basicAuth("admin", "pass:with:colons") });
    expect(await isAuthenticated(req, config)).toBe(true);
  });

  it("rejects malformed Basic Auth headers", async () => {
    const config = makeConfig();
    // No "Basic " prefix
    expect(await isAuthenticated(
      mockRequest({ authorization: "Bearer token123" }),
      config,
    )).toBe(false);
    // Invalid base64
    expect(await isAuthenticated(
      mockRequest({ authorization: "Basic !!invalid!!" }),
      config,
    )).toBe(false);
    // Empty auth header
    expect(await isAuthenticated(
      mockRequest({ authorization: "" }),
      config,
    )).toBe(false);
    // Base64 with no colon separator
    expect(await isAuthenticated(
      mockRequest({ authorization: "Basic " + Buffer.from("nocolon").toString("base64") }),
      config,
    )).toBe(false);
  });

  it("prefers cookie over Basic Auth when both present", async () => {
    const config = makeConfig();
    const token = "e".repeat(64);
    config.activeSessions.set(token, Date.now() + 86400_000);
    // Valid cookie + WRONG Basic Auth → should still pass (cookie wins)
    const req = mockRequest({
      cookie: `prism_session=${token}`,
      authorization: basicAuth("wrong", "wrong"),
    });
    expect(await isAuthenticated(req, config)).toBe(true);
  });
});

describe("createRateLimiter", () => {
  it("allows requests within the limit", () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60000 });
    expect(limiter.isAllowed("ip1")).toBe(true);
    expect(limiter.isAllowed("ip1")).toBe(true);
    expect(limiter.isAllowed("ip1")).toBe(true);
  });

  it("blocks requests exceeding the limit", () => {
    const limiter = createRateLimiter({ maxAttempts: 3, windowMs: 60000 });
    limiter.isAllowed("ip1");
    limiter.isAllowed("ip1");
    limiter.isAllowed("ip1");
    expect(limiter.isAllowed("ip1")).toBe(false);
  });

  it("tracks IPs independently", () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    limiter.isAllowed("ip1");
    limiter.isAllowed("ip1");
    expect(limiter.isAllowed("ip1")).toBe(false);
    // ip2 should still be allowed
    expect(limiter.isAllowed("ip2")).toBe(true);
  });

  it("resets a specific IP", () => {
    const limiter = createRateLimiter({ maxAttempts: 2, windowMs: 60000 });
    limiter.isAllowed("ip1");
    limiter.isAllowed("ip1");
    expect(limiter.isAllowed("ip1")).toBe(false);
    limiter.reset("ip1");
    expect(limiter.isAllowed("ip1")).toBe(true);
  });

  it("clears all state", () => {
    const limiter = createRateLimiter({ maxAttempts: 1, windowMs: 60000 });
    limiter.isAllowed("ip1");
    limiter.isAllowed("ip2");
    expect(limiter.size).toBe(2);
    limiter.clear();
    expect(limiter.size).toBe(0);
    expect(limiter.isAllowed("ip1")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════
// PART 2: HTTP INTEGRATION TESTS — server.ts auth endpoints
// ═════════════════════════════════════════════════════════════════

/**
 * Spin up a minimal HTTP server that mirrors the auth logic from
 * server.ts. We don't import startDashboardServer directly because
 * it initializes storage, port binding, etc. Instead we create a
 * lightweight replica of JUST the auth layer.
 */

function createAuthTestServer(opts: {
  authUser: string;
  authPass: string;
  authEnabled?: boolean;
}) {
  const AUTH_USER = opts.authUser;
  const AUTH_PASS = opts.authPass;
  const AUTH_ENABLED = opts.authEnabled !== false;
  const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
  const activeSessions = new Map<string, number>();
  const authConfig: AuthConfig = {
    authEnabled: AUTH_ENABLED,
    authUser: AUTH_USER,
    authPass: AUTH_PASS,
    activeSessions,
  };
  const loginRateLimiter = createRateLimiter({
    maxAttempts: 5,
    windowMs: 60 * 1000,
  });

  function readBody(req: http.IncomingMessage): Promise<string> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    });
  }

  const server = http.createServer(async (req, res) => {
    // CORS
    if (AUTH_ENABLED) {
      const origin = req.headers.origin || "";
      if (origin) {
        res.setHeader("Access-Control-Allow-Origin", origin);
        res.setHeader("Access-Control-Allow-Credentials", "true");
      }
    } else {
      res.setHeader("Access-Control-Allow-Origin", "*");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }

    const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);

    // Login
    if (AUTH_ENABLED && reqUrl.pathname === "/api/auth/login" && req.method === "POST") {
      const clientIP = (req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
      if (!loginRateLimiter.isAllowed(clientIP)) {
        res.writeHead(429, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Too many login attempts. Try again later." }));
      }
      const body = await readBody(req);
      try {
        const { user, pass } = JSON.parse(body);
        if (safeCompare(user || "", AUTH_USER) && safeCompare(pass || "", AUTH_PASS)) {
          const token = generateToken();
          activeSessions.set(token, Date.now() + SESSION_TTL_MS);
          loginRateLimiter.reset(clientIP);
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie": `prism_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
          });
          return res.end(JSON.stringify({ ok: true }));
        }
      } catch { /* fall through */ }
      res.writeHead(401, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid credentials" }));
    }

    // Logout
    if (AUTH_ENABLED && reqUrl.pathname === "/api/auth/logout" && req.method === "POST") {
      const cookies = req.headers.cookie || "";
      const match = cookies.match(/prism_session=([a-f0-9]{64})/);
      if (match) {
        activeSessions.delete(match[1]);
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Set-Cookie": `prism_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // Auth gate
    if (AUTH_ENABLED && !(await isAuthenticated(req, authConfig))) {
      if (reqUrl.pathname.startsWith("/api/")) {
        res.writeHead(401, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Authentication required" }));
      }
      res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
      return res.end("<html><body>Login Page</body></html>");
    }

    // Protected resource (for testing auth gate pass-through)
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, path: reqUrl.pathname }));
  });

  return {
    server,
    activeSessions,
    loginRateLimiter,
    start: () =>
      new Promise<number>((resolve) => {
        server.listen(0, () => {
          const addr = server.address() as { port: number };
          resolve(addr.port);
        });
      }),
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ─── HTTP helper ──────────────────────────────────────────────────

interface FetchResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  json: () => any;
}

function httpRequest(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: string } = {},
): Promise<FetchResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body),
          });
        });
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// ─── Integration test suite ──────────────────────────────────────

describe("HTTP Auth Integration", () => {
  let testServer: ReturnType<typeof createAuthTestServer>;
  let port: number;

  beforeEach(async () => {
    // Fresh server for each test to avoid shared state
    if (testServer) await testServer.close().catch(() => {});
    testServer = createAuthTestServer({ authUser: "admin", authPass: "s3cret" });
    port = await testServer.start();
  });

  afterAll(async () => {
    if (testServer) await testServer.close().catch(() => {});
  });

  // ─── Login endpoint ───

  it("POST /api/auth/login — valid creds returns 200 + Set-Cookie", async () => {
    const res = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "s3cret" }),
    });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
    const setCookie = res.headers["set-cookie"]?.[0] || "";
    expect(setCookie).toContain("prism_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
  });

  it("POST /api/auth/login — invalid creds returns 401", async () => {
    const res = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "wrong" }),
    });
    expect(res.status).toBe(401);
    expect(res.json().error).toBe("Invalid credentials");
  });

  it("POST /api/auth/login — malformed JSON returns 401", async () => {
    const res = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: "not json at all!!!",
    });
    expect(res.status).toBe(401);
  });

  it("POST /api/auth/login — empty body returns 401", async () => {
    const res = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: "",
    });
    expect(res.status).toBe(401);
  });

  // ─── Auth gate ───

  it("Auth gate — blocks API requests without auth (401 JSON)", async () => {
    const res = await httpRequest(port, "GET", "/api/projects");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.json().error).toBe("Authentication required");
  });

  it("Auth gate — blocks page requests without auth (401 HTML)", async () => {
    const res = await httpRequest(port, "GET", "/");
    expect(res.status).toBe(401);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.body).toContain("Login Page");
  });

  it("Auth gate — allows requests with valid Basic Auth", async () => {
    const res = await httpRequest(port, "GET", "/api/projects", {
      headers: { authorization: basicAuth("admin", "s3cret") },
    });
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  // ─── Session cookie lifecycle ───

  it("Session lifecycle — login → use cookie → access protected resource", async () => {
    // Step 1: Login
    const loginRes = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "s3cret" }),
    });
    expect(loginRes.status).toBe(200);
    const cookie = loginRes.headers["set-cookie"]?.[0]?.split(";")[0] || "";
    expect(cookie).toContain("prism_session=");

    // Step 2: Use cookie to access protected resource
    const protectedRes = await httpRequest(port, "GET", "/api/projects", {
      headers: { cookie },
    });
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.json().ok).toBe(true);
  });

  // ─── Logout ───

  it("POST /api/auth/logout — invalidates session server-side", async () => {
    // Login
    const loginRes = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "s3cret" }),
    });
    const cookie = loginRes.headers["set-cookie"]?.[0]?.split(";")[0] || "";

    // Verify session works
    const beforeLogout = await httpRequest(port, "GET", "/api/projects", {
      headers: { cookie },
    });
    expect(beforeLogout.status).toBe(200);

    // Logout
    const logoutRes = await httpRequest(port, "POST", "/api/auth/logout", {
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(200);
    expect(logoutRes.json().ok).toBe(true);
    // Verify Set-Cookie clears the cookie (Max-Age=0)
    const logoutCookie = logoutRes.headers["set-cookie"]?.[0] || "";
    expect(logoutCookie).toContain("Max-Age=0");

    // Verify session is invalidated server-side
    const afterLogout = await httpRequest(port, "GET", "/api/projects", {
      headers: { cookie },
    });
    expect(afterLogout.status).toBe(401);
  });

  // ─── Rate limiting ───

  it("Rate limiting — blocks after 5 failed attempts in 60s", async () => {
    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const res = await httpRequest(port, "POST", "/api/auth/login", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "admin", pass: "wrong" }),
      });
      expect(res.status).toBe(401);
    }

    // 6th attempt should be rate limited
    const res = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "wrong" }),
    });
    expect(res.status).toBe(429);
    expect(res.json().error).toContain("Too many login attempts");
  });

  it("Rate limiting — resets counter after successful login", async () => {
    // Make 4 failed attempts (under the limit)
    for (let i = 0; i < 4; i++) {
      await httpRequest(port, "POST", "/api/auth/login", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: "admin", pass: "wrong" }),
      });
    }

    // Successful login should reset the counter
    const successRes = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "s3cret" }),
    });
    expect(successRes.status).toBe(200);

    // Should be able to make more attempts again
    const afterReset = await httpRequest(port, "POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user: "admin", pass: "wrong" }),
    });
    expect(afterReset.status).toBe(401); // Not 429 — counter was reset
  });

  // ─── CORS ───

  it("CORS — restricts origin when auth is enabled", async () => {
    const res = await httpRequest(port, "OPTIONS", "/api/projects", {
      headers: { origin: "http://localhost:8080" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:8080");
    expect(res.headers["access-control-allow-credentials"]).toBe("true");
  });

  it("CORS — no wildcard when auth is enabled and no origin header", async () => {
    const res = await httpRequest(port, "OPTIONS", "/api/projects");
    expect(res.status).toBe(204);
    // Without an Origin header, should NOT set Access-Control-Allow-Origin
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("HTTP Auth Disabled", () => {
  let testServer: ReturnType<typeof createAuthTestServer>;
  let port: number;

  beforeEach(async () => {
    if (testServer) await testServer.close().catch(() => {});
    testServer = createAuthTestServer({
      authUser: "",
      authPass: "",
      authEnabled: false,
    });
    port = await testServer.start();
  });

  afterAll(async () => {
    if (testServer) await testServer.close().catch(() => {});
  });

  it("Auth disabled — all requests pass through without credentials", async () => {
    const res = await httpRequest(port, "GET", "/api/projects");
    expect(res.status).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it("Auth disabled — page requests serve content (not login page)", async () => {
    const res = await httpRequest(port, "GET", "/");
    expect(res.status).toBe(200);
    expect(res.body).not.toContain("Login Page");
  });

  it("Auth disabled — CORS uses wildcard *", async () => {
    const res = await httpRequest(port, "OPTIONS", "/api/projects", {
      headers: { origin: "http://localhost:8080" },
    });
    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});
