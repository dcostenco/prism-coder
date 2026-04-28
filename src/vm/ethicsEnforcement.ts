/**
 * Ethics & Export Control Enforcement
 * ════════════════════════════════════
 *
 * PHYSICAL enforcement of ethical use policies and export controls.
 * This goes beyond policy — it's implemented as runtime gates that
 * block prohibited actions at the API/platform level.
 *
 * Enforcement layers (defense-in-depth):
 *   1. REGISTRATION GATE   — KYC/sanctions screening at signup
 *   2. GEOFENCE GATE       — IP + GPS + billing address verification
 *   3. USE-CASE GATE       — AI classifier rejects military/surveillance projects
 *   4. RUNTIME MONITOR     — continuous anomaly detection during usage
 *   5. KILL SWITCH         — instant account suspension (remote, irreversible)
 *   6. AUDIT TRAIL         — tamper-proof logging for compliance investigations
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. PROHIBITED USE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

/** Categories of absolutely prohibited use — no tier can override */
export type ProhibitedUseCategory =
    | 'weapons_development'        // Design, manufacture, or guidance of weapons
    | 'military_operations'        // Command & control, targeting, kill chains
    | 'surveillance_mass'          // Mass surveillance of civilian populations
    | 'autonomous_lethal'          // Autonomous weapons systems (LAWS)
    | 'nuclear_bio_chem'           // Nuclear, biological, or chemical weapons
    | 'cyber_offensive'            // Offensive cyberweapons or exploits
    | 'disinformation'             // State-sponsored disinformation campaigns
    | 'human_rights_abuse'         // Tools enabling oppression, torture, or detention
    | 'child_exploitation'         // Any CSAM-related use
    | 'sanctions_evasion';         // Evading sanctions or export controls

export interface ProhibitedUsePolicy {
    /** Prohibited categories — applies to ALL tiers, ALL users, no exceptions */
    prohibited_categories: ProhibitedUseCategory[];
    /** Keywords that trigger review in project descriptions/code */
    trigger_keywords: string[];
    /** AI classifier model for use-case screening */
    classifier_model: string;
    /** Confidence threshold to auto-reject (0.0-1.0) */
    auto_reject_threshold: number;
    /** Confidence threshold to flag for human review */
    human_review_threshold: number;
    /** Policy version (for audit trail) */
    policy_version: string;
    /** Last updated */
    updated_at: string;
}

/** Default prohibited use policy — hardcoded, cannot be overridden per-tenant */
export const PROHIBITED_USE_POLICY: ProhibitedUsePolicy = {
    prohibited_categories: [
        'weapons_development',
        'military_operations',
        'surveillance_mass',
        'autonomous_lethal',
        'nuclear_bio_chem',
        'cyber_offensive',
        'disinformation',
        'human_rights_abuse',
        'child_exploitation',
        'sanctions_evasion',
    ],
    trigger_keywords: [
        'weapons system', 'kill chain', 'targeting system', 'missile guidance',
        'drone strike', 'military AI', 'lethal autonomous', 'LAWS',
        'mass surveillance', 'facial recognition mass', 'population tracking',
        'nuclear enrichment', 'bioweapon', 'chemical weapon', 'nerve agent',
        'C4ISR', 'command and control military', 'military intelligence',
        'offensive cyber', 'zero-day exploit', 'state-sponsored',
        'propaganda generation', 'deepfake political', 'election manipulation',
    ],
    classifier_model: 'synalux-ethics-classifier-v2',
    auto_reject_threshold: 0.85,
    human_review_threshold: 0.50,
    policy_version: '2.0.0',
    updated_at: '2026-04-27',
};

// ══════════════════════════════════════════════════════════════════
// 2. SANCTIONS & EXPORT CONTROL
// ══════════════════════════════════════════════════════════════════

export type SanctionsListSource =
    | 'ofac_sdn'            // US Treasury OFAC SDN List
    | 'ofac_consolidated'   // US OFAC Consolidated Sanctions
    | 'eu_consolidated'     // EU Consolidated Financial Sanctions
    | 'un_sanctions'        // UN Security Council Sanctions
    | 'uk_ofsi'             // UK OFSI Sanctions
    | 'bis_entity_list'     // US BIS Entity List (export control)
    | 'bis_denied_persons'  // US BIS Denied Persons List
    | 'bis_unverified'      // US BIS Unverified List
    | 'canada_sema'         // Canada SEMA
    | 'australia_dfat';     // Australia DFAT Sanctions

