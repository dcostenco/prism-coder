import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const state = vi.hoisted(() => {
    vi.resetModules();
    return { jwt: vi.fn<() => Promise<string | null>>() };
});
vi.mock("../../src/config.js", async importOriginal => ({
    ...await importOriginal<typeof import("../../src/config.js")>(),
    PRISM_SYNALUX_BASE_URL: undefined,
    PRISM_SYNALUX_API_KEY: undefined,
    SYNALUX_CONFIGURED: false,
}));
vi.mock("../../src/utils/synaluxJwt.js", () => ({ getSynaluxJwt: state.jwt, invalidateSynaluxJwt: vi.fn() }));
import { hydrateSynaluxCredentials, resolvePortalBaseUrl } from "../../src/utils/synaluxSearch.js";

import {
    _resetSecondReadPolicyForTest,
    getAnswerCheckPolicy,
    getClassifierInputPolicy,
    getSecondReadPolicy,
} from "../../src/utils/inferencePolicy.js";

const bytes = (name: string) => JSON.stringify(JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8")));
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const FIXTURE_PORTAL = "https://hydrated.portal.test";
const NEXT_PORTAL = "https://next.portal.test";
const CASES = [
    ["second read", "second-read-policy.synthetic.json", getSecondReadPolicy],
    ["answer check", "answer-check-policy.synthetic.json", getAnswerCheckPolicy],
    ["classifier input", "classifier-input-policy.synthetic.json", getClassifierInputPolicy],
] as const;
const hydrate = () => hydrateSynaluxCredentials(async (key, fallback) =>
    key === "PRISM_SYNALUX_BASE_URL" ? "http://hydrated.portal.test///" : fallback);

describe("inference policy runtime hydration", () => {
    beforeEach(() => {
        vi.stubEnv("PRISM_SYNALUX_BASE_URL", "");
        vi.stubEnv("SYNALUX_BASE_URL", "");
        vi.stubEnv("PRISM_SYNALUX_API_KEY", "");
        state.jwt.mockReset();
        state.jwt.mockResolvedValue("fixture-jwt");
        _resetSecondReadPolicyForTest();
    });
    afterEach(() => vi.unstubAllEnvs());

    it("refuses every policy before hydration without requesting a JWT or fetching", async () => {
        const fetchMock = vi.fn<typeof fetch>();
        for (const [, fixture, get] of CASES)
            expect(await get({ fetchImpl: fetchMock, expectSha256: sha(bytes(fixture)) })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(state.jwt).not.toHaveBeenCalled();
    });

    it.each(CASES)("loads %s from saved settings hydrated after module import", async (_name, fixture, get) => {
        const body = bytes(fixture), digest = sha(body);
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
        expect(await get({ fetchImpl: fetchMock, expectSha256: digest })).toBeNull();
        await hydrate();
        expect(resolvePortalBaseUrl()).toBe(FIXTURE_PORTAL);
        expect(await get({ fetchImpl: fetchMock, expectSha256: digest })).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${FIXTURE_PORTAL}/api/v1/prism/inference-policy/${digest}`,
            expect.objectContaining({ method: "GET", redirect: "error", headers: { Authorization: "Bearer fixture-jwt", Accept: "application/json" } }));
    });

    it("uses the admitted URL for the complete load even while JWT acquisition is pending", async () => {
        await hydrate();
        state.jwt.mockImplementationOnce(async () => {
            process.env.PRISM_SYNALUX_BASE_URL = NEXT_PORTAL;
            return "fixture-jwt";
        });
        const body = bytes("answer-check-policy.synthetic.json"), digest = sha(body);
        const fetchMock = vi.fn<typeof fetch>(async () => new Response(body, { status: 200 }));
        expect(await getAnswerCheckPolicy({ fetchImpl: fetchMock, expectSha256: digest })).not.toBeNull();
        expect(fetchMock.mock.calls[0][0]).toBe(`${FIXTURE_PORTAL}/api/v1/prism/inference-policy/${digest}`);
    });

    it("keeps refused artifacts unavailable after hydration", async () => {
        await hydrate();
        const fetchMock = vi.fn<typeof fetch>(async () => new Response("", { status: 403 }));
        expect(await getAnswerCheckPolicy({ fetchImpl: fetchMock })).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not fetch when the live portal setting is invalid", async () => {
        process.env.PRISM_SYNALUX_BASE_URL = "not a URL";
        const fetchMock = vi.fn<typeof fetch>();
        expect(await getAnswerCheckPolicy({ fetchImpl: fetchMock })).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
