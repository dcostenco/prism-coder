/**
 * Workspace & Product Licensing
 * ══════════════════════════════
 *
 * Two-layer licensing model:
 *   1. WORKSPACE LICENSE — governs the workspace itself (public, business, educational, gov, nonprofit)
 *   2. PRODUCT LICENSE  — each app/product built in the workspace can have its own license
 *
 * Required because the marketplace allows building, distributing, and selling apps.
 * License compliance is enforced at build, deploy, and publish time.
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. WORKSPACE LICENSE TYPES
// ══════════════════════════════════════════════════════════════════

export type WorkspaceLicenseType =
    | 'personal'           // Individual developer, hobby/learning
    | 'public_oss'         // Open-source project (must specify OSS license)
    | 'startup'            // Early-stage company (<$1M ARR)
    | 'business'           // Commercial use (standard company)
    | 'enterprise'         // Large organization (custom terms)
    | 'educational'        // School, university, bootcamp
    | 'educational_student'// Individual student (verified .edu)
    | 'nonprofit'          // 501(c)(3) or equivalent
    | 'government'         // Government agency
    | 'research'           // Academic or corporate research lab
    | 'internal_only';     // Internal tools — no distribution

export interface WorkspaceLicense {
    /** License type */
    type: WorkspaceLicenseType;
    /** Organization/individual name on the license */
    licensee_name: string;
    /** Organization ID (Synalux account) */
    licensee_id: string;
    /** Verified status (edu/nonprofit/gov require verification) */
    verified: boolean;
    /** Verification method (if applicable) */
    verification_method?: 'email_domain' | 'document_upload' | 'synalux_manual' | 'duns_number' | 'ein_number';

    /** License issue date */
    issued_at: string;
    /** License expiry (undefined = perpetual) */
    expires_at?: string;

    /** Seat count (undefined = unlimited for enterprise) */
    seats?: number;
    /** Named users on the license */
    named_users?: string[];

    /** Workspace-level distribution rights */
    distribution_rights: DistributionRights;
    /** Revenue limits (startup tier) */
    revenue_cap_usd?: number;

    /** Custom terms (enterprise/government) */
    custom_terms?: string;
    /** Legal jurisdiction */
    jurisdiction: string;
    /** GDPR/data residency requirements */
    data_residency?: string;
}

export interface DistributionRights {
    /** Can distribute apps externally */
    allow_distribution: boolean;
    /** Can sell apps commercially */
    allow_commercial_sale: boolean;
    /** Can sublicense to end users */
    allow_sublicensing: boolean;
    /** Can white-label / rebrand */
    allow_white_label: boolean;
    /** Geographic restrictions */
    geographic_restrictions?: string[];
    /** Industry restrictions (e.g., no gambling, no weapons) */
    industry_restrictions?: string[];
    /** Max end-user count (undefined = unlimited) */
    max_end_users?: number;
}

