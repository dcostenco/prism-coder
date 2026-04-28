/**
 * Component Marketplace — Shared Components with Paid/Free Model
 * ══════════════════════════════════════════════════════════════
 *
 * Developer component sharing ecosystem powered by Synalux:
 *   - Publish reusable components (code, assets, shaders, plugins)
 *   - Free or paid models — payments processed via Synalux
 *   - Ratings, reviews, version management
 *   - License enforcement and revenue sharing
 *   - Category-based discovery and search
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. COMPONENT DEFINITIONS
// ══════════════════════════════════════════════════════════════════

export type ComponentCategory =
    | 'shader'
    | 'material'
    | 'texture_pack'
    | 'model_3d'
    | 'animation'
    | 'particle_system'
    | 'audio_pack'
    | 'ui_kit'
    | 'plugin'
    | 'script'
    | 'ai_model'
    | 'physics_preset'
    | 'vfx'
    | 'level_template'
    | 'networking'
    | 'input_mapping'
    | 'localization'
    | 'analytics'
    | 'monetization'
    | 'full_project_template'
    | 'other';

export type ComponentLicense =
    | 'mit'
    | 'apache_2'
    | 'gpl_3'
    | 'lgpl_3'
    | 'bsd_3'
    | 'cc_by_4'
    | 'cc_by_sa_4'
    | 'cc_by_nc_4'
    | 'proprietary'
    | 'custom';

export type PricingModel = 'free' | 'one_time' | 'subscription' | 'pay_what_you_want' | 'freemium';

export interface MarketplaceComponent {
    /** Unique component ID */
    id: string;
    /** Display name */
    name: string;
    /** Short description */
    description: string;
    /** Long description (Markdown) */
    readme: string;
    /** Publisher info */
    publisher: PublisherProfile;
    /** Component category */
    category: ComponentCategory;
    /** Tags for discovery */
    tags: string[];
    /** Current version */
    version: string;
    /** Version history */
    versions: ComponentVersion[];

    /** Pricing */
    pricing: ComponentPricing;

    /** License */
    license: ComponentLicense;
    /** Custom license text (for license: 'custom') */
    custom_license_text?: string;

    /** Compatibility */
    compatibility: ComponentCompatibility;

    /** Stats */
    stats: ComponentStats;

    /** Preview assets */
    preview_images: string[];
    preview_video?: string;
    demo_url?: string;

    /** Publication status */
    status: 'draft' | 'in_review' | 'published' | 'suspended' | 'archived';
    published_at?: string;
    updated_at: string;
}

export interface PublisherProfile {
    id: string;
    display_name: string;
    avatar_url?: string;
    /** Verified publisher (Synalux identity verification) */
    verified: boolean;
    /** Publisher tier */
    tier: ScmTier;
    /** Total components published */
    total_components: number;
    /** Average rating across all components */
    average_rating: number;
    /** Revenue share percentage (Synalux takes complement) */
    revenue_share_pct: number;
    /** Stripe Connect account for payouts */
    payout_account_connected: boolean;
}

export interface ComponentVersion {
    version: string;
    release_notes: string;
    released_at: string;
    download_size_bytes: number;
    /** Breaking changes from previous version */
    breaking_changes: boolean;
    /** Minimum Prism version required */
    min_prism_version: string;
}

export interface ComponentPricing {
    model: PricingModel;
    /** Price in cents (USD) — 0 for free */
    price_cents: number;
    /** Subscription price per month in cents (for model: 'subscription') */
    monthly_price_cents?: number;
    /** Minimum price for pay-what-you-want */
    min_price_cents?: number;
    /** Free tier features (for model: 'freemium') */
    free_features?: string[];
    /** Paid tier features (for model: 'freemium') */
    paid_features?: string[];
    /** Bulk discount tiers */
    volume_discounts?: Array<{ min_seats: number; discount_pct: number }>;
    /** Revenue split — publisher gets this %, Synalux gets the rest */
    publisher_revenue_pct: number;
}

export interface ComponentCompatibility {
    /** Target platforms */
    platforms: string[];
    /** GPU APIs supported */
    gpu_apis?: string[];
    /** Game engines compatible with */
    engines?: string[];
    /** Language requirements */
    languages: string[];
    /** Minimum Prism version */
    min_prism_version: string;
    /** Dependencies on other marketplace components */
    dependencies: Array<{ component_id: string; min_version: string }>;
}

export interface ComponentStats {
    downloads: number;
    active_installs: number;
    rating_average: number;
    rating_count: number;
    rating_distribution: { stars_1: number; stars_2: number; stars_3: number; stars_4: number; stars_5: number };
    revenue_total_cents: number;
    /** Issues reported */
    open_issues: number;
}

// ══════════════════════════════════════════════════════════════════
// 2. REVIEWS & RATINGS
// ══════════════════════════════════════════════════════════════════

