/**
 * Project Templates — Starter Scaffolds for Common App Types
 * ══════════════════════════════════════════════════════════
 *
 * Ready-to-run project templates covering:
 *   - Game genres (FPS, RPG, platformer, puzzle, racing, etc.)
 *   - App types (social, e-commerce, SaaS, IoT, etc.)
 *   - Creative projects (3D visualization, VR experience, etc.)
 *   - Enterprise (dashboards, APIs, microservices)
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. TEMPLATE DEFINITIONS
// ══════════════════════════════════════════════════════════════════

export type TemplateCategory = 'game' | 'app' | 'creative' | 'enterprise' | 'web' | 'embedded' | 'ai_ml';

export interface ProjectTemplate {
    id: string;
    name: string;
    description: string;
    category: TemplateCategory;
    /** Sub-category (e.g., 'fps', 'rpg', 'e-commerce') */
    subcategory: string;
    /** Included tech stack */
    tech_stack: string[];
    /** Game engine (if applicable) */
    engine?: string;
    /** Target platforms */
    target_platforms: string[];
    /** Languages used */
    languages: string[];
    /** Preview image */
    preview_image: string;
    /** Estimated setup time in minutes */
    setup_time_min: number;
    /** Complexity level */
    complexity: 'beginner' | 'intermediate' | 'advanced' | 'expert';
    /** What's included in the scaffold */
    includes: string[];
    /** Minimum tier required */
    min_tier: ScmTier;
    /** Pre-configured VM template to use */
    recommended_vm?: string;
}

// ══════════════════════════════════════════════════════════════════
// 2. GAME TEMPLATES
// ══════════════════════════════════════════════════════════════════