/** Workspace license presets */
export const WORKSPACE_LICENSE_PRESETS: Record<WorkspaceLicenseType, Omit<WorkspaceLicense, 'licensee_name' | 'licensee_id' | 'issued_at' | 'jurisdiction'>> = {
    personal: {
        type: 'personal',
        verified: false,
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
    public_oss: {
        type: 'public_oss',
        verified: false,
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: true,
            allow_white_label: false,
        },
    },
    startup: {
        type: 'startup',
        verified: false,
        revenue_cap_usd: 1_000_000,
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: true,
            allow_sublicensing: false,
            allow_white_label: false,
            max_end_users: 10_000,
        },
    },
    business: {
        type: 'business',
        verified: true,
        verification_method: 'duns_number',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: true,
            allow_sublicensing: true,
            allow_white_label: false,
        },
    },
    enterprise: {
        type: 'enterprise',
        verified: true,
        verification_method: 'synalux_manual',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: true,
            allow_sublicensing: true,
            allow_white_label: true,
        },
    },
    educational: {
        type: 'educational',
        verified: true,
        verification_method: 'document_upload',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
    educational_student: {
        type: 'educational_student',
        verified: true,
        verification_method: 'email_domain',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
    nonprofit: {
        type: 'nonprofit',
        verified: true,
        verification_method: 'ein_number',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
    government: {
        type: 'government',
        verified: true,
        verification_method: 'synalux_manual',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: true,
            geographic_restrictions: [],
        },
    },
    research: {
        type: 'research',
        verified: true,
        verification_method: 'document_upload',
        distribution_rights: {
            allow_distribution: true,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
    internal_only: {
        type: 'internal_only',
        verified: false,
        distribution_rights: {
            allow_distribution: false,
            allow_commercial_sale: false,
            allow_sublicensing: false,
            allow_white_label: false,
        },
    },
};

// ══════════════════════════════════════════════════════════════════
// 2. PER-PRODUCT LICENSE (each app/component can differ)
// ══════════════════════════════════════════════════════════════════

export type ProductLicenseType =
    // Open Source
    | 'mit'
    | 'apache_2'
    | 'gpl_3'
    | 'lgpl_3'
    | 'agpl_3'
    | 'bsd_2'
    | 'bsd_3'
    | 'mpl_2'
    | 'unlicense'
    | 'cc0'
    // Creative Commons
    | 'cc_by_4'
    | 'cc_by_sa_4'
    | 'cc_by_nc_4'
    | 'cc_by_nc_sa_4'
    | 'cc_by_nd_4'
    | 'cc_by_nc_nd_4'
    // Proprietary / Commercial
    | 'proprietary_free'       // Free but closed source
    | 'proprietary_paid'       // Paid, closed source
    | 'proprietary_freemium'   // Free tier + paid features
    | 'proprietary_trial'      // Time-limited trial
    | 'proprietary_subscription' // Recurring payment
    // Special
    | 'dual_license'           // OSS + commercial
    | 'source_available'       // Readable but restricted (BSL, ELv2)
    | 'eula'                   // End user license agreement
    | 'custom';                // Fully custom terms

export interface ProductLicense {
    /** Primary license type */
    type: ProductLicenseType;
    /** SPDX identifier (if standard OSS) */
    spdx_id?: string;
    /** Display name */
    display_name: string;
    /** Short summary for users */
    summary: string;
    /** Full license text (path or inline) */
    full_text_path?: string;
    full_text_inline?: string;

    /** Permissions granted */
    permissions: LicensePermissions;
    /** Conditions / requirements */
    conditions: LicenseConditions;
    /** Limitations / restrictions */
    limitations: LicenseLimitations;

    /** Commercial terms (for proprietary licenses) */
    commercial_terms?: CommercialTerms;

    /** Dual license (for type: 'dual_license') */
    dual_license?: {
        oss_license: ProductLicenseType;
        commercial_license: ProductLicenseType;
        commercial_terms: CommercialTerms;
    };

    /** Effective date */
    effective_date: string;
    /** Version of the license terms */
    terms_version: string;
}

export interface LicensePermissions {
    commercial_use: boolean;
    modification: boolean;
    distribution: boolean;
    private_use: boolean;
    patent_use: boolean;
    sublicensing: boolean;
}

export interface LicenseConditions {
    /** Must include license/copyright notice */
    include_license: boolean;
    /** Must disclose source code */
    disclose_source: boolean;
    /** Must use same license for derivatives */
    same_license: boolean;
    /** Must document changes */
    state_changes: boolean;
    /** Must attribute original author */
    attribution: boolean;
    /** Network use triggers distribution (AGPL) */
    network_use_is_distribution: boolean;
}

export interface LicenseLimitations {
    /** No warranty */
    no_warranty: boolean;
    /** No liability */
    no_liability: boolean;
    /** No trademark rights */
    no_trademark: boolean;
    /** Cannot use for specific purposes */
    use_restrictions?: string[];
    /** Geographic restrictions */
    geographic_restrictions?: string[];
    /** Industry restrictions */
    industry_restrictions?: string[];
    /** End-user count limit */
    max_users?: number;
    /** Revenue cap before requiring upgrade */
    revenue_cap_usd?: number;
}

export interface CommercialTerms {
    /** Pricing model */
    pricing_model: 'one_time' | 'subscription' | 'per_seat' | 'per_unit' | 'revenue_share' | 'usage_based' | 'custom';
    /** Base price in cents (USD) */
    base_price_cents: number;
    /** Per-seat price (for per_seat model) */
    per_seat_price_cents?: number;
    /** Subscription period */
    billing_period?: 'monthly' | 'annual' | 'lifetime';
    /** Revenue share percentage (for revenue_share model) */
    revenue_share_pct?: number;
    /** Free tier included */
    free_tier?: {
        max_users: number;
        max_revenue_usd: number;
        features: string[];
    };
    /** Trial period in days */
    trial_days?: number;
    /** Refund policy */
    refund_policy: 'no_refunds' | '7_day' | '14_day' | '30_day' | 'pro_rata';
    /** Payment processing via Synalux */
    payment_via_synalux: boolean;
    /** Support included */
    support_level: 'community' | 'email' | 'priority' | 'dedicated';
}

// ══════════════════════════════════════════════════════════════════
// 3. LICENSE COMPLIANCE ENGINE
// ══════════════════════════════════════════════════════════════════

export interface LicenseComplianceCheck {
    /** Product being checked */
    product_id: string;
    /** Workspace license */
    workspace_license: WorkspaceLicenseType;
    /** Product license */
    product_license: ProductLicenseType;
    /** Dependencies and their licenses */
    dependency_licenses: Array<{
        name: string;
        version: string;
        license: ProductLicenseType;
        spdx_id?: string;
    }>;
    /** Compliance result */
    result: ComplianceResult;
}

export interface ComplianceResult {
    /** Overall compliance status */
    status: 'compliant' | 'warning' | 'non_compliant';
    /** Incompatible license combinations found */
    conflicts: LicenseConflict[];
    /** Warnings (e.g., copyleft in proprietary project) */
    warnings: string[];
    /** Recommendations */
    recommendations: string[];
    /** Blockers that prevent distribution */
    blockers: string[];
}

export interface LicenseConflict {
    /** Source license */
    source_license: string;
    /** Conflicting dependency license */
    dependency_license: string;
    /** Dependency name */
    dependency_name: string;
    /** Why they conflict */
    reason: string;
    /** Possible resolutions */
    resolutions: string[];
}

/** Well-known OSS license compatibility matrix */
export const LICENSE_COMPATIBILITY: Record<string, string[]> = {
    mit: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'isc', 'unlicense', 'cc0'],
    apache_2: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'unlicense', 'cc0'],
    gpl_3: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'gpl_3', 'lgpl_3', 'agpl_3', 'unlicense', 'cc0'],
    lgpl_3: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'lgpl_3', 'unlicense', 'cc0'],
    agpl_3: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'gpl_3', 'lgpl_3', 'agpl_3', 'unlicense', 'cc0'],
    mpl_2: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'mpl_2', 'unlicense', 'cc0'],
    proprietary_paid: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'unlicense', 'cc0'],
    proprietary_free: ['mit', 'bsd_2', 'bsd_3', 'apache_2', 'unlicense', 'cc0'],
};

