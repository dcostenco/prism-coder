import { getSettingSync } from './storage/configStorage.js';

export interface PrismCloudLimits {
    tier: 'free' | 'standard' | 'advanced' | 'enterprise';
    status: 'active' | 'inactive' | 'trialing';
    limits: {
        llm_daily: number;
        search_daily: number;
        memory_sync: boolean;
        coder_daily: number;
    };
    usage: {
        llm_calls: number;
        search_calls: number;
        memory_calls: number;
        coder_calls: number;
    };
    features: {
        cloud_coder: boolean;
        cloud_memory: boolean;
        cloud_llm: boolean;
        cloud_search: boolean;
        hivemind: boolean;
        voice_video: boolean;
    };
}

const DEFAULT_LIMITS: PrismCloudLimits = {
    tier: 'free',
    status: 'active',
    limits: {
        llm_daily: 0,
        search_daily: 0,
        memory_sync: false,
        coder_daily: 0,
    },
    usage: {
        llm_calls: 0,
        search_calls: 0,
        memory_calls: 0,
        coder_calls: 0,
    },
    features: {
        cloud_coder: false,
        cloud_memory: false,
        cloud_llm: false,
        cloud_search: false,
        hivemind: false,
        voice_video: false,
    },
};

let cachedLimits: PrismCloudLimits | null = null;

/**
 * Verify cloud license via Synalux API (v2.0 — JWT Auth).
 *
 * Reads auth token from:
 *   1. PRISM_AUTH_TOKEN env var (set by `prism login`)
 *   2. prism_auth_token setting (stored by dashboard login)
 *   3. Legacy: PRISM_LICENSE_KEY (deprecated, returns guidance)
 *
 * Calls GET /api/v1/prism/verify with Bearer JWT.
 */
export async function verifyCloudLicense(): Promise<PrismCloudLimits> {
    if (cachedLimits) return cachedLimits;

    // v2.0: Read JWT auth token (set by `prism login` OAuth flow)
    const authToken = getSettingSync('prism_auth_token', process.env.PRISM_AUTH_TOKEN || '');

    // Legacy fallback: if user still has old license key, guide them to upgrade
    const legacyKey = getSettingSync('prism_license_key', process.env.PRISM_LICENSE_KEY || '');
    if (!authToken && legacyKey) {
        console.warn(
            '[Prism Cloud] License key auth is deprecated. Please run `prism login` to switch to OAuth.'
        );
        return DEFAULT_LIMITS;
    }

    if (!authToken) {
        console.warn('[Prism Cloud] No auth token found. Operating in Free tier. Run `prism login` to authenticate.');
        return DEFAULT_LIMITS;
    }

    try {
        const baseUrl = process.env.SYNALUX_API_BASE || 'https://synalux.ai';
        const response = await fetch(`${baseUrl}/api/v1/prism/verify`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${authToken}`,
                'Content-Type': 'application/json',
            },
        });

        if (!response.ok) {
            if (response.status === 401) {
                console.warn('[Prism Cloud] Auth token expired or invalid. Run `prism login` to re-authenticate.');
            } else {
                console.warn(`[Prism Cloud] Verification failed with status ${response.status}. Operating in Free tier.`);
            }
            return DEFAULT_LIMITS;
        }

        const data = await response.json();
        if (data.status === 'success') {
            cachedLimits = {
                tier: data.user.plan || 'free',
                status: 'active',
                limits: {
                    llm_daily: data.limits?.llm_daily || 0,
                    search_daily: data.limits?.search_daily || 0,
                    memory_sync: data.limits?.memory_sync || false,
                    coder_daily: data.limits?.coder_daily || 0,
                },
                usage: {
                    llm_calls: data.usage?.llm_calls || 0,
                    search_calls: data.usage?.search_calls || 0,
                    memory_calls: data.usage?.memory_calls || 0,
                    coder_calls: data.usage?.coder_calls || 0,
                },
                features: data.features || DEFAULT_LIMITS.features,
            };

            console.log(`[Prism Cloud] Verified ${cachedLimits.tier} license.`);
            return cachedLimits;
        } else {
            console.warn(`[Prism Cloud] Invalid response. Operating in Free tier.`);
            return DEFAULT_LIMITS;
        }
    } catch (error) {
        console.error(`[Prism Cloud] Error verifying license: ${error instanceof Error ? error.message : String(error)}`);
        return DEFAULT_LIMITS;
    }
}

export function getCloudLimits(): PrismCloudLimits {
    return cachedLimits || DEFAULT_LIMITS;
}

/**
 * Clear cached limits (e.g., after `prism login` sets new token).
 */
export function clearCloudCache(): void {
    cachedLimits = null;
}
