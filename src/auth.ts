/**
 * Prism Cloud — Authentication Module (v2.0)
 * =============================================
 *
 * Handles OAuth login flow for Prism CLI:
 *   1. `prism login` → starts local HTTP server on random port
 *   2. Opens browser → Synalux OAuth page with redirect back to localhost
 *   3. Receives auth code → exchanges for JWT + refresh token
 *   4. Stores tokens in prism-config.db via configStorage
 *
 * Token management:
 *   - Auto-refresh expired JWTs using stored refresh token
 *   - `prism logout` → clears stored tokens
 *   - `prism status` → shows current auth state
 */

import { createServer } from 'http';
import { URL } from 'url';
import { setSetting, getSetting } from './storage/configStorage.js';
import { clearCloudCache } from './prism-cloud.js';

// ─── Config ───────────────────────────────────────────────────────

const SYNALUX_BASE = process.env.SYNALUX_API_BASE || 'https://synalux.ai';
const AUTH_CALLBACK_PATH = '/auth/callback';

// Config keys in prism-config.db
const KEY_AUTH_TOKEN = 'prism_auth_token';
const KEY_REFRESH_TOKEN = 'prism_refresh_token';
const KEY_AUTH_EMAIL = 'prism_auth_email';
const KEY_AUTH_PLAN = 'prism_auth_plan';
const KEY_AUTH_EXPIRES = 'prism_auth_expires';

// ─── Login Flow ───────────────────────────────────────────────────

export interface LoginResult {
    success: boolean;
    email?: string;
    plan?: string;
    error?: string;
}

/**
 * Start the OAuth login flow.
 * Opens default browser to Synalux login page, waits for callback.
 */
export async function login(): Promise<LoginResult> {
    return new Promise((resolve) => {
        // Start local server on random port
        const server = createServer(async (req, res) => {
            const url = new URL(req.url || '/', `http://localhost`);

            if (url.pathname !== AUTH_CALLBACK_PATH) {
                res.writeHead(404);
                res.end('Not found');
                return;
            }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            if (error) {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(renderHtml('Login Failed', `Error: ${error}. You can close this window.`));
                server.close();
                resolve({ success: false, error });
                return;
            }

            if (!code) {
                res.writeHead(400, { 'Content-Type': 'text/html' });
                res.end(renderHtml('Login Failed', 'No authorization code received. You can close this window.'));
                server.close();
                resolve({ success: false, error: 'No authorization code' });
                return;
            }

            try {
                // Exchange code for JWT
                const tokenResult = await exchangeCode(code);

                // Store tokens
                await setSetting(KEY_AUTH_TOKEN, tokenResult.access_token);
                if (tokenResult.refresh_token) {
                    await setSetting(KEY_REFRESH_TOKEN, tokenResult.refresh_token);
                }
                if (tokenResult.email) {
                    await setSetting(KEY_AUTH_EMAIL, tokenResult.email);
                }
                if (tokenResult.plan) {
                    await setSetting(KEY_AUTH_PLAN, tokenResult.plan);
                }
                if (tokenResult.expires_at) {
                    await setSetting(KEY_AUTH_EXPIRES, String(tokenResult.expires_at));
                }

                // Clear cached cloud limits so next verify call uses new token
                clearCloudCache();

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(renderHtml(
                    '✅ Prism Login Successful',
                    `Authenticated as <strong>${tokenResult.email}</strong> (${tokenResult.plan} plan). You can close this window.`
                ));
                server.close();
                resolve({
                    success: true,
                    email: tokenResult.email,
                    plan: tokenResult.plan,
                });
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(renderHtml('Login Failed', `Error: ${message}. You can close this window.`));
                server.close();
                resolve({ success: false, error: message });
            }
        });

        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (!addr || typeof addr === 'string') {
                resolve({ success: false, error: 'Failed to start local server' });
                return;
            }

            const port = addr.port;
            const callbackUrl = `http://127.0.0.1:${port}${AUTH_CALLBACK_PATH}`;
            const loginUrl = `${SYNALUX_BASE}/auth/prism-login?redirect_uri=${encodeURIComponent(callbackUrl)}`;

            console.log(`\n🔐 Opening browser for Synalux login...`);
            console.log(`   If the browser doesn't open, visit:\n   ${loginUrl}\n`);

            // Open browser (platform-agnostic)
            openBrowser(loginUrl);

            // Timeout after 5 minutes
            setTimeout(() => {
                server.close();
                resolve({ success: false, error: 'Login timed out (5 minutes)' });
            }, 5 * 60 * 1000);
        });
    });
}

