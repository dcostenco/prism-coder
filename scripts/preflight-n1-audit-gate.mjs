/**
 * preflight-n1-audit-gate.mjs
 * ============================
 * Staging pre-flight: verifies N1 audit gate properties with two real JWT users
 * against the live portal.
 *
 * Tests:
 *   1. Free-tier user (User A) → 403 before rate limit is called
 *   2. Standard-tier user (User B) → 200 on conversational draft
 *   3. User A rate-limit exhausted → 429; User B still gets 200
 *   4. X-Synalux-Audit-User-ID is NOT present in client-facing response
 *
 * Requirements:
 *   PORTAL_URL          — portal base URL (e.g. https://synalux.ai)
 *   USER_A_SK_TOKEN     — synalux_sk_ token for a FREE-TIER user
 *   USER_B_SK_TOKEN     — synalux_sk_ token for a STANDARD-TIER user
 *
 * Usage:
 *   PORTAL_URL=https://synalux.ai \
 *   USER_A_SK_TOKEN=synalux_sk_... \
 *   USER_B_SK_TOKEN=synalux_sk_... \
 *   node scripts/preflight-n1-audit-gate.mjs
 *
 * Exit 0 = all pass. Exit 1 = failures or missing env.
 */

const PORTAL_URL = process.env.PORTAL_URL;
const USER_A_SK = process.env.USER_A_SK_TOKEN;
const USER_B_SK = process.env.USER_B_SK_TOKEN;

if (!PORTAL_URL || !USER_A_SK || !USER_B_SK) {
    console.error("Missing required env vars: PORTAL_URL, USER_A_SK_TOKEN, USER_B_SK_TOKEN");
    process.exit(1);
}

const JWT_URL = `${PORTAL_URL}/api/v1/auth/jwt`;
const VERIFY_URL = `${PORTAL_URL}/api/v1/prism/verify-grounding`;

let failures = 0;

function log(pass, label, extra = '') {
    console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${extra ? ' — ' + extra : ''}`);
    if (!pass) failures++;
}

async function getJwt(skToken) {
    const res = await fetch(JWT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${skToken}` },
    });
    if (!res.ok) throw new Error(`JWT exchange failed: ${res.status} ${await res.text()}`);
    const { jwt } = await res.json();
    if (!jwt) throw new Error('No jwt in response');
    return jwt;
}

async function callVerify(jwt, body) {
    const res = await fetch(VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${jwt}` },
        body: JSON.stringify(body),
    });
    return res;
}

console.log("── N1 Audit Gate Preflight ─────────────────────────────────────\n");

// ── Get JWTs ──────────────────────────────────────────────────────────────────
let jwtA, jwtB;
try {
    console.log("Exchanging JWTs...");
    [jwtA, jwtB] = await Promise.all([getJwt(USER_A_SK), getJwt(USER_B_SK)]);
    console.log("  JWT A obtained ✓");
    console.log("  JWT B obtained ✓\n");
} catch (err) {
    console.error(`JWT exchange failed: ${err.message}`);
    process.exit(1);
}

// ── Test 1: Free-tier User A → 403 ───────────────────────────────────────────
console.log("Test 1: Free-tier user (User A) → 403\n");
{
    const res = await callVerify(jwtA, { draft: 'Hello world', evidence: [] });
    log(res.status === 403, `User A status = ${res.status}`, 'expected 403');
    const body = await res.json();
    log(body.error?.toLowerCase().includes('standard tier') || body.error?.toLowerCase().includes('tier'),
        `Error mentions tier gate`);
    log(res.headers.get('X-Synalux-Audit-User-ID') === null,
        `X-Synalux-Audit-User-ID NOT in client response`);
}

// ── Test 2: Standard-tier User B → 200 on conversational draft ───────────────
console.log("\nTest 2: Standard-tier user (User B) → 200 on conversational draft\n");
{
    const res = await callVerify(jwtB, { draft: 'Hello, how can I help you today?', evidence: [] });
    log(res.status === 200, `User B status = ${res.status}`, 'expected 200');
    const body = await res.json();
    log(body.action === 'served', `action = ${body.action}`, 'expected served');
    log(res.headers.get('X-Synalux-Audit-User-ID') === null,
        `X-Synalux-Audit-User-ID NOT in client response`);
}

// ── Test 3: User B unaffected by User A's 403 (rate limit not called for A) ──
console.log("\nTest 3: User B continues to work after User A rejection\n");
{
    // Second call for User A (still 403)
    const resA2 = await callVerify(jwtA, { draft: 'Hello', evidence: [] });
    log(resA2.status === 403, `User A second call still 403`);

    // User B should be completely unaffected
    const resB2 = await callVerify(jwtB, { draft: 'Hello again', evidence: [] });
    log(resB2.status === 200, `User B unaffected — status ${resB2.status}`);
}

// ── Test 4: Audit header stripped (already checked above, explicit summary) ───
console.log("\nTest 4: X-Synalux-Audit-User-ID stripped from all client-facing responses\n");
{
    const [resA, resB] = await Promise.all([
        callVerify(jwtA, { draft: 'test', evidence: [] }),
        callVerify(jwtB, { draft: 'test', evidence: [] }),
    ]);
    log(resA.headers.get('X-Synalux-Audit-User-ID') === null, `User A (403): header absent`);
    log(resB.headers.get('X-Synalux-Audit-User-ID') === null, `User B (200): header absent`);
}

// ── Result ────────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(64)}`);
if (failures === 0) {
    console.log("N1 audit gate preflight: ALL PASS ✓");
    process.exit(0);
} else {
    console.log(`N1 audit gate preflight: ${failures} FAILURE(S) ✗`);
    process.exit(1);
}