/** Countries under comprehensive US/EU sanctions — hard-blocked at registration */
export const EMBARGOED_COUNTRIES: string[] = [
    'CU',  // Cuba
    'IR',  // Iran
    'KP',  // North Korea (DPRK)
    'SY',  // Syria
    'BY',  // Belarus — facilitating sanctions evasion
];

/** Countries under partial/sectoral sanctions — require enhanced due diligence.
 *  Users CAN register but military/defense/government projects are blocked.
 *  Civilian software development is permitted. */
export const RESTRICTED_COUNTRIES: string[] = [
    'RU',  // Russia — civilian use allowed, military/defense blocked
    'CN',  // China — sector-specific (military end-use)
    'VE',  // Venezuela
    'MM',  // Myanmar
    'SD',  // Sudan
    'SS',  // South Sudan
    'LY',  // Libya
    'SO',  // Somalia
    'YE',  // Yemen
    'ZW',  // Zimbabwe
    'CD',  // DRC
    'CF',  // Central African Republic
    'IQ',  // Iraq — sector-specific
    'LB',  // Lebanon — Hezbollah-related
];

/** Restricted-country enforcement: civilian projects only */
export interface CivilianOnlyRestriction {
    /** Country code */
    country: string;
    /** Registration allowed */
    registration_allowed: boolean;
    /** Blocked project types */
    blocked_sectors: string[];
    /** Blocked organization types */
    blocked_org_types: string[];
    /** Require government domain check */
    block_gov_domains: boolean;
    /** Require periodic re-verification */
    re_verification_days: number;
}

/** Default civilian-only restrictions for countries in RESTRICTED_COUNTRIES */
export const CIVILIAN_ONLY_DEFAULTS: CivilianOnlyRestriction = {
    country: '*',  // applies to all restricted countries
    registration_allowed: true,
    blocked_sectors: [
        'military', 'defense', 'intelligence', 'law_enforcement_surveillance',
        'weapons_manufacturing', 'dual_use_technology', 'nuclear_energy',
        'aerospace_defense', 'government_security',
    ],
    blocked_org_types: [
        'military', 'ministry_of_defense', 'intelligence_agency',
        'defense_contractor', 'state_security',
    ],
    block_gov_domains: true,
    re_verification_days: 90,
};

export interface SanctionsScreeningConfig {
    /** Sanctions lists to check against */
    lists: SanctionsListSource[];
    /** Auto-update frequency (hours) */
    list_refresh_hours: number;
    /** Fuzzy name matching threshold (0.0-1.0) */
    name_match_threshold: number;
    /** Screen billing address country */
    screen_billing_country: boolean;
    /** Screen IP geolocation country */
    screen_ip_country: boolean;
    /** Screen organization name against entity lists */
    screen_org_name: boolean;
    /** Screen individual users against SDN list */
    screen_individuals: boolean;
    /** Block embargoed countries entirely */
    block_embargoed: boolean;
    /** Require enhanced due diligence for restricted countries */
    enhanced_due_diligence: boolean;
}

export const DEFAULT_SANCTIONS_CONFIG: SanctionsScreeningConfig = {
    lists: [
        'ofac_sdn', 'ofac_consolidated', 'eu_consolidated',
        'un_sanctions', 'uk_ofsi', 'bis_entity_list',
        'bis_denied_persons', 'bis_unverified',
    ],
    list_refresh_hours: 6,
    name_match_threshold: 0.82,
    screen_billing_country: true,
    screen_ip_country: true,
    screen_org_name: true,
    screen_individuals: true,
    block_embargoed: true,
    enhanced_due_diligence: true,
};

// ══════════════════════════════════════════════════════════════════
// 3. GEOFENCING — IP + GPS + BILLING TRIANGULATION
// ══════════════════════════════════════════════════════════════════