// ─── Code Exchange ────────────────────────────────────────────────

interface TokenResponse {
    access_token: string;
    refresh_token?: string;
    email?: string;
    plan?: string;
    expires_at?: number;
}

async function exchangeCode(code: string): Promise<TokenResponse> {
    const response = await fetch(`${SYNALUX_BASE}/api/v1/auth/code-exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, client: 'prism-cli' }),
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Token exchange failed (${response.status}): ${text}`);
    }

    return response.json();
}

// ─── Token Refresh ────────────────────────────────────────────────

/**
 * Get a valid auth token, refreshing if expired.
 * Returns empty string if not logged in.
 */
export async function getAuthToken(): Promise<string> {
    const token = await getSetting(KEY_AUTH_TOKEN);
    if (!token) return '';

    // Check expiry
    const expiresStr = await getSetting(KEY_AUTH_EXPIRES);
    if (expiresStr) {
        const expiresAt = parseInt(expiresStr, 10);
        const now = Math.floor(Date.now() / 1000);
        if (now < expiresAt - 60) {
            // Token still valid (with 60s buffer)
            return token;
        }

        // Try to refresh
        const refreshToken = await getSetting(KEY_REFRESH_TOKEN);
        if (refreshToken) {
            try {
                const refreshed = await refreshAuthToken(refreshToken);
                await setSetting(KEY_AUTH_TOKEN, refreshed.access_token);
                if (refreshed.expires_at) {
                    await setSetting(KEY_AUTH_EXPIRES, String(refreshed.expires_at));
                }
                clearCloudCache();
                return refreshed.access_token;
            } catch {
                console.warn('[Prism Auth] Token refresh failed. Run `prism login` to re-authenticate.');
                return '';
            }
        }
    }

    return token;
}

async function refreshAuthToken(refreshToken: string): Promise<TokenResponse> {
    const response = await fetch(`${SYNALUX_BASE}/api/v1/auth/jwt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken, client: 'prism-cli' }),
    });

    if (!response.ok) {
        throw new Error(`Token refresh failed (${response.status})`);
    }

    return response.json();
}

// ─── Logout ───────────────────────────────────────────────────────

export async function logout(): Promise<void> {
    await setSetting(KEY_AUTH_TOKEN, '');
    await setSetting(KEY_REFRESH_TOKEN, '');
    await setSetting(KEY_AUTH_EMAIL, '');
    await setSetting(KEY_AUTH_PLAN, '');
    await setSetting(KEY_AUTH_EXPIRES, '');
    clearCloudCache();
}

// ─── Status ───────────────────────────────────────────────────────

export interface AuthStatus {
    loggedIn: boolean;
    email?: string;
    plan?: string;
    expiresAt?: Date;
}

export async function getAuthStatus(): Promise<AuthStatus> {
    const token = await getSetting(KEY_AUTH_TOKEN);
    if (!token) return { loggedIn: false };

    const email = await getSetting(KEY_AUTH_EMAIL);
    const plan = await getSetting(KEY_AUTH_PLAN);
    const expiresStr = await getSetting(KEY_AUTH_EXPIRES);

    return {
        loggedIn: true,
        email: email || undefined,
        plan: plan || undefined,
        expiresAt: expiresStr ? new Date(parseInt(expiresStr, 10) * 1000) : undefined,
    };
}

// ─── Helpers ──────────────────────────────────────────────────────

function renderHtml(title: string, body: string): string {
    return `<!DOCTYPE html>
<html><head><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a1a;color:#e0e0e0}
.card{background:#1a1a2e;border-radius:16px;padding:48px;max-width:480px;text-align:center;box-shadow:0 8px 32px rgba(0,0,0,.4)}
h1{font-size:24px;margin-bottom:16px}p{color:#a0a0b0;line-height:1.6}</style>
</head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

function openBrowser(url: string): void {
    const { exec } = require('child_process');
    const cmd = process.platform === 'darwin' ? 'open'
        : process.platform === 'win32' ? 'start'
            : 'xdg-open';
    exec(`${cmd} "${url}"`);
}
