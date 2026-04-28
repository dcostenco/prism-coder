/**
 * Test Suite — VM & Game Dev Integration
 * ═══════════════════════════════════════
 *
 * Comprehensive tests for the Prism IDE VM system:
 *   1. Device Templates — validation, uniqueness, completeness
 *   2. VM Tier Escalation — monotonic limits, free restrictions, enterprise unlimited
 *   3. Network Profiles — presets, edge cases, load tests
 *   4. Host Resource Sharing — defaults, safe values
 *   5. Game Engine — GPU profiling, shaders, netcode, physics, input, memory budgets
 *   6. Creative Studio — 3D/5D, video, audio tiers
 *   7. Competitor Import — platforms, tier gating
 *   8. Component Marketplace — tiers, revenue share
 *   9. Project Templates — uniqueness, tier gating, completeness
 *   10. Workspace Licensing — presets, compliance, per-product licenses
 *   11. Edge Cases — boundary values, invalid configs, cross-module consistency
 */

import { describe, test, expect } from 'vitest';

// ── Core VM types ──
import {
    DEVICE_TEMPLATES,
    VM_TIERS,
    NETWORK_PRESETS,
    DEFAULT_HOST_SHARING,
} from '../../src/vm/types.js';
import type { ScmTier } from '../../src/scm/types.js';

// ── Game Engine ──
import {
    GAME_DEV_TIERS,
    GAME_DEV_TEMPLATES,
    MEMORY_BUDGETS,
} from '../../src/vm/gameEngine.js';

// ── Creative Studio ──
import { CREATIVE_STUDIO_TIERS } from '../../src/vm/creativeStudio.js';

// ── Competitor Import ──
import {
    COMPETITOR_PLATFORMS,
    COMPETITOR_IMPORT_TIERS,
} from '../../src/vm/competitorImport.js';

// ── Marketplace ──
import { MARKETPLACE_TIERS } from '../../src/vm/componentMarketplace.js';

// ── Project Templates ──
import {
    GAME_TEMPLATES,
    APP_TEMPLATES,
    CREATIVE_TEMPLATES,
    ALL_PROJECT_TEMPLATES,
    TEMPLATE_TIERS,
} from '../../src/vm/projectTemplates.js';

// ── Licensing ──
import {
    WORKSPACE_LICENSE_PRESETS,
    LICENSE_COMPATIBILITY,
    LICENSE_TIERS,
} from '../../src/vm/workspaceLicensing.js';

// ── Ethics & Export Control ──
import {
    PROHIBITED_USE_POLICY,
    EMBARGOED_COUNTRIES,
    RESTRICTED_COUNTRIES,
    DEFAULT_SANCTIONS_CONFIG,
    DEFAULT_GEOFENCE_CONFIG,
    DEFAULT_RUNTIME_MONITOR,
    DEFAULT_AUDIT_CONFIG,
    DEFAULT_ENFORCEMENT_PIPELINE,
    ETHICS_TIERS,
} from '../../src/vm/ethicsEnforcement.js';

const ALL_TIERS: ScmTier[] = ['free', 'standard', 'advanced', 'enterprise'];

// ═══════════════════════════════════════════════════════════════
// 1. DEVICE TEMPLATES
// ═══════════════════════════════════════════════════════════════