export interface GeofenceConfig {
    /** Enable IP-based geolocation check */
    ip_geolocation: boolean;
    /** Enable GPS/location API check (mobile/browser) */
    gps_verification: boolean;
    /** Require billing address country match */
    billing_country_match: boolean;
    /** VPN/proxy detection — block known VPN exit nodes */
    vpn_detection: boolean;
    /** Tor exit node blocking */
    tor_blocking: boolean;
    /** Data center IP blocking (prevents cloud relay evasion) */
    datacenter_ip_blocking: boolean;
    /** Require 2/3 signals to agree (IP + billing + GPS) */
    triangulation_required: boolean;
    /** Minimum number of matching signals to allow access */
    min_matching_signals: number;
    /** Country mismatch action */
    mismatch_action: 'block' | 'flag_for_review' | 'log_only';
    /** IP reputation database */
    ip_reputation_provider: 'maxmind' | 'ip2location' | 'ipqualityscore';
}

export const DEFAULT_GEOFENCE_CONFIG: GeofenceConfig = {
    ip_geolocation: true,
    gps_verification: true,
    billing_country_match: true,
    vpn_detection: true,
    tor_blocking: true,
    datacenter_ip_blocking: false,  // too aggressive for legitimate cloud devs
    triangulation_required: true,
    min_matching_signals: 2,
    mismatch_action: 'flag_for_review',
    ip_reputation_provider: 'maxmind',
};

// ══════════════════════════════════════════════════════════════════
// 4. USE-CASE CLASSIFICATION GATE
// ══════════════════════════════════════════════════════════════════

export interface UseCaseScreeningConfig {
    /** AI-based project description analysis */
    ai_classifier_enabled: boolean;
    /** Scan code/repository for prohibited patterns */
    code_pattern_scanning: boolean;
    /** Scan package dependencies for military/surveillance libs */
    dependency_scanning: boolean;
    /** Manual review queue for flagged projects */
    human_review_queue: boolean;
    /** Periodic re-screening interval (days) */
    re_screening_interval_days: number;
    /** Known military/surveillance package names */
    prohibited_dependencies: string[];
    /** Government domain patterns requiring extra scrutiny */
    government_domain_patterns: string[];
}

export const DEFAULT_USE_CASE_SCREENING: UseCaseScreeningConfig = {
    ai_classifier_enabled: true,
    code_pattern_scanning: true,
    dependency_scanning: true,
    human_review_queue: true,
    re_screening_interval_days: 30,
    prohibited_dependencies: [
        // Placeholder patterns — real list maintained in synalux-private
        '@military/*', 'defense-*', 'weapon-*', 'surveillance-*',
    ],
    government_domain_patterns: [
        '*.mil', '*.gov.ru', '*.mil.ru', '*.mod.gov.*',
        '*.government.nl', '*.gov.cn',
    ],
};

// ══════════════════════════════════════════════════════════════════
// 5. RUNTIME MONITORING & ANOMALY DETECTION
// ══════════════════════════════════════════════════════════════════

export interface RuntimeMonitorConfig {
    /** Monitor API call patterns for suspicious use */
    api_pattern_monitoring: boolean;
    /** Detect sudden usage spikes (botnet/batch processing) */
    usage_spike_detection: boolean;
    /** Usage spike threshold (x above baseline) */
    spike_threshold_multiplier: number;
    /** Monitor for data exfiltration patterns */
    data_exfiltration_detection: boolean;
    /** Alert on access from new/unusual countries */
    geo_anomaly_detection: boolean;
    /** Alert on access outside normal hours (for org accounts) */
    temporal_anomaly_detection: boolean;
    /** Auto-suspend on confirmed anomaly */
    auto_suspend_on_anomaly: boolean;
    /** Cooldown before auto-suspend (minutes) — gives time for human review */
    auto_suspend_delay_minutes: number;
}

export const DEFAULT_RUNTIME_MONITOR: RuntimeMonitorConfig = {
    api_pattern_monitoring: true,
    usage_spike_detection: true,
    spike_threshold_multiplier: 10,
    data_exfiltration_detection: true,
    geo_anomaly_detection: true,
    temporal_anomaly_detection: true,
    auto_suspend_on_anomaly: false,  // human-in-the-loop by default
    auto_suspend_delay_minutes: 15,
};