export const GAME_TEMPLATES: ProjectTemplate[] = [
    {
        id: 'fps-multiplayer',
        name: 'FPS Multiplayer Starter',
        description: 'First-person shooter with rollback netcode, weapon system, and matchmaking.',
        category: 'game',
        subcategory: 'fps',
        tech_stack: ['Unity', 'Netcode for GameObjects', 'Relay', 'Lobby'],
        engine: 'unity',
        target_platforms: ['Windows', 'macOS', 'Linux', 'PS5', 'Xbox'],
        languages: ['C#', 'HLSL'],
        preview_image: '/templates/fps-multiplayer.png',
        setup_time_min: 5,
        complexity: 'advanced',
        includes: ['Player controller', 'Weapon system', 'Health/damage', 'Rollback netcode', 'Matchmaking UI', 'Map loader', 'Audio manager', 'Settings menu'],
        min_tier: 'standard',
        recommended_vm: 'game-dev-workstation',
    },
    {
        id: 'rpg-openworld',
        name: 'Open-World RPG',
        description: 'Third-person RPG with inventory, quests, dialog trees, and procedural terrain.',
        category: 'game',
        subcategory: 'rpg',
        tech_stack: ['Unreal Engine', 'Gameplay Ability System', 'World Partition'],
        engine: 'unreal_engine',
        target_platforms: ['Windows', 'PS5', 'Xbox'],
        languages: ['C++', 'Blueprints'],
        preview_image: '/templates/rpg-openworld.png',
        setup_time_min: 10,
        complexity: 'expert',
        includes: ['Character controller', 'Inventory system', 'Quest manager', 'Dialog tree', 'Procedural terrain', 'Day/night cycle', 'NPC AI', 'Save system', 'Fast travel'],
        min_tier: 'advanced',
        recommended_vm: 'game-dev-workstation',
    },
    {
        id: 'platformer-2d',
        name: '2D Platformer',
        description: 'Polished 2D side-scroller with physics, parallax, and level editor.',
        category: 'game',
        subcategory: 'platformer',
        tech_stack: ['Godot', 'GDScript', 'TileMap'],
        engine: 'godot',
        target_platforms: ['Windows', 'macOS', 'Linux', 'Web', 'Mobile'],
        languages: ['GDScript'],
        preview_image: '/templates/platformer-2d.png',
        setup_time_min: 3,
        complexity: 'beginner',
        includes: ['Player physics', 'Enemy AI', 'Collectibles', 'Parallax background', 'Level editor', 'Save/load', 'Sound manager', 'Particle effects'],
        min_tier: 'free',
    },
    {
        id: 'puzzle-mobile',
        name: 'Mobile Puzzle Game',
        description: 'Touch-based puzzle game with progression, IAP, and analytics.',
        category: 'game',
        subcategory: 'puzzle',
        tech_stack: ['Unity', 'DOTween', 'Unity IAP', 'Firebase Analytics'],
        engine: 'unity',
        target_platforms: ['iOS', 'Android'],
        languages: ['C#'],
        preview_image: '/templates/puzzle-mobile.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['Grid system', 'Match logic', 'Progression/levels', 'Star rating', 'IAP integration', 'Analytics', 'Push notifications', 'Leaderboard'],
        min_tier: 'free',
    },
    {
        id: 'racing-arcade',
        name: 'Arcade Racing Game',
        description: 'Arcade racer with vehicle physics, AI opponents, and split-screen.',
        category: 'game',
        subcategory: 'racing',
        tech_stack: ['Unity', 'Vehicle Physics Pro', 'Cinemachine'],
        engine: 'unity',
        target_platforms: ['Windows', 'macOS', 'PS5', 'Xbox', 'Switch'],
        languages: ['C#'],
        preview_image: '/templates/racing-arcade.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['Vehicle controller', 'Track generator', 'AI drivers', 'Split-screen', 'Boost system', 'Lap tracker', 'Replay camera', 'Garage/customization'],
        min_tier: 'standard',
    },
    {
        id: 'survival-craft',
        name: 'Survival Crafting Game',
        description: 'Open-world survival with crafting, building, and multiplayer co-op.',
        category: 'game',
        subcategory: 'survival',
        tech_stack: ['Unreal Engine', 'EOS', 'Nanite', 'World Partition'],
        engine: 'unreal_engine',
        target_platforms: ['Windows', 'PS5', 'Xbox'],
        languages: ['C++', 'Blueprints'],
        preview_image: '/templates/survival-craft.png',
        setup_time_min: 10,
        complexity: 'expert',
        includes: ['Inventory/crafting grid', 'Building system', 'Hunger/thirst/health', 'Day/night + weather', 'Wildlife AI', 'Proc gen world', 'Multiplayer co-op', 'Base defense'],
        min_tier: 'advanced',
    },
    {
        id: 'vr-experience',
        name: 'VR Interactive Experience',
        description: 'Immersive VR experience with hand tracking, spatial audio, and mixed reality.',
        category: 'game',
        subcategory: 'vr',
        tech_stack: ['Unity', 'XR Interaction Toolkit', 'Meta SDK', 'ARKit'],
        engine: 'unity',
        target_platforms: ['Quest 3', 'Vision Pro', 'PCVR'],
        languages: ['C#'],
        preview_image: '/templates/vr-experience.png',
        setup_time_min: 5,
        complexity: 'advanced',
        includes: ['VR rig', 'Hand tracking', 'Teleport/locomotion', 'Grab system', 'Spatial audio', 'Mixed reality passthrough', 'UI panels', 'Settings (comfort options)'],
        min_tier: 'advanced',
        recommended_vm: 'game-dev-workstation',
    },
    {
        id: 'tower-defense',
        name: 'Tower Defense',
        description: 'Classic tower defense with waves, upgrades, and pathfinding.',
        category: 'game',
        subcategory: 'strategy',
        tech_stack: ['Godot', 'A* pathfinding', 'GDScript'],
        engine: 'godot',
        target_platforms: ['Windows', 'macOS', 'Web', 'Mobile'],
        languages: ['GDScript'],
        preview_image: '/templates/tower-defense.png',
        setup_time_min: 3,
        complexity: 'intermediate',
        includes: ['Tower placement', 'Wave spawner', 'Pathfinding', 'Upgrade tree', 'Economy system', 'Boss battles', 'Map editor', 'Difficulty scaling'],
        min_tier: 'free',
    },
    {
        id: 'card-battle',
        name: 'Digital Card Game',
        description: 'Collectible card game with deck building, multiplayer, and ranked ladder.',
        category: 'game',
        subcategory: 'card',
        tech_stack: ['Unity', 'Photon', 'PlayFab'],
        engine: 'unity',
        target_platforms: ['Windows', 'macOS', 'iOS', 'Android', 'Web'],
        languages: ['C#'],
        preview_image: '/templates/card-battle.png',
        setup_time_min: 5,
        complexity: 'advanced',
        includes: ['Card data system', 'Deck builder', 'Turn-based combat', 'Multiplayer (Photon)', 'Ranked matchmaking', 'Card animations', 'Collection manager', 'Daily quests'],
        min_tier: 'standard',
    },
];