// ══════════════════════════════════════════════════════════════════
// 4. LICENSE TIER INTEGRATION
// ══════════════════════════════════════════════════════════════════

export interface LicenseTierLimits {
    /** Workspace license types available */
    workspace_types: WorkspaceLicenseType[];
    /** Product license types available */
    product_types: ProductLicenseType[];
    /** Compliance scanner */
    compliance_scanner: boolean;
    /** Auto-generate LICENSE file */
    auto_license_file: boolean;
    /** SBOM (Software Bill of Materials) generation */
    sbom_generation: boolean;
    /** Custom license drafting */
    custom_license: boolean;
    /** Multi-product license management dashboard */
    license_dashboard: boolean;
    /** Export compliance (ITAR/EAR) checks */
    export_compliance: boolean;
}

export const LICENSE_TIERS: Record<ScmTier, LicenseTierLimits> = {
    free: {
        workspace_types: ['personal', 'public_oss', 'educational_student'],
        product_types: ['mit', 'apache_2', 'gpl_3', 'lgpl_3', 'bsd_2', 'bsd_3', 'unlicense', 'cc0', 'cc_by_4', 'proprietary_free'],
        compliance_scanner: false,
        auto_license_file: true,
        sbom_generation: false,
        custom_license: false,
        license_dashboard: false,
        export_compliance: false,
    },
    standard: {
        workspace_types: ['personal', 'public_oss', 'startup', 'educational_student', 'educational', 'nonprofit'],
        product_types: ['mit', 'apache_2', 'gpl_3', 'lgpl_3', 'agpl_3', 'bsd_2', 'bsd_3', 'mpl_2', 'unlicense', 'cc0', 'cc_by_4', 'cc_by_sa_4', 'cc_by_nc_4', 'proprietary_free', 'proprietary_paid', 'proprietary_freemium', 'dual_license', 'source_available'],
        compliance_scanner: true,
        auto_license_file: true,
        sbom_generation: true,
        custom_license: false,
        license_dashboard: true,
        export_compliance: false,
    },
    advanced: {
        workspace_types: ['personal', 'public_oss', 'startup', 'business', 'educational_student', 'educational', 'nonprofit', 'research'],
        product_types: ['mit', 'apache_2', 'gpl_3', 'lgpl_3', 'agpl_3', 'bsd_2', 'bsd_3', 'mpl_2', 'unlicense', 'cc0', 'cc_by_4', 'cc_by_sa_4', 'cc_by_nc_4', 'cc_by_nc_sa_4', 'cc_by_nd_4', 'cc_by_nc_nd_4', 'proprietary_free', 'proprietary_paid', 'proprietary_freemium', 'proprietary_trial', 'proprietary_subscription', 'dual_license', 'source_available', 'eula'],
        compliance_scanner: true,
        auto_license_file: true,
        sbom_generation: true,
        custom_license: true,
        license_dashboard: true,
        export_compliance: false,
    },
    enterprise: {
        workspace_types: ['personal', 'public_oss', 'startup', 'business', 'enterprise', 'educational_student', 'educational', 'nonprofit', 'government', 'research', 'internal_only'],
        product_types: ['mit', 'apache_2', 'gpl_3', 'lgpl_3', 'agpl_3', 'bsd_2', 'bsd_3', 'mpl_2', 'unlicense', 'cc0', 'cc_by_4', 'cc_by_sa_4', 'cc_by_nc_4', 'cc_by_nc_sa_4', 'cc_by_nd_4', 'cc_by_nc_nd_4', 'proprietary_free', 'proprietary_paid', 'proprietary_freemium', 'proprietary_trial', 'proprietary_subscription', 'dual_license', 'source_available', 'eula', 'custom'],
        compliance_scanner: true,
        auto_license_file: true,
        sbom_generation: true,
        custom_license: true,
        license_dashboard: true,
        export_compliance: true,
    },
};