// ══════════════════════════════════════════════════════════════════
// 6. KILL SWITCH — INSTANT ACCOUNT TERMINATION
// ══════════════════════════════════════════════════════════════════

export type KillSwitchReason =
    | 'sanctions_match'           // SDN/entity list match confirmed
    | 'prohibited_use_confirmed'  // Military/weapons use confirmed
    | 'export_control_violation'  // ITAR/EAR violation
    | 'law_enforcement_request'   // LEA subpoena or court order
    | 'terms_of_service'          // General ToS violation
    | 'fraud_detected'            // Payment fraud or identity fraud
    | 'manual_review'             // Trust & Safety manual decision
    | 'automated_detection';      // ML-flagged with high confidence

export interface KillSwitchAction {
    /** Account/workspace to terminate */
    target_account_id: string;
    /** Reason */
    reason: KillSwitchReason;
    /** Human-readable justification */
    justification: string;
    /** Authorized by (trust & safety officer ID) */
    authorized_by: string;
    /** Scope of action */
    scope: KillSwitchScope;
    /** Evidence references */
    evidence_refs: string[];
    /** Legal hold — preserve data for law enforcement */
    legal_hold: boolean;
    /** Timestamp */
    executed_at: string;
}

export interface KillSwitchScope {
    /** Revoke all API keys */
    revoke_api_keys: boolean;
    /** Disable all VMs */
    terminate_vms: boolean;
    /** Block all logins */
    block_authentication: boolean;
    /** Disable marketplace listings */
    delist_marketplace: boolean;
    /** Freeze payouts */
    freeze_payouts: boolean;
    /** Prevent data export (legal hold) */
    block_data_export: boolean;
    /** Propagate to sub-accounts / team members */
    propagate_to_team: boolean;
    /** Blacklist all associated emails/domains */
    blacklist_identifiers: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 7. TAMPER-PROOF AUDIT TRAIL
// ══════════════════════════════════════════════════════════════════

export type AuditEventType =
    | 'registration_screened'
    | 'sanctions_check_passed'
    | 'sanctions_check_failed'
    | 'geofence_check_passed'
    | 'geofence_check_failed'
    | 'vpn_detected'
    | 'use_case_approved'
    | 'use_case_rejected'
    | 'use_case_flagged'
    | 'runtime_anomaly_detected'
    | 'kill_switch_executed'
    | 'account_suspended'
    | 'account_reinstated'
    | 'legal_hold_applied'
    | 'data_export_requested'
    | 'compliance_report_generated';

export interface AuditEntry {
    /** Unique audit entry ID */
    id: string;
    /** Event type */
    event_type: AuditEventType;
    /** Account affected */
    account_id: string;
    /** IP address at time of event */
    ip_address: string;
    /** Geolocation derived from IP */
    geo_country: string;
    /** Geo city */
    geo_city?: string;
    /** Additional context */
    details: Record<string, unknown>;
    /** Decision made */
    decision: 'allow' | 'block' | 'flag' | 'suspend' | 'terminate';
    /** Decision maker (system or human ID) */
    decided_by: string;
    /** Timestamp (ISO 8601) */
    timestamp: string;
    /** SHA-256 hash of previous entry (blockchain-style chain) */
    prev_hash: string;
    /** SHA-256 hash of this entry */
    entry_hash: string;
}

export interface AuditConfig {
    /** Enable tamper-proof chain (hash linking) */
    hash_chain_enabled: boolean;
    /** Write-once storage backend */
    storage_backend: 'append_only_db' | 'immutable_s3' | 'blockchain';
    /** Retention period (days, 0 = forever) */
    retention_days: number;
    /** Real-time alert webhook for high-severity events */
    alert_webhook_url?: string;
    /** Events that trigger real-time alerts */
    alert_events: AuditEventType[];
    /** Compliance report generation schedule */
    report_schedule: 'daily' | 'weekly' | 'monthly';
}

export const DEFAULT_AUDIT_CONFIG: AuditConfig = {
    hash_chain_enabled: true,
    storage_backend: 'append_only_db',
    retention_days: 0, // forever — required for export control compliance
    alert_events: [
        'sanctions_check_failed',
        'geofence_check_failed',
        'use_case_rejected',
        'kill_switch_executed',
        'runtime_anomaly_detected',
    ],
    report_schedule: 'weekly',
};

// ══════════════════════════════════════════════════════════════════
// 8. ENFORCEMENT PIPELINE — ORDERED GATE SEQUENCE
// ══════════════════════════════════════════════════════════════════

/**
 * The enforcement pipeline runs these gates IN ORDER.
 * A failure at any gate blocks progression — no bypass possible.
 *
 * REGISTRATION:
 *   1. Sanctions screening (name + org + email domain)
 *   2. Geofence check (IP + billing address)
 *   3. Use-case classification (project description)
 *
 * RUNTIME (continuous):
 *   4. Periodic re-screening (every N days)
 *   5. API pattern monitoring
 *   6. Geo anomaly detection
 *   7. Dependency scanning on each build
 *
 * ENFORCEMENT (when violation detected):
 *   8. Flag → human review queue
 *   9. Suspend → immediate lockout (reversible)
 *   10. Kill switch → permanent termination (irreversible)
 */
export interface EnforcementPipeline {
    /** Registration gates — must all pass to create account */
    registration_gates: {
        sanctions_screening: SanctionsScreeningConfig;
        geofence: GeofenceConfig;
        use_case_screening: UseCaseScreeningConfig;
    };
    /** Runtime monitors — run continuously */
    runtime_monitors: RuntimeMonitorConfig;
    /** Audit trail config */
    audit: AuditConfig;
    /** Global prohibited use policy */
    prohibited_use: ProhibitedUsePolicy;
}

export const DEFAULT_ENFORCEMENT_PIPELINE: EnforcementPipeline = {
    registration_gates: {
        sanctions_screening: DEFAULT_SANCTIONS_CONFIG,
        geofence: DEFAULT_GEOFENCE_CONFIG,
        use_case_screening: DEFAULT_USE_CASE_SCREENING,
    },
    runtime_monitors: DEFAULT_RUNTIME_MONITOR,
    audit: DEFAULT_AUDIT_CONFIG,
    prohibited_use: PROHIBITED_USE_POLICY,
};

// ══════════════════════════════════════════════════════════════════
// 9. TIER INTEGRATION — enforcement is NOT optional
// ══════════════════════════════════════════════════════════════════

/**
 * Unlike other modules, ethics enforcement is NOT tier-gated.
 * ALL tiers get the SAME enforcement. The only difference is
 * reporting depth available to the account holder.
 */
export interface EthicsTierConfig {
    /** All enforcement is always on — cannot be disabled */
    enforcement_active: true;
    /** Can view own audit logs */
    view_own_audit_logs: boolean;
    /** Can generate compliance reports */
    compliance_reports: boolean;
    /** Dedicated trust & safety contact */
    dedicated_trust_contact: boolean;
    /** Custom geofence rules (allowlist specific countries) */
    custom_geofence: boolean;
    /** Pre-clearance for sensitive use cases */
    pre_clearance: boolean;
}

export const ETHICS_TIERS: Record<ScmTier, EthicsTierConfig> = {
    free: {
        enforcement_active: true,
        view_own_audit_logs: false,
        compliance_reports: false,
        dedicated_trust_contact: false,
        custom_geofence: false,
        pre_clearance: false,
    },
    standard: {
        enforcement_active: true,
        view_own_audit_logs: true,
        compliance_reports: false,
        dedicated_trust_contact: false,
        custom_geofence: false,
        pre_clearance: false,
    },
    advanced: {
        enforcement_active: true,
        view_own_audit_logs: true,
        compliance_reports: true,
        dedicated_trust_contact: false,
        custom_geofence: false,
        pre_clearance: true,
    },
    enterprise: {
        enforcement_active: true,
        view_own_audit_logs: true,
        compliance_reports: true,
        dedicated_trust_contact: true,
        custom_geofence: true,
        pre_clearance: true,
    },
};
