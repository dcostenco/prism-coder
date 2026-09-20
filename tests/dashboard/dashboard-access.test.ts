import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  dashboardAccessUrlPath,
  dashboardAccessRegistryPath,
  dashboardOpenSuccessMessage,
  dashboardOpenCommand,
  findRunningDashboardAccessState,
  isLocalDashboardRunning,
  openDashboardUrl,
  readDashboardAccessState,
  readDashboardAccessUrl,
  registerDashboardAccessUrl,
  writeDashboardAccessUrl,
} from "../../src/dashboard/dashboardAccess.js";
import {
  createDashboardProbeResponse,
  generateDashboardProbeKey,
} from "../../src/dashboard/dashboardProbe.js";

const tempHomes: string[] = [];
const servers: Server[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "prism-dashboard-access-"));
  tempHomes.push(home);
  return home;
}

afterEach(async () => {
  for (const home of tempHomes.splice(0)) rmSync(home, { recursive: true, force: true });
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("accountless local dashboard access", () => {
  it("stores the current local opener link in an owner-only file", () => {
    const home = tempHome();
    const url = "http://localhost:34123/?token=local-capability";

    const path = writeDashboardAccessUrl(url, home);

    expect(path).toBe(dashboardAccessUrlPath(home));
    expect(readDashboardAccessUrl(home)).toBe(url);
    expect(readDashboardAccessState(home).probeKey).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.each([
    "https://synalux.ai/?token=secret",
    "http://attacker.example:3000/?token=secret",
    "http://localhost:3000/other?token=secret",
    "http://localhost:3000/?next=https://attacker.example",
  ])("refuses to persist a non-local or unexpected opener link: %s", (url) => {
    expect(() => writeDashboardAccessUrl(url, tempHome())).toThrow("invalid");
  });

  it.skipIf(process.platform === "win32")("refuses a symlinked link file", () => {
    const home = tempHome();
    const directory = join(home, ".prism-mcp");
    const target = join(home, "outside");
    writeFileSync(target, "unchanged", "utf8");
    writeDashboardAccessUrl("http://localhost:3000/", home);
    rmSync(dashboardAccessUrlPath(home));
    symlinkSync(target, dashboardAccessUrlPath(home));

    expect(() => writeDashboardAccessUrl("http://localhost:3000/?token=x", home)).toThrow("regular file");
    expect(() => readDashboardAccessUrl(home)).toThrow("regular file");
    expect(existsSync(target)).toBe(true);
  });

  it("refuses a symlinked state directory instead of writing the token outside the home", () => {
    const home = tempHome();
    const outside = tempHome();
    symlinkSync(outside, join(home, ".prism-mcp"), process.platform === "win32" ? "junction" : "dir");

    expect(() => writeDashboardAccessUrl("http://localhost:3000/?token=x", home)).toThrow("regular directory");
    expect(existsSync(join(outside, "dashboard.url"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("refuses a link file readable by other users", () => {
    const home = tempHome();
    const path = writeDashboardAccessUrl("http://localhost:3000/?token=x", home);
    chmodSync(path, 0o644);
    expect(() => readDashboardAccessUrl(home)).toThrow("permissions are unsafe");
  });

  it("opens with a platform executable and never a shell", () => {
    const url = "http://localhost:3000/?token=x";
    expect(dashboardOpenCommand(url, "darwin")).toEqual({ command: "open", args: [url] });
    expect(dashboardOpenCommand(url, "linux")).toEqual({ command: "xdg-open", args: [url] });
    expect(dashboardOpenCommand(url, "win32")).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", url],
    });

    const runner = vi.fn(() => ({ status: 0, error: undefined }));
    openDashboardUrl(url, "darwin", runner);
    expect(runner).toHaveBeenCalledWith("open", [url]);
  });

  it("describes the opened dashboard without replacing the linked account or plan", () => {
    expect(dashboardOpenSuccessMessage()).toBe(
      "Opened the current local Prism dashboard in your default browser. Your Synalux account and plan are unchanged.",
    );
  });

  it("falls back to a surviving dashboard when the newest registered instance is dead", async () => {
    const home = tempHome();
    const olderKey = generateDashboardProbeKey();
    const newerKey = generateDashboardProbeKey();
    const older = registerDashboardAccessUrl(
      "http://localhost:3010/?token=older-capability",
      home,
      olderKey,
      { instanceId: "a".repeat(32), registeredAtMs: 1_000, pid: 2_000_000_001 },
    );
    const newer = registerDashboardAccessUrl(
      "http://localhost:3011/?token=newer-capability",
      home,
      newerKey,
      { instanceId: "b".repeat(32), registeredAtMs: 2_000, pid: 2_000_000_002 },
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input));
      if (requested.port === "3011") return new Response("offline", { status: 503 });
      const nonce = requested.searchParams.get("nonce") || "";
      return new Response(JSON.stringify({
        name: "Prism Mind Palace",
        nonce,
        proof: createDashboardProbeResponse(olderKey, nonce),
      }), { status: 200 });
    });

    await expect(findRunningDashboardAccessState(home, fetcher)).resolves.toMatchObject({
      url: "http://localhost:3010/?token=older-capability",
      probeKey: olderKey,
    });
    expect(existsSync(older.recordPath)).toBe(true);
    expect(existsSync(newer.recordPath)).toBe(false);
    expect(fetcher.mock.calls.map(([input]) => new URL(String(input)).port)).toEqual(["3011", "3010"]);
  });

  it("unregisters only the dashboard instance that owns the registration", () => {
    const home = tempHome();
    const first = registerDashboardAccessUrl(
      "http://localhost:3020/?token=first-capability",
      home,
      generateDashboardProbeKey(),
      { instanceId: "c".repeat(32), registeredAtMs: 1_000, pid: 2_000_000_003 },
    );
    const second = registerDashboardAccessUrl(
      "http://localhost:3021/?token=second-capability",
      home,
      generateDashboardProbeKey(),
      { instanceId: "d".repeat(32), registeredAtMs: 2_000, pid: 2_000_000_004 },
    );

    first.unregister();
    first.unregister();

    expect(existsSync(first.recordPath)).toBe(false);
    expect(existsSync(second.recordPath)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(second.recordPath).mode & 0o777).toBe(0o600);
      expect(statSync(dashboardAccessRegistryPath(home)).mode & 0o777).toBe(0o700);
    }
  });

  it("authenticates the listener without transmitting the dashboard capability or probe key", async () => {
    const probeKey = generateDashboardProbeKey();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input));
      const nonce = requested.searchParams.get("nonce") || "";
      return new Response(JSON.stringify({
        name: "Prism Mind Palace",
        nonce,
        proof: createDashboardProbeResponse(probeKey, nonce),
      }), { status: 200 });
    });
    await expect(
      isLocalDashboardRunning("http://localhost:3012/?token=local-secret", probeKey, fetcher),
    ).resolves.toBe(true);
    const requested = new URL(String(fetcher.mock.calls[0][0]));
    expect(requested.pathname).toBe("/api/dashboard/probe");
    expect(requested.search).not.toContain("local-secret");
    expect(requested.search).not.toContain(probeKey);
    expect(requested.searchParams.get("nonce")).toMatch(/^[a-f0-9]{64}$/);
    expect(requested.searchParams.get("proof")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a foreign listener that copies the exact Prism identity and reflects the request proof", async () => {
    const probeKey = generateDashboardProbeKey();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input));
      return new Response(JSON.stringify({
        name: "Prism Mind Palace",
        nonce: requested.searchParams.get("nonce"),
        proof: requested.searchParams.get("proof"),
      }), { status: 200 });
    });
    await expect(
      isLocalDashboardRunning("http://localhost:3012/?token=local-secret", probeKey, fetcher),
    ).resolves.toBe(false);
  });

  it("rejects a manifest probe that redirects to another local listener", async () => {
    const target = createServer((_req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "Prism Mind Palace" }));
    });
    servers.push(target);
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
    const targetAddress = target.address();
    if (!targetAddress || typeof targetAddress === "string") throw new Error("Missing target port");

    const redirector = createServer((_req, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${targetAddress.port}/manifest.json` });
      res.end();
    });
    servers.push(redirector);
    await new Promise<void>((resolve) => redirector.listen(0, "127.0.0.1", resolve));
    const redirectAddress = redirector.address();
    if (!redirectAddress || typeof redirectAddress === "string") throw new Error("Missing redirect port");

    await expect(
      isLocalDashboardRunning(
        `http://127.0.0.1:${redirectAddress.port}/?token=local-secret`,
        generateDashboardProbeKey(),
      ),
    ).resolves.toBe(false);
  });
});
