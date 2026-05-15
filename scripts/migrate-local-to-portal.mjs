#!/usr/bin/env node
/**
 * Migrate session data from local ~/.prism-mcp/data.db to synalux portal.
 *
 * Reads session_ledger + session_handoffs from the local SQLite DB
 * and pushes each entry through the portal's /api/v1/prism/memory endpoint.
 *
 * Usage:
 *   node scripts/migrate-local-to-portal.mjs [--dry-run] [--project=prism-mcp]
 */

// Uses @libsql/client (already a dep) instead of better-sqlite3 — keeps the
// migration script runnable from a fresh checkout without adding a heavy
// native compile-on-install dep just for a one-shot tool.
import { createClient } from '@libsql/client';
import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const DRY_RUN = process.argv.includes('--dry-run');
const PROJECT_FILTER = process.argv.find(a => a.startsWith('--project='))?.split('=')[1] || null;
const SKIP_SCHOLAR = !process.argv.includes('--include-scholar');

const DB_PATH = join(homedir(), '.prism-mcp', 'data.db');
const PORTAL_URL = process.env.PRISM_SYNALUX_BASE_URL || 'https://synalux.ai';
const API_KEY = process.env.PRISM_SYNALUX_API_KEY;

if (!API_KEY) {
    // Try reading from prism .env
    try {
        const envContent = readFileSync(join(homedir(), 'prism', '.env'), 'utf8');
        const match = envContent.match(/^PRISM_SYNALUX_API_KEY=(.+)$/m);
        if (match) process.env.PRISM_SYNALUX_API_KEY = match[1].trim();
    } catch {}
}

const REFRESH_TOKEN = process.env.PRISM_SYNALUX_API_KEY;
if (!REFRESH_TOKEN) {
    console.error('Missing PRISM_SYNALUX_API_KEY');
    process.exit(1);
}

let cachedJwt = null;
let jwtExpiresAt = 0;

async function getJwt() {
    if (cachedJwt && Date.now() < jwtExpiresAt - 60000) return cachedJwt;
    const res = await fetch(`${PORTAL_URL}/api/v1/auth/jwt`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${REFRESH_TOKEN}`, 'X-Prism-Client': 'migration-script' },
    });
    const data = await res.json();
    if (!data.jwt) throw new Error(`JWT exchange failed: ${data.error || res.status}`);
    cachedJwt = data.jwt;
    jwtExpiresAt = Date.now() + (data.expires_in || 900) * 1000;
    return cachedJwt;
}

async function portalPost(body) {
    const jwt = await getJwt();
    const res = await fetch(`${PORTAL_URL}/api/v1/prism/memory`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwt}`,
            'Content-Type': 'application/json',
            'X-Prism-Client': 'migration-script',
        },
        body: JSON.stringify(body),
    });
    return res.json();
}

function parseJsonField(val) {
    if (!val) return [];
    try { return JSON.parse(val); } catch { return []; }
}

async function main() {
    const db = createClient({ url: `file:${DB_PATH}` });

    // --- Ledger entries ---
    let ledgerQuery = 'SELECT * FROM session_ledger WHERE deleted_at IS NULL';
    const params = [];
    if (PROJECT_FILTER) {
        ledgerQuery += ' AND project = ?';
        params.push(PROJECT_FILTER);
    }
    if (SKIP_SCHOLAR) {
        ledgerQuery += ' AND project != ?';
        params.push('prism-scholar');
    }
    ledgerQuery += ' ORDER BY created_at ASC';

    const ledgerRows = (await db.execute({ sql: ledgerQuery, args: params })).rows;
    console.log(`Ledger entries to migrate: ${ledgerRows.length}${DRY_RUN ? ' (DRY RUN)' : ''}`);

    let ledgerOk = 0, ledgerFail = 0;
    for (const row of ledgerRows) {
        const payload = {
            action: 'save_ledger',
            project: row.project,
            summary: row.summary || row.title || '(no summary)',
            conversation_id: row.conversation_id || undefined,
            decisions: parseJsonField(row.decisions),
            todos: parseJsonField(row.todos),
            files_changed: parseJsonField(row.files_changed),
            event_type: row.event_type || 'session',
            confidence_score: row.confidence_score ?? undefined,
        };

        if (DRY_RUN) {
            console.log(`  [DRY] ledger: project=${row.project} summary=${(payload.summary || '').slice(0, 60)}...`);
            ledgerOk++;
            continue;
        }

        try {
            const result = await portalPost(payload);
            if (result.status === 'success') {
                ledgerOk++;
                if (ledgerOk % 50 === 0) console.log(`  ... ${ledgerOk}/${ledgerRows.length} ledger entries migrated`);
            } else {
                ledgerFail++;
                console.error(`  FAIL ledger ${row.id}: ${result.error}`);
            }
        } catch (err) {
            ledgerFail++;
            console.error(`  ERROR ledger ${row.id}: ${err.message}`);
        }
        // Rate limit: small delay to avoid quota issues
        if (ledgerOk % 10 === 0) await new Promise(r => setTimeout(r, 100));
    }
    console.log(`Ledger: ${ledgerOk} migrated, ${ledgerFail} failed`);

    // --- Handoffs ---
    let handoffQuery = 'SELECT * FROM session_handoffs';
    const hParams = [];
    if (PROJECT_FILTER) {
        handoffQuery += ' WHERE project = ?';
        hParams.push(PROJECT_FILTER);
    }
    handoffQuery += ' ORDER BY updated_at ASC';

    const handoffRows = (await db.execute({ sql: handoffQuery, args: hParams })).rows;
    console.log(`\nHandoffs to migrate: ${handoffRows.length}${DRY_RUN ? ' (DRY RUN)' : ''}`);

    let handoffOk = 0, handoffFail = 0;
    for (const row of handoffRows) {
        const payload = {
            action: 'save_handoff',
            project: row.project,
            last_summary: row.last_summary || '(no summary)',
            open_todos: parseJsonField(row.pending_todo),
            active_decisions: parseJsonField(row.active_decisions),
            keywords: parseJsonField(row.keywords),
            key_context: row.key_context || undefined,
            active_branch: row.active_branch || undefined,
            role: row.role || 'global',
        };

        if (DRY_RUN) {
            console.log(`  [DRY] handoff: project=${row.project}`);
            handoffOk++;
            continue;
        }

        try {
            const result = await portalPost(payload);
            if (result.status === 'success') {
                handoffOk++;
                console.log(`  handoff: ${row.project} → v${result.result?.version || '?'}`);
            } else {
                handoffFail++;
                console.error(`  FAIL handoff ${row.project}: ${result.error}`);
            }
        } catch (err) {
            handoffFail++;
            console.error(`  ERROR handoff ${row.project}: ${err.message}`);
        }
    }
    console.log(`Handoffs: ${handoffOk} migrated, ${handoffFail} failed`);

    await db.close();
    console.log('\nMigration complete.');
}

main().catch(err => {
    console.error('Migration failed:', err.message);
    process.exit(1);
});