// ══════════════════════════════════════════════════════════════════
// 3. APP TEMPLATES
// ══════════════════════════════════════════════════════════════════

export const APP_TEMPLATES: ProjectTemplate[] = [
    {
        id: 'saas-dashboard',
        name: 'SaaS Dashboard',
        description: 'Full-stack SaaS starter with auth, billing, teams, and analytics.',
        category: 'app',
        subcategory: 'saas',
        tech_stack: ['Next.js', 'Prisma', 'Stripe', 'NextAuth'],
        target_platforms: ['Web'],
        languages: ['TypeScript', 'React'],
        preview_image: '/templates/saas-dashboard.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['Auth (OAuth + email)', 'Stripe billing', 'Team management', 'Admin panel', 'Analytics dashboard', 'API routes', 'Dark mode', 'Settings'],
        min_tier: 'free',
    },
    {
        id: 'ecommerce-store',
        name: 'E-Commerce Store',
        description: 'Full e-commerce platform with cart, payments, and admin.',
        category: 'app',
        subcategory: 'e-commerce',
        tech_stack: ['Next.js', 'Stripe', 'Supabase', 'Algolia'],
        target_platforms: ['Web', 'Mobile (PWA)'],
        languages: ['TypeScript', 'React'],
        preview_image: '/templates/ecommerce-store.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['Product catalog', 'Cart/checkout', 'Stripe payments', 'Inventory management', 'Order tracking', 'Search (Algolia)', 'Reviews', 'Admin panel'],
        min_tier: 'free',
    },
    {
        id: 'social-platform',
        name: 'Social Media Platform',
        description: 'Real-time social app with feeds, messaging, and media sharing.',
        category: 'app',
        subcategory: 'social',
        tech_stack: ['React Native', 'Supabase', 'Expo', 'Socket.io'],
        target_platforms: ['iOS', 'Android', 'Web'],
        languages: ['TypeScript', 'React Native'],
        preview_image: '/templates/social-platform.png',
        setup_time_min: 10,
        complexity: 'advanced',
        includes: ['User profiles', 'News feed', 'Real-time messaging', 'Image/video upload', 'Notifications', 'Follow/friend system', 'Content moderation', 'Stories'],
        min_tier: 'standard',
    },
    {
        id: 'iot-dashboard',
        name: 'IoT Device Dashboard',
        description: 'Real-time IoT monitoring with device management, alerts, and telemetry.',
        category: 'app',
        subcategory: 'iot',
        tech_stack: ['React', 'MQTT', 'InfluxDB', 'Grafana'],
        target_platforms: ['Web', 'Embedded display'],
        languages: ['TypeScript', 'Python'],
        preview_image: '/templates/iot-dashboard.png',
        setup_time_min: 10,
        complexity: 'advanced',
        includes: ['Device registry', 'Real-time telemetry', 'MQTT broker', 'Alert rules', 'Historical charts', 'OTA updates', 'Geolocation map', 'Firmware management'],
        min_tier: 'standard',
    },
];

// ══════════════════════════════════════════════════════════════════
// 4. CREATIVE TEMPLATES
// ══════════════════════════════════════════════════════════════════

