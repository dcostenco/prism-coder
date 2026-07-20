/**
 * §5.5 — entitlements provenance (source field) + no-cache-on-fallback.
 *
 * The v1 review's "FREE-default hole": a paid user whose portal resolution
 * fails silently gets free-tier clamps. The source field makes that state
 * observable ("fallback_free" ≠ "the portal says free"), and fallback_free
 * results are never cached so the next call retries.
 *
 * SYNALUX_CONFIGURED / getSynaluxJwt are module-mocked to steer each
 * resolution path deterministically.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockConfig = vi.hoisted(() => ({ configured: true }));
vi.mock("../src/config.js", async (importOriginal) => {
    const orig = await importOriginal<Record<string, unknown>>();
    return {
        ...orig,
        get SYNALUX_CONFIGURED() { return mockConfig.configured; },
        PRISM_SYNALUX_BASE_URL: "https://portal.test",
    };
});

const mockJwt = vi.hoisted(() => ({ value: "test-jwt" as string | null }));
vi.mock("../src/utils/synaluxJwt.js", () => ({
    getSynaluxJwt: vi.fn(async () => mockJwt.value),
}));

import {
    getEntitlements,
    FREE_ENTITLEMENTS,
    _resetEntitlementsForTest,
} from "../src/utils/entitlements.js";

const PORTAL_STANDARD = {
    plan: "standard",
    model_ceiling: "9b",
    daily_infer_limit: 200,
    max_tokens: 1024,
    max_seats: 1,
    features: {
        cloud_fallback: true,
        grounding_verifier: true,
        knowledge_search_unlimited: true,
        session_memory_unlimited: true,
        analytics_dashboard: true,
    },
    upgrade_url: "https://synalux.ai/pricing",
};

function portalRespondsWith(body: unknown, status = 200) {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify(body), { status }) as unknown as Awaited<ReturnType<typeof fetch>>,
    );
}

beforeEach(() => {
    _resetEntitlementsForTest();
    mockConfig.configured = true;
    mockJwt.value = "test-jwt";
    vi.restoreAllMocks();
});

describe("entitlements source (§5.5)", () => {
    it("real portal data gets source='portal' — including a portal-confirmed FREE plan", async () => {
        portalRespondsWith({ ...FREE_ENTITLEMENTS, plan: "free" });
        const ent = await getEntitlements();
        expect(ent.plan).toBe("free");
        expect(ent.source).toBe("portal"); // portal-free ≠ fallback-free
    });

    it("paid portal plan gets source='portal'", async () => {
        portalRespondsWith(PORTAL_STANDARD);
        const ent = await getEntitlements();
        expect(ent.plan).toBe("standard");
        expect(ent.source).toBe("portal");
    });

    it("unconfigured machine gets source='unconfigured' (legit free, not a degradation)", async () => {
        mockConfig.configured = false;
        const ent = await getEntitlements();
        expect(ent.plan).toBe("free");
        expect(ent.source).toBe("unconfigured");
    });

    it("recognizes credentials injected after config module initialization", async () => {
        mockConfig.configured = false;
        process.env.PRISM_SYNALUX_BASE_URL = "https://runtime.synalux.test";
        process.env.PRISM_SYNALUX_API_KEY = "synalux_sk_runtime";
        try {
            const request = portalRespondsWith(PORTAL_STANDARD);
            const ent = await getEntitlements();

            expect(ent.plan).toBe("standard");
            expect(ent.source).toBe("portal");
            expect(request).toHaveBeenCalledWith(
                "https://runtime.synalux.test/api/v1/prism/entitlements",
                expect.any(Object),
            );
        } finally {
            delete process.env.PRISM_SYNALUX_BASE_URL;
            delete process.env.PRISM_SYNALUX_API_KEY;
        }
    });

    it("configured but JWT exchange fails → source='fallback_free'", async () => {
        mockJwt.value = null;
        const ent = await getEntitlements();
        expect(ent.plan).toBe("free");
        expect(ent.source).toBe("fallback_free");
    });

    it("configured but portal fetch throws (cold start, no cache) → source='fallback_free'", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
        const ent = await getEntitlements();
        expect(ent.source).toBe("fallback_free");
    });

    it("portal HTTP error with a cached plan keeps last-known-good (source='portal'), not fallback", async () => {
        portalRespondsWith(PORTAL_STANDARD);
        const first = await getEntitlements();
        expect(first.source).toBe("portal");

        _resetEntitlementsForTest();
        portalRespondsWith(PORTAL_STANDARD);
        await getEntitlements(); // seed cache
        vi.restoreAllMocks();
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
        // cache still valid → served from cache without a fetch
        const ent = await getEntitlements();
        expect(ent.plan).toBe("standard");
        expect(ent.source).toBe("portal");
    });

    it("fallback_free never enters the 5-min cache — portal retried after the short negative window", async () => {
        vi.useFakeTimers();
        try {
            vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
            const first = await getEntitlements();
            expect(first.source).toBe("fallback_free");

            vi.restoreAllMocks();
            const recovered = portalRespondsWith(PORTAL_STANDARD);

            // Within the 25s negative window: no portal re-attempt, still fallback.
            vi.advanceTimersByTime(5_000);
            const during = await getEntitlements();
            expect(during.source).toBe("fallback_free");
            expect(recovered).not.toHaveBeenCalled();

            // After the window: retried immediately — NOT pinned for the 5-min TTL.
            vi.advanceTimersByTime(21_000); // t = 26s
            const after = await getEntitlements();
            expect(after.plan).toBe("standard");
            expect(after.source).toBe("portal");
        } finally {
            vi.useRealTimers();
        }
    });

    it("outage amplification is capped: sequential calls inside the negative window make ZERO portal attempts", async () => {
        vi.useFakeTimers();
        try {
            const failing = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
            await getEntitlements();
            const attemptsAfterFirst = failing.mock.calls.length;
            for (let i = 0; i < 5; i++) {
                vi.advanceTimersByTime(1_000);
                const ent = await getEntitlements();
                expect(ent.source).toBe("fallback_free");
            }
            expect(failing.mock.calls.length).toBe(attemptsAfterFirst);
        } finally {
            vi.useRealTimers();
        }
    });
});