export interface ComponentReview {
    id: string;
    component_id: string;
    reviewer_id: string;
    reviewer_name: string;
    rating: 1 | 2 | 3 | 4 | 5;
    title: string;
    body: string;
    /** Version reviewed */
    version: string;
    created_at: string;
    /** Publisher response */
    publisher_reply?: string;
    /** Helpful votes */
    helpful_count: number;
    /** Verified purchase */
    verified_purchase: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 3. PURCHASE & LICENSING
// ══════════════════════════════════════════════════════════════════

export interface ComponentPurchase {
    id: string;
    component_id: string;
    buyer_id: string;
    /** Price paid in cents */
    price_paid_cents: number;
    /** Publisher payout in cents */
    publisher_payout_cents: number;
    /** Synalux platform fee in cents */
    platform_fee_cents: number;
    /** Payment processor (Stripe via Synalux) */
    payment_processor: 'stripe';
    /** Stripe payment intent ID */
    stripe_payment_intent?: string;
    /** License key (for proprietary components) */
    license_key?: string;
    /** Seats purchased */
    seats: number;
    purchased_at: string;
    /** Subscription status */
    subscription_status?: 'active' | 'cancelled' | 'past_due' | 'expired';
}

export interface ComponentInstallRequest {
    component_id: string;
    version: string;
    target_project_path: string;
    /** Auto-install dependencies */
    install_dependencies: boolean;
    /** Override existing files */
    force: boolean;
}

export interface ComponentInstallResult {
    success: boolean;
    installed_components: Array<{ id: string; version: string; path: string }>;
    warnings: string[];
    errors: string[];
    /** Total download size */
    download_size_bytes: number;
    install_time_ms: number;
}

// ══════════════════════════════════════════════════════════════════
// 4. PUBLISHING WORKFLOW
// ══════════════════════════════════════════════════════════════════

export interface ComponentPublishRequest {
    /** Component metadata */
    name: string;
    description: string;
    readme_path: string;
    category: ComponentCategory;
    tags: string[];
    license: ComponentLicense;
    pricing: ComponentPricing;
    compatibility: ComponentCompatibility;
    /** Source directory */
    source_dir: string;
    /** Files to include (glob patterns) */
    include_patterns: string[];
    /** Files to exclude */
    exclude_patterns: string[];
    /** Preview images */
    preview_images: string[];
    /** Version */
    version: string;
    release_notes: string;
}

export interface ComponentPublishResult {
    success: boolean;
    component_id: string;
    version: string;
    /** Review queue position */
    review_queue_position?: number;
    /** Estimated review time */
    estimated_review_hours?: number;
    /** Package size */
    package_size_bytes: number;
    /** Validation warnings */
    warnings: string[];
    errors: string[];
}

// ══════════════════════════════════════════════════════════════════
// 5. SEARCH & DISCOVERY
// ══════════════════════════════════════════════════════════════════

export interface MarketplaceSearchRequest {
    query?: string;
    category?: ComponentCategory;
    tags?: string[];
    pricing_model?: PricingModel;
    /** Max price in cents (0 = free only) */
    max_price_cents?: number;
    /** Minimum rating */
    min_rating?: number;
    /** Sort order */
    sort: 'relevance' | 'downloads' | 'rating' | 'newest' | 'price_low' | 'price_high' | 'trending';
    /** Pagination */
    page: number;
    page_size: number;
    /** Filter by compatibility */
    platform?: string;
    engine?: string;
}

export interface MarketplaceSearchResult {
    results: MarketplaceComponent[];
    total_count: number;
    page: number;
    page_size: number;
    /** Featured/promoted components */
    featured?: MarketplaceComponent[];
}

// ══════════════════════════════════════════════════════════════════
// 6. MARKETPLACE TIER LIMITS
// ══════════════════════════════════════════════════════════════════

export interface MarketplaceTierLimits {
    /** Can browse marketplace */
    browse: boolean;
    /** Can install free components */
    install_free: boolean;
    /** Can purchase paid components */
    purchase_paid: boolean;
    /** Can publish components */
    publish: boolean;
    /** Max components published */
    max_published: number;
    /** Can sell paid components */
    sell_paid: boolean;
    /** Revenue share (publisher keeps this %) */
    publisher_revenue_pct: number;
    /** Max component size */
    max_component_size_mb: number;
    /** Priority review */
    priority_review: boolean;
    /** Analytics dashboard */
    publisher_analytics: boolean;
}

export const MARKETPLACE_TIERS: Record<ScmTier, MarketplaceTierLimits> = {
    free: {
        browse: true,
        install_free: true,
        purchase_paid: false,
        publish: true,
        max_published: 3,
        sell_paid: false,
        publisher_revenue_pct: 0,
        max_component_size_mb: 50,
        priority_review: false,
        publisher_analytics: false,
    },
    standard: {
        browse: true,
        install_free: true,
        purchase_paid: true,
        publish: true,
        max_published: 20,
        sell_paid: true,
        publisher_revenue_pct: 70,
        max_component_size_mb: 500,
        priority_review: false,
        publisher_analytics: true,
    },
    advanced: {
        browse: true,
        install_free: true,
        purchase_paid: true,
        publish: true,
        max_published: 100,
        sell_paid: true,
        publisher_revenue_pct: 80,
        max_component_size_mb: 2048,
        priority_review: true,
        publisher_analytics: true,
    },
    enterprise: {
        browse: true,
        install_free: true,
        purchase_paid: true,
        publish: true,
        max_published: Infinity,
        sell_paid: true,
        publisher_revenue_pct: 85,
        max_component_size_mb: Infinity,
        priority_review: true,
        publisher_analytics: true,
    },
};