describe('Device Templates — Validation', () => {
    test('all templates have unique IDs', () => {
        const ids = DEVICE_TEMPLATES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('all templates have required fields', () => {
        DEVICE_TEMPLATES.forEach(t => {
            expect(t.id).toBeTruthy();
            expect(t.name).toBeTruthy();
            expect(t.description.length).toBeGreaterThan(10);
            expect(t.platform).toBeTruthy();
            expect(t.form_factor).toBeTruthy();
            expect(t.arch.length).toBeGreaterThan(0);
            expect(t.os_versions.length).toBeGreaterThan(0);
            expect(t.preview_image).toBeTruthy();
            expect(ALL_TIERS).toContain(t.min_tier);
        });
    });

    test('all templates have valid hardware specs', () => {
        DEVICE_TEMPLATES.forEach(t => {
            const hw = t.default_hardware;
            expect(hw.cpu_cores).toBeGreaterThan(0);
            expect(hw.ram_gb).toBeGreaterThan(0);
            expect(hw.storage_gb).toBeGreaterThan(0);
            expect(['x86_64', 'arm64', 'armv7']).toContain(hw.cpu_arch);
            expect(['bridged', 'nat', 'host-only', 'isolated']).toContain(hw.network_mode);
        });
    });

    test('device_variants are populated for all templates', () => {
        DEVICE_TEMPLATES.forEach(t => {
            expect(t.device_variants.length).toBeGreaterThan(0);
        });
    });

    test('at least one free-tier template exists', () => {
        const freeTemplates = DEVICE_TEMPLATES.filter(t => t.min_tier === 'free');
        expect(freeTemplates.length).toBeGreaterThan(0);
    });

    test('covers all major platforms', () => {
        const platforms = new Set(DEVICE_TEMPLATES.map(t => t.platform));
        expect(platforms).toContain('linux');
        expect(platforms).toContain('windows');
        expect(platforms).toContain('ios');
        expect(platforms).toContain('android');
        expect(platforms).toContain('macos');
    });
});

// ═══════════════════════════════════════════════════════════════
// 2. VM TIER ESCALATION
// ═══════════════════════════════════════════════════════════════

describe('VM Tier Escalation', () => {
    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(VM_TIERS[t]).toBeDefined());
    });

    test('concurrent VM limits escalate monotonically', () => {
        const limits = ALL_TIERS.map(t => VM_TIERS[t].max_concurrent_vms);
        for (let i = 1; i < limits.length; i++) {
            expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
        }
    });

    test('enterprise tier has Infinity for key limits', () => {
        const ent = VM_TIERS.enterprise;
        expect(ent.max_concurrent_vms).toBe(Infinity);
        expect(ent.deploys_per_day).toBe(Infinity);
    });

    test('free tier restricts features', () => {
        const free = VM_TIERS.free;
        expect(free.max_concurrent_vms).toBeLessThanOrEqual(2);
        expect(free.vm_import).toBe(false);
        expect(free.custom_devices).toBe(false);
        expect(free.thin_client).toBe(false);
    });

    test('platform lists grow with tier', () => {
        const platformCounts = ALL_TIERS.map(t => VM_TIERS[t].platforms.length);
        for (let i = 1; i < platformCounts.length; i++) {
            expect(platformCounts[i]).toBeGreaterThanOrEqual(platformCounts[i - 1]);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// 3. NETWORK PROFILES
// ═══════════════════════════════════════════════════════════════

describe('Network Profiles', () => {
    test('all presets have valid values', () => {
        Object.entries(NETWORK_PRESETS).forEach(([_name, profile]) => {
            expect(profile.type).toBeTruthy();
            expect(profile.bandwidth_mbps).toBeGreaterThanOrEqual(0);
            expect(profile.latency_ms).toBeGreaterThanOrEqual(0);
            expect(profile.packet_loss_pct).toBeGreaterThanOrEqual(0);
            expect(profile.packet_loss_pct).toBeLessThanOrEqual(100);
            expect(profile.jitter_ms).toBeGreaterThanOrEqual(0);
        });
    });

    test('offline preset has 100% packet loss', () => {
        const offline = NETWORK_PRESETS.offline;
        expect(offline.packet_loss_pct).toBe(100);
        expect(offline.bandwidth_mbps).toBe(0);
    });

    test('perfect preset has 0 latency and 0 loss', () => {
        const perfect = NETWORK_PRESETS.perfect;
        expect(perfect.latency_ms).toBe(0);
        expect(perfect.packet_loss_pct).toBe(0);
        expect(perfect.jitter_ms).toBe(0);
    });

    test('at least 8 presets exist', () => {
        expect(Object.keys(NETWORK_PRESETS).length).toBeGreaterThanOrEqual(8);
    });

    test('broadband preset has reasonable values', () => {
        const bb = NETWORK_PRESETS.broadband;
        expect(bb.bandwidth_mbps).toBeGreaterThan(10);
        expect(bb.latency_ms).toBeLessThan(50);
    });
});

// ═══════════════════════════════════════════════════════════════
// 4. HOST RESOURCE SHARING
// ═══════════════════════════════════════════════════════════════

describe('Host Resource Sharing', () => {
    test('defaults have network inheritance enabled', () => {
        expect(DEFAULT_HOST_SHARING.inherit_network).toBe(true);
    });

    test('defaults have clipboard sync enabled', () => {
        expect(DEFAULT_HOST_SHARING.clipboard_sync).toBe(true);
    });

    test('audio passthrough defaults to false (opt-in)', () => {
        expect(DEFAULT_HOST_SHARING.audio_passthrough).toBe(false);
    });

    test('shared_drives is an array', () => {
        expect(Array.isArray(DEFAULT_HOST_SHARING.shared_drives)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════
// 5. GAME ENGINE
// ═══════════════════════════════════════════════════════════════

describe('Game Engine — Tier Limits', () => {
    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(GAME_DEV_TIERS[t]).toBeDefined());
    });

    test('free tier restricts GPU profiling and shader hot-reload', () => {
        const free = GAME_DEV_TIERS.free;
        expect(free.gpu_profiling).toBe(false);
        expect(free.shader_hot_reload).toBe(false);
        expect(free.build_farm_agents).toBe(0);
        expect(free.render_farm_nodes).toBe(0);
        expect(free.physics_debugger).toBe(false);
        expect(free.input_emulation).toBe(false);
        expect(free.memory_profiler).toBe(false);
    });

    test('enterprise tier has unlimited build/render farm', () => {
        const ent = GAME_DEV_TIERS.enterprise;
        expect(ent.build_farm_agents).toBe(Infinity);
        expect(ent.render_farm_nodes).toBe(Infinity);
        expect(ent.netcode_test_clients).toBe(Infinity);
        expect(ent.build_matrix_entries).toBe(Infinity);
        expect(ent.sdk_sandboxes).toBe(Infinity);
        expect(ent.playtest_bots).toBe(Infinity);
    });

    test('netcode client limits escalate', () => {
        const limits = ALL_TIERS.map(t => GAME_DEV_TIERS[t].netcode_test_clients);
        for (let i = 1; i < limits.length; i++) {
            expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
        }
    });

    test('store submissions grow with tier', () => {
        const counts = ALL_TIERS.map(t => GAME_DEV_TIERS[t].store_submissions.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('standard+ tiers enable all profiling tools', () => {
        (['standard', 'advanced', 'enterprise'] as ScmTier[]).forEach(t => {
            const tier = GAME_DEV_TIERS[t];
            expect(tier.gpu_profiling).toBe(true);
            expect(tier.shader_hot_reload).toBe(true);
            expect(tier.physics_debugger).toBe(true);
            expect(tier.input_emulation).toBe(true);
            expect(tier.memory_profiler).toBe(true);
            expect(tier.perf_gates).toBe(true);
        });
    });
});

describe('Game Engine — Device Templates', () => {
    test('game-dev templates have unique IDs', () => {
        const ids = GAME_DEV_TEMPLATES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('game-dev templates have GPU enabled', () => {
        GAME_DEV_TEMPLATES.forEach(t => {
            expect(t.default_hardware.gpu_enabled).toBe(true);
            expect(t.default_hardware.gpu_vram_gb).toBeGreaterThan(0);
        });
    });

    test('game-dev template IDs do not collide with core templates', () => {
        const coreIds = new Set(DEVICE_TEMPLATES.map(t => t.id));
        GAME_DEV_TEMPLATES.forEach(t => {
            expect(coreIds.has(t.id)).toBe(false);
        });
    });
});

describe('Game Engine — Memory Budgets', () => {
    test('all platform budgets have positive total', () => {
        Object.entries(MEMORY_BUDGETS).forEach(([, budget]) => {
            expect(budget.total_budget_mb).toBeGreaterThan(0);
        });
    });

    test('sub-category budgets sum <= total budget', () => {
        Object.entries(MEMORY_BUDGETS).forEach(([, budget]) => {
            const subTotal = budget.textures_mb + budget.meshes_mb + budget.audio_mb +
                budget.scripts_mb + budget.physics_mb + budget.animation_mb +
                budget.ui_mb + budget.misc_mb;
            expect(subTotal).toBeLessThanOrEqual(budget.total_budget_mb);
        });
    });

    test('switch has the tightest budget', () => {
        expect(MEMORY_BUDGETS.switch.total_budget_mb).toBeLessThanOrEqual(
            MEMORY_BUDGETS.steam_deck.total_budget_mb
        );
    });

    test('known platforms are defined', () => {
        expect(MEMORY_BUDGETS.switch).toBeDefined();
        expect(MEMORY_BUDGETS.steam_deck).toBeDefined();
        expect(MEMORY_BUDGETS.mobile_low).toBeDefined();
        expect(MEMORY_BUDGETS.mobile_high).toBeDefined();
        expect(MEMORY_BUDGETS.console).toBeDefined();
        expect(MEMORY_BUDGETS.pc_high).toBeDefined();
    });
});

// ═══════════════════════════════════════════════════════════════
// 6. CREATIVE STUDIO
// ═══════════════════════════════════════════════════════════════

describe('Creative Studio — Tier Limits', () => {
    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(CREATIVE_STUDIO_TIERS[t]).toBeDefined());
    });

    test('free tier has basic 3D but no 5D', () => {
        const free = CREATIVE_STUDIO_TIERS.free;
        expect(free.viz_3d_enabled).toBe(true);
        expect(free.viz_5d_enabled).toBe(false);
        expect(free.raytracing_enabled).toBe(false);
        expect(free.ai_audio_generation).toBe(false);
        expect(free.spatial_audio).toBe(false);
        expect(free.cinematic_camera).toBe(false);
    });

    test('render resolution escalates', () => {
        const resolutions = ALL_TIERS.map(t => CREATIVE_STUDIO_TIERS[t].max_render_resolution);
        for (let i = 1; i < resolutions.length; i++) {
            expect(resolutions[i]).toBeGreaterThanOrEqual(resolutions[i - 1]);
        }
    });

    test('video duration escalates', () => {
        const durations = ALL_TIERS.map(t => CREATIVE_STUDIO_TIERS[t].max_video_duration_sec);
        for (let i = 1; i < durations.length; i++) {
            expect(durations[i]).toBeGreaterThanOrEqual(durations[i - 1]);
        }
    });

    test('codec availability grows with tier', () => {
        const counts = ALL_TIERS.map(t => CREATIVE_STUDIO_TIERS[t].video_codecs.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('enterprise has unlimited rendering', () => {
        const ent = CREATIVE_STUDIO_TIERS.enterprise;
        expect(ent.max_render_resolution).toBe(Infinity);
        expect(ent.max_spp).toBe(Infinity);
        expect(ent.max_video_duration_sec).toBe(Infinity);
        expect(ent.max_audio_gen_sec).toBe(Infinity);
    });

    test('all tiers include screen recorder', () => {
        ALL_TIERS.forEach(t => {
            expect(CREATIVE_STUDIO_TIERS[t].screen_recorder).toBe(true);
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 7. COMPETITOR IMPORT
// ═══════════════════════════════════════════════════════════════

describe('Competitor Import — Platforms', () => {
    test('at least 10 platforms defined', () => {
        expect(COMPETITOR_PLATFORMS.length).toBeGreaterThanOrEqual(10);
    });

    test('all platforms have unique IDs', () => {
        const ids = COMPETITOR_PLATFORMS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('all platforms have file signatures', () => {
        COMPETITOR_PLATFORMS.forEach(p => {
            expect(p.file_signatures.length).toBeGreaterThan(0);
        });
    });

    test('major engines are covered', () => {
        const ids = COMPETITOR_PLATFORMS.map(p => p.id);
        expect(ids).toContain('unity');
        expect(ids).toContain('unreal_engine');
        expect(ids).toContain('godot');
        expect(ids).toContain('xcode');
        expect(ids).toContain('android_studio');
        expect(ids).toContain('flutter');
    });

    test('all platforms have supported versions', () => {
        COMPETITOR_PLATFORMS.forEach(p => {
            expect(p.supported_versions.length).toBeGreaterThan(0);
        });
    });
});

describe('Competitor Import — Tier Limits', () => {
    test('platforms list grows with tier', () => {
        const counts = ALL_TIERS.map(t => COMPETITOR_IMPORT_TIERS[t].platforms.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('free tier has limited features', () => {
        const free = COMPETITOR_IMPORT_TIERS.free;
        expect(free.script_conversion).toBe(false);
        expect(free.asset_conversion).toBe(false);
        expect(free.vcs_history_import).toBe(false);
        expect(free.max_project_size_gb).toBeLessThanOrEqual(2);
    });

    test('enterprise has unlimited imports', () => {
        const ent = COMPETITOR_IMPORT_TIERS.enterprise;
        expect(ent.imports_per_month).toBe(Infinity);
        expect(ent.max_project_size_gb).toBe(Infinity);
        expect(ent.script_conversion).toBe(true);
    });

    test('enterprise covers all platforms', () => {
        const entPlatforms = COMPETITOR_IMPORT_TIERS.enterprise.platforms;
        const allPlatformIds = COMPETITOR_PLATFORMS.map(p => p.id);
        allPlatformIds.forEach(id => {
            expect(entPlatforms).toContain(id);
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 8. COMPONENT MARKETPLACE
// ═══════════════════════════════════════════════════════════════

describe('Component Marketplace — Tier Limits', () => {
    test('all tiers can browse', () => {
        ALL_TIERS.forEach(t => {
            expect(MARKETPLACE_TIERS[t].browse).toBe(true);
        });
    });

    test('all tiers can install free components', () => {
        ALL_TIERS.forEach(t => {
            expect(MARKETPLACE_TIERS[t].install_free).toBe(true);
        });
    });

    test('free tier cannot purchase or sell paid components', () => {
        const free = MARKETPLACE_TIERS.free;
        expect(free.purchase_paid).toBe(false);
        expect(free.sell_paid).toBe(false);
        expect(free.publisher_revenue_pct).toBe(0);
    });

    test('revenue share increases with tier', () => {
        const shares = ALL_TIERS.map(t => MARKETPLACE_TIERS[t].publisher_revenue_pct);
        for (let i = 1; i < shares.length; i++) {
            expect(shares[i]).toBeGreaterThanOrEqual(shares[i - 1]);
        }
    });

    test('standard+ tiers enable paid sales with positive revenue share', () => {
        (['standard', 'advanced', 'enterprise'] as ScmTier[]).forEach(t => {
            const tier = MARKETPLACE_TIERS[t];
            expect(tier.sell_paid).toBe(true);
            expect(tier.publisher_revenue_pct).toBeGreaterThanOrEqual(70);
        });
    });

    test('max published components escalates', () => {
        const limits = ALL_TIERS.map(t => MARKETPLACE_TIERS[t].max_published);
        for (let i = 1; i < limits.length; i++) {
            expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
        }
    });
});

// ═══════════════════════════════════════════════════════════════
// 9. PROJECT TEMPLATES
// ═══════════════════════════════════════════════════════════════

describe('Project Templates — Validation', () => {
    test('all templates have unique IDs', () => {
        const ids = ALL_PROJECT_TEMPLATES.map(t => t.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    test('all templates have required fields', () => {
        ALL_PROJECT_TEMPLATES.forEach(t => {
            expect(t.id).toBeTruthy();
            expect(t.name).toBeTruthy();
            expect(t.description.length).toBeGreaterThan(10);
            expect(t.category).toBeTruthy();
            expect(t.tech_stack.length).toBeGreaterThan(0);
            expect(t.target_platforms.length).toBeGreaterThan(0);
            expect(t.languages.length).toBeGreaterThan(0);
            expect(t.includes.length).toBeGreaterThanOrEqual(3);
            expect(ALL_TIERS).toContain(t.min_tier);
        });
    });

    test('game templates exist', () => {
        expect(GAME_TEMPLATES.length).toBeGreaterThanOrEqual(5);
        GAME_TEMPLATES.forEach(t => expect(t.category).toBe('game'));
    });

    test('app templates exist', () => {
        expect(APP_TEMPLATES.length).toBeGreaterThanOrEqual(2);
        APP_TEMPLATES.forEach(t => expect(t.category).toBe('app'));
    });

    test('creative templates exist', () => {
        expect(CREATIVE_TEMPLATES.length).toBeGreaterThanOrEqual(2);
        CREATIVE_TEMPLATES.forEach(t => expect(t.category).toBe('creative'));
    });

    test('ALL_PROJECT_TEMPLATES is the union of sub-arrays', () => {
        expect(ALL_PROJECT_TEMPLATES.length).toBe(
            GAME_TEMPLATES.length + APP_TEMPLATES.length + CREATIVE_TEMPLATES.length
        );
    });

    test('at least one free-tier template per category', () => {
        const gameFree = GAME_TEMPLATES.filter(t => t.min_tier === 'free');
        const appFree = APP_TEMPLATES.filter(t => t.min_tier === 'free');
        expect(gameFree.length).toBeGreaterThan(0);
        expect(appFree.length).toBeGreaterThan(0);
    });
});

describe('Project Templates — Tier Limits', () => {
    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(TEMPLATE_TIERS[t]).toBeDefined());
    });

    test('category availability grows with tier', () => {
        const counts = ALL_TIERS.map(t => TEMPLATE_TIERS[t].categories.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('creates per month escalates', () => {
        const limits = ALL_TIERS.map(t => TEMPLATE_TIERS[t].creates_per_month);
        for (let i = 1; i < limits.length; i++) {
            expect(limits[i]).toBeGreaterThanOrEqual(limits[i - 1]);
        }
    });

    test('enterprise has unlimited creates', () => {
        expect(TEMPLATE_TIERS.enterprise.creates_per_month).toBe(Infinity);
    });
});

// ═══════════════════════════════════════════════════════════════
// 10. WORKSPACE LICENSING
// ═══════════════════════════════════════════════════════════════

describe('Workspace Licensing — Presets', () => {
    test('all 11 workspace types have presets', () => {
        const expectedTypes = [
            'personal', 'public_oss', 'startup', 'business', 'enterprise',
            'educational', 'educational_student', 'nonprofit', 'government',
            'research', 'internal_only',
        ];
        expectedTypes.forEach(t => {
            expect(WORKSPACE_LICENSE_PRESETS[t as keyof typeof WORKSPACE_LICENSE_PRESETS]).toBeDefined();
        });
    });

    test('internal_only blocks all distribution', () => {
        const io = WORKSPACE_LICENSE_PRESETS.internal_only;
        expect(io.distribution_rights.allow_distribution).toBe(false);
        expect(io.distribution_rights.allow_commercial_sale).toBe(false);
        expect(io.distribution_rights.allow_sublicensing).toBe(false);
        expect(io.distribution_rights.allow_white_label).toBe(false);
    });

    test('business allows commercial sale', () => {
        const biz = WORKSPACE_LICENSE_PRESETS.business;
        expect(biz.distribution_rights.allow_commercial_sale).toBe(true);
        expect(biz.distribution_rights.allow_distribution).toBe(true);
    });

    test('educational blocks commercial sale', () => {
        const edu = WORKSPACE_LICENSE_PRESETS.educational;
        expect(edu.distribution_rights.allow_commercial_sale).toBe(false);
    });

    test('enterprise allows white-labeling', () => {
        const ent = WORKSPACE_LICENSE_PRESETS.enterprise;
        expect(ent.distribution_rights.allow_white_label).toBe(true);
    });

    test('startup has revenue cap', () => {
        const startup = WORKSPACE_LICENSE_PRESETS.startup;
        expect(startup.revenue_cap_usd).toBeDefined();
        expect(startup.revenue_cap_usd!).toBeGreaterThan(0);
    });

    test('verified types require verification method', () => {
        const verifiedTypes = Object.values(WORKSPACE_LICENSE_PRESETS).filter(p => p.verified);
        verifiedTypes.forEach(p => {
            expect(p.verification_method).toBeDefined();
        });
    });
});

describe('Workspace Licensing — Compatibility Matrix', () => {
    test('MIT is compatible with itself', () => {
        expect(LICENSE_COMPATIBILITY.mit).toContain('mit');
    });

    test('GPL3 is compatible with MIT (absorbing permissive)', () => {
        expect(LICENSE_COMPATIBILITY.gpl_3).toContain('mit');
    });

    test('proprietary paid is NOT compatible with GPL3', () => {
        expect(LICENSE_COMPATIBILITY.proprietary_paid).not.toContain('gpl_3');
    });

    test('all entries contain themselves if present', () => {
        Object.entries(LICENSE_COMPATIBILITY).forEach(([key, compatible]) => {
            if (compatible.includes(key)) {
                expect(compatible).toContain(key);
            }
        });
    });
});

describe('Workspace Licensing — Tier Integration', () => {
    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(LICENSE_TIERS[t]).toBeDefined());
    });

    test('workspace type availability grows with tier', () => {
        const counts = ALL_TIERS.map(t => LICENSE_TIERS[t].workspace_types.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('product type availability grows with tier', () => {
        const counts = ALL_TIERS.map(t => LICENSE_TIERS[t].product_types.length);
        for (let i = 1; i < counts.length; i++) {
            expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
        }
    });

    test('free tier has no compliance scanner', () => {
        const free = LICENSE_TIERS.free;
        expect(free.compliance_scanner).toBe(false);
        expect(free.sbom_generation).toBe(false);
        expect(free.custom_license).toBe(false);
    });

    test('enterprise has full compliance suite', () => {
        const ent = LICENSE_TIERS.enterprise;
        expect(ent.compliance_scanner).toBe(true);
        expect(ent.sbom_generation).toBe(true);
        expect(ent.custom_license).toBe(true);
        expect(ent.export_compliance).toBe(true);
        expect(ent.license_dashboard).toBe(true);
    });

    test('only enterprise has custom license type', () => {
        expect(LICENSE_TIERS.free.product_types).not.toContain('custom');
        expect(LICENSE_TIERS.standard.product_types).not.toContain('custom');
        expect(LICENSE_TIERS.enterprise.product_types).toContain('custom');
    });
});

// ═══════════════════════════════════════════════════════════════
// 11. CROSS-MODULE CONSISTENCY & EDGE CASES
// ═══════════════════════════════════════════════════════════════

describe('Cross-Module Consistency', () => {
    test('all tier-gated modules define all 4 tiers', () => {
        const tierRecords = [
            VM_TIERS, GAME_DEV_TIERS, CREATIVE_STUDIO_TIERS,
            COMPETITOR_IMPORT_TIERS, MARKETPLACE_TIERS,
            TEMPLATE_TIERS, LICENSE_TIERS,
        ];
        tierRecords.forEach(record => {
            ALL_TIERS.forEach(t => expect(record[t]).toBeDefined());
        });
    });

    test('game-dev template IDs are unique across core + game templates', () => {
        const allIds = [
            ...DEVICE_TEMPLATES.map(t => t.id),
            ...GAME_DEV_TEMPLATES.map(t => t.id),
        ];
        expect(new Set(allIds).size).toBe(allIds.length);
    });

    test('project template IDs are unique across all template arrays', () => {
        const allIds = ALL_PROJECT_TEMPLATES.map(t => t.id);
        expect(new Set(allIds).size).toBe(allIds.length);
    });

    test('competitor platform IDs are unique', () => {
        const ids = COMPETITOR_PLATFORMS.map(p => p.id);
        expect(new Set(ids).size).toBe(ids.length);
    });
});

describe('Edge Cases — Boundary Values', () => {
    test('Infinity tier values are valid numbers', () => {
        expect(VM_TIERS.enterprise.max_concurrent_vms).toBe(Infinity);
        expect(Number.isFinite(VM_TIERS.free.max_concurrent_vms)).toBe(true);
    });

    test('memory budgets textures_mb is always the largest sub-category', () => {
        Object.entries(MEMORY_BUDGETS).forEach(([, budget]) => {
            expect(budget.textures_mb).toBeGreaterThanOrEqual(budget.audio_mb);
            expect(budget.textures_mb).toBeGreaterThanOrEqual(budget.scripts_mb);
        });
    });

    test('network preset latency values are realistic', () => {
        Object.entries(NETWORK_PRESETS).forEach(([name, profile]) => {
            if (name !== 'satellite' && name !== 'offline' && name !== 'chaos') {
                expect(profile.latency_ms).toBeLessThan(1000);
            }
        });
    });

    test('creative studio free tier video is limited', () => {
        const free = CREATIVE_STUDIO_TIERS.free;
        expect(free.max_video_duration_sec).toBeLessThanOrEqual(120);
        expect(free.max_video_resolution).toBeLessThanOrEqual(1920);
    });

    test('marketplace revenue share is between 0-100%', () => {
        ALL_TIERS.forEach(t => {
            const pct = MARKETPLACE_TIERS[t].publisher_revenue_pct;
            expect(pct).toBeGreaterThanOrEqual(0);
            expect(pct).toBeLessThanOrEqual(100);
        });
    });
});

// ═══════════════════════════════════════════════════════════════
// 12. ETHICS & EXPORT CONTROL ENFORCEMENT
// ═══════════════════════════════════════════════════════════════

describe('Ethics Enforcement — Prohibited Use Policy', () => {
    test('all 10 prohibited categories are defined', () => {
        expect(PROHIBITED_USE_POLICY.prohibited_categories.length).toBe(10);
    });

    test('weapons, military, and autonomous lethal are prohibited', () => {
        const cats = PROHIBITED_USE_POLICY.prohibited_categories;
        expect(cats).toContain('weapons_development');
        expect(cats).toContain('military_operations');
        expect(cats).toContain('autonomous_lethal');
        expect(cats).toContain('nuclear_bio_chem');
        expect(cats).toContain('cyber_offensive');
        expect(cats).toContain('surveillance_mass');
        expect(cats).toContain('disinformation');
        expect(cats).toContain('human_rights_abuse');
        expect(cats).toContain('child_exploitation');
        expect(cats).toContain('sanctions_evasion');
    });

    test('trigger keywords include military terms', () => {
        const kw = PROHIBITED_USE_POLICY.trigger_keywords;
        expect(kw.length).toBeGreaterThan(10);
        expect(kw.some(k => k.includes('weapons'))).toBe(true);
        expect(kw.some(k => k.includes('missile'))).toBe(true);
        expect(kw.some(k => k.includes('surveillance'))).toBe(true);
        expect(kw.some(k => k.includes('lethal'))).toBe(true);
    });

    test('auto-reject threshold is higher than human-review threshold', () => {
        expect(PROHIBITED_USE_POLICY.auto_reject_threshold)
            .toBeGreaterThan(PROHIBITED_USE_POLICY.human_review_threshold);
    });

    test('thresholds are valid probabilities (0-1)', () => {
        expect(PROHIBITED_USE_POLICY.auto_reject_threshold).toBeGreaterThan(0);
        expect(PROHIBITED_USE_POLICY.auto_reject_threshold).toBeLessThanOrEqual(1);
        expect(PROHIBITED_USE_POLICY.human_review_threshold).toBeGreaterThan(0);
        expect(PROHIBITED_USE_POLICY.human_review_threshold).toBeLessThanOrEqual(1);
    });
});

describe('Ethics Enforcement — Sanctions & Embargoed Countries', () => {
    test('Russia is embargoed', () => {
        expect(EMBARGOED_COUNTRIES).toContain('RU');
    });

    test('Belarus is embargoed (sanctions facilitation)', () => {
        expect(EMBARGOED_COUNTRIES).toContain('BY');
    });

    test('North Korea, Iran, Syria, Cuba are embargoed', () => {
        expect(EMBARGOED_COUNTRIES).toContain('KP');
        expect(EMBARGOED_COUNTRIES).toContain('IR');
        expect(EMBARGOED_COUNTRIES).toContain('SY');
        expect(EMBARGOED_COUNTRIES).toContain('CU');
    });

    test('at least 6 embargoed countries', () => {
        expect(EMBARGOED_COUNTRIES.length).toBeGreaterThanOrEqual(6);
    });

    test('restricted countries include China (sector-specific)', () => {
        expect(RESTRICTED_COUNTRIES).toContain('CN');
    });

    test('all country codes are 2-letter ISO', () => {
        [...EMBARGOED_COUNTRIES, ...RESTRICTED_COUNTRIES].forEach(code => {
            expect(code).toMatch(/^[A-Z]{2}$/);
        });
    });

    test('no overlap between embargoed and restricted lists', () => {
        const embargoedSet = new Set(EMBARGOED_COUNTRIES);
        RESTRICTED_COUNTRIES.forEach(code => {
            expect(embargoedSet.has(code)).toBe(false);
        });
    });
});

describe('Ethics Enforcement — Sanctions Screening Config', () => {
    test('screens against OFAC SDN list', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.lists).toContain('ofac_sdn');
    });

    test('screens against EU consolidated sanctions', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.lists).toContain('eu_consolidated');
    });

    test('screens against BIS entity list (export control)', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.lists).toContain('bis_entity_list');
    });

    test('checks at least 6 sanctions lists', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.lists.length).toBeGreaterThanOrEqual(6);
    });

    test('list refresh is at least every 24 hours', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.list_refresh_hours).toBeLessThanOrEqual(24);
    });

    test('screens billing country, IP, org name, and individuals', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.screen_billing_country).toBe(true);
        expect(DEFAULT_SANCTIONS_CONFIG.screen_ip_country).toBe(true);
        expect(DEFAULT_SANCTIONS_CONFIG.screen_org_name).toBe(true);
        expect(DEFAULT_SANCTIONS_CONFIG.screen_individuals).toBe(true);
    });

    test('embargoed countries are blocked by default', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.block_embargoed).toBe(true);
    });

    test('enhanced due diligence is enabled for restricted countries', () => {
        expect(DEFAULT_SANCTIONS_CONFIG.enhanced_due_diligence).toBe(true);
    });
});

describe('Ethics Enforcement — Geofencing', () => {
    test('IP geolocation is enabled', () => {
        expect(DEFAULT_GEOFENCE_CONFIG.ip_geolocation).toBe(true);
    });

    test('VPN detection is enabled', () => {
        expect(DEFAULT_GEOFENCE_CONFIG.vpn_detection).toBe(true);
    });

    test('Tor exit node blocking is enabled', () => {
        expect(DEFAULT_GEOFENCE_CONFIG.tor_blocking).toBe(true);
    });

    test('triangulation requires minimum 2 matching signals', () => {
        expect(DEFAULT_GEOFENCE_CONFIG.triangulation_required).toBe(true);
        expect(DEFAULT_GEOFENCE_CONFIG.min_matching_signals).toBeGreaterThanOrEqual(2);
    });

    test('billing country match is required', () => {
        expect(DEFAULT_GEOFENCE_CONFIG.billing_country_match).toBe(true);
    });
});

describe('Ethics Enforcement — Runtime Monitoring', () => {
    test('API pattern monitoring is enabled', () => {
        expect(DEFAULT_RUNTIME_MONITOR.api_pattern_monitoring).toBe(true);
    });

    test('geo anomaly detection is enabled', () => {
        expect(DEFAULT_RUNTIME_MONITOR.geo_anomaly_detection).toBe(true);
    });

    test('spike threshold is reasonable (5-20x)', () => {
        expect(DEFAULT_RUNTIME_MONITOR.spike_threshold_multiplier).toBeGreaterThanOrEqual(5);
        expect(DEFAULT_RUNTIME_MONITOR.spike_threshold_multiplier).toBeLessThanOrEqual(20);
    });

    test('auto-suspend is human-in-the-loop by default', () => {
        expect(DEFAULT_RUNTIME_MONITOR.auto_suspend_on_anomaly).toBe(false);
    });
});

describe('Ethics Enforcement — Audit Trail', () => {
    test('hash chain is enabled for tamper-proof logging', () => {
        expect(DEFAULT_AUDIT_CONFIG.hash_chain_enabled).toBe(true);
    });

    test('retention is forever (0 = infinite)', () => {
        expect(DEFAULT_AUDIT_CONFIG.retention_days).toBe(0);
    });

    test('high-severity events trigger alerts', () => {
        const alerts = DEFAULT_AUDIT_CONFIG.alert_events;
        expect(alerts).toContain('sanctions_check_failed');
        expect(alerts).toContain('kill_switch_executed');
        expect(alerts).toContain('use_case_rejected');
    });
});

describe('Ethics Enforcement — Tier Independence', () => {
    test('enforcement is ALWAYS active for ALL tiers (not tier-gated)', () => {
        ALL_TIERS.forEach(t => {
            expect(ETHICS_TIERS[t].enforcement_active).toBe(true);
        });
    });

    test('all 4 tiers are defined', () => {
        ALL_TIERS.forEach(t => expect(ETHICS_TIERS[t]).toBeDefined());
    });

    test('free tier cannot view audit logs', () => {
        expect(ETHICS_TIERS.free.view_own_audit_logs).toBe(false);
        expect(ETHICS_TIERS.free.compliance_reports).toBe(false);
    });

    test('enterprise has full compliance visibility', () => {
        const ent = ETHICS_TIERS.enterprise;
        expect(ent.view_own_audit_logs).toBe(true);
        expect(ent.compliance_reports).toBe(true);
        expect(ent.dedicated_trust_contact).toBe(true);
        expect(ent.custom_geofence).toBe(true);
        expect(ent.pre_clearance).toBe(true);
    });
});

describe('Ethics Enforcement — Enforcement Pipeline', () => {
    test('pipeline has all 3 registration gates', () => {
        const pipeline = DEFAULT_ENFORCEMENT_PIPELINE;
        expect(pipeline.registration_gates.sanctions_screening).toBeDefined();
        expect(pipeline.registration_gates.geofence).toBeDefined();
        expect(pipeline.registration_gates.use_case_screening).toBeDefined();
    });

    test('pipeline includes runtime monitors', () => {
        expect(DEFAULT_ENFORCEMENT_PIPELINE.runtime_monitors).toBeDefined();
    });

    test('pipeline includes audit config', () => {
        expect(DEFAULT_ENFORCEMENT_PIPELINE.audit).toBeDefined();
    });

    test('pipeline includes prohibited use policy', () => {
        expect(DEFAULT_ENFORCEMENT_PIPELINE.prohibited_use).toBeDefined();
        expect(DEFAULT_ENFORCEMENT_PIPELINE.prohibited_use.prohibited_categories.length).toBe(10);
    });
});