export const CREATIVE_TEMPLATES: ProjectTemplate[] = [
    {
        id: 'viz-3d-interactive',
        name: '3D Data Visualization',
        description: 'Interactive 3D/5D data visualization with WebGPU, scatter plots, and terrain maps.',
        category: 'creative',
        subcategory: 'data_viz',
        tech_stack: ['Three.js', 'WebGPU', 'D3.js'],
        target_platforms: ['Web', 'Desktop'],
        languages: ['TypeScript', 'WGSL'],
        preview_image: '/templates/viz-3d.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['3D scatter plot', 'Terrain map', 'Point cloud renderer', 'Color mapping', 'Camera controls', 'Data import (CSV/JSON)', 'Export (PNG/glTF)', 'Animation timeline'],
        min_tier: 'free',
        recommended_vm: 'webgpu-browser-test',
    },
    {
        id: 'ar-product-viewer',
        name: 'AR Product Viewer',
        description: 'Augmented reality product viewer for e-commerce with 3D models and configuration.',
        category: 'creative',
        subcategory: 'ar',
        tech_stack: ['Swift', 'ARKit', 'RealityKit', 'glTF'],
        target_platforms: ['iOS', 'iPadOS', 'Vision Pro'],
        languages: ['Swift', 'Metal'],
        preview_image: '/templates/ar-product.png',
        setup_time_min: 5,
        complexity: 'intermediate',
        includes: ['Model loader (glTF/USDZ)', 'Surface detection', 'Object placement', 'Product configurator', 'Screenshot/share', 'Analytics', 'Lighting estimation'],
        min_tier: 'standard',
    },
    {
        id: 'music-production',
        name: 'Music Production Suite',
        description: 'Web-based DAW with multi-track editing, effects, and AI-assisted composition.',
        category: 'creative',
        subcategory: 'audio',
        tech_stack: ['Web Audio API', 'Tone.js', 'WebMIDI'],
        target_platforms: ['Web', 'Desktop (Electron)'],
        languages: ['TypeScript'],
        preview_image: '/templates/music-daw.png',
        setup_time_min: 5,
        complexity: 'advanced',
        includes: ['Multi-track timeline', 'Audio recording', 'MIDI input', 'Effects rack', 'AI composition assist', 'Export WAV/MP3', 'Virtual instruments', 'Mixer'],
        min_tier: 'standard',
    },
    {
        id: 'video-editor-web',
        name: 'Web Video Editor',
        description: 'Browser-based video editor with timeline, transitions, and WebCodecs.',
        category: 'creative',
        subcategory: 'video',
        tech_stack: ['WebCodecs', 'Canvas API', 'FFmpeg.wasm'],
        target_platforms: ['Web'],
        languages: ['TypeScript'],
        preview_image: '/templates/video-editor.png',
        setup_time_min: 5,
        complexity: 'advanced',
        includes: ['Timeline editor', 'Video/audio tracks', 'Transitions', 'Text overlays', 'Color grading', 'Export MP4/WebM', 'Thumbnail generator', 'Keyboard shortcuts'],
        min_tier: 'standard',
    },
];

// ══════════════════════════════════════════════════════════════════
// 5. ALL TEMPLATES REGISTRY
// ══════════════════════════════════════════════════════════════════

export const ALL_PROJECT_TEMPLATES: ProjectTemplate[] = [
    ...GAME_TEMPLATES,
    ...APP_TEMPLATES,
    ...CREATIVE_TEMPLATES,
];

// ══════════════════════════════════════════════════════════════════
// 6. TEMPLATE CREATE WORKFLOW
// ══════════════════════════════════════════════════════════════════

export interface TemplateCreateRequest {
    template_id: string;
    project_name: string;
    project_path: string;
    /** Override default options */
    options?: Record<string, string | boolean | number>;
    /** Initialize git repository */
    init_git: boolean;
    /** Install dependencies */
    install_deps: boolean;
    /** Provision recommended VM */
    provision_vm: boolean;
}

export interface TemplateCreateResult {
    success: boolean;
    project_path: string;
    files_created: number;
    vm_provisioned?: boolean;
    /** Next steps for the developer */
    next_steps: string[];
    setup_time_ms: number;
}

// ══════════════════════════════════════════════════════════════════
// 7. TEMPLATE TIER LIMITS
// ══════════════════════════════════════════════════════════════════

export interface TemplateTierLimits {
    /** Template categories available */
    categories: TemplateCategory[];
    /** Max projects from templates per month */
    creates_per_month: number;
    /** Can use community templates */
    community_templates: boolean;
    /** Can publish custom templates to marketplace */
    publish_templates: boolean;
}

export const TEMPLATE_TIERS: Record<ScmTier, TemplateTierLimits> = {
    free: {
        categories: ['game', 'app', 'web'],
        creates_per_month: 5,
        community_templates: true,
        publish_templates: false,
    },
    standard: {
        categories: ['game', 'app', 'creative', 'web', 'ai_ml'],
        creates_per_month: 30,
        community_templates: true,
        publish_templates: true,
    },
    advanced: {
        categories: ['game', 'app', 'creative', 'enterprise', 'web', 'embedded', 'ai_ml'],
        creates_per_month: 100,
        community_templates: true,
        publish_templates: true,
    },
    enterprise: {
        categories: ['game', 'app', 'creative', 'enterprise', 'web', 'embedded', 'ai_ml'],
        creates_per_month: Infinity,
        community_templates: true,
        publish_templates: true,
    },
};
