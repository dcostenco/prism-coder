/**
 * Game Engine & Development Toolchain — Type System
 * ══════════════════════════════════════════════════
 *
 * Comprehensive interfaces for game development within Prism IDE:
 *   - GPU profiling & frame debugging
 *   - Shader development pipeline (compile, hot-reload, profile)
 *   - Build farm & render pipeline (distributed builds)
 *   - Multiplayer netcode testing (rollback, lag sim, multi-client)
 *   - Asset pipeline (texture compression, LOD, bundling)
 *   - Physics debugging (collision viz, replay, profiling)
 *   - Input device emulation (gamepad, touch, VR controllers)
 *   - Game QA & automated playtesting
 *   - Memory profiling (budget enforcement, leak detection)
 *   - Cross-platform build matrix
 *   - Plugin/SDK sandbox
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';
import type { NetworkProfile, VmHardwareSpec } from './types.js';

// ══════════════════════════════════════════════════════════════════
// 1. GPU PROFILING & FRAME DEBUGGING
// ══════════════════════════════════════════════════════════════════

export type GpuApi = 'metal' | 'vulkan' | 'directx12' | 'directx11' | 'opengl_es' | 'webgpu' | 'opengl';

export type GpuBottleneckType =
    | 'vertex_processing'
    | 'fragment_processing'
    | 'compute_shader'
    | 'memory_bandwidth'
    | 'fill_rate'
    | 'draw_call_overhead'
    | 'texture_fetch'
    | 'cpu_bound';

export interface GpuProfilerConfig {
    /** Target GPU API */
    api: GpuApi;
    /** Capture frequency (every N frames) */
    capture_interval_frames: number;
    /** Enable draw call tracking */
    track_draw_calls: boolean;
    /** Enable VRAM allocation tracking */
    track_vram: boolean;
    /** Enable shader timing per pass */
    track_shader_timing: boolean;
    /** Max frames to retain in buffer */
    buffer_size_frames: number;
}

export interface GpuFrameCapture {
    frame_number: number;
    timestamp_ms: number;
    gpu_time_ms: number;
    cpu_time_ms: number;
    draw_call_count: number;
    triangle_count: number;
    vram_used_mb: number;
    vram_total_mb: number;
    render_passes: RenderPassInfo[];
    bottleneck: GpuBottleneckType;
    fps: number;
}

export interface RenderPassInfo {
    name: string;
    duration_ms: number;
    draw_calls: number;
    triangles: number;
    shader_name: string;
    render_target_size: { width: number; height: number };
    overdraw_ratio: number;
}

export interface FrameDebuggerConfig {
    /** External profiler integration */
    profiler_tool: 'renderdoc' | 'nsight' | 'xcode_gpu' | 'pix' | 'agi' | 'built_in';
    /** Enable overdraw visualization */
    overdraw_heatmap: boolean;
    /** Enable wireframe overlay */
    wireframe_overlay: boolean;
    /** Enable depth buffer visualization */
    depth_visualization: boolean;
    /** Enable texture mipmap coloring */
    mipmap_heatmap: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 2. SHADER DEVELOPMENT PIPELINE
// ══════════════════════════════════════════════════════════════════

export type ShaderLanguage = 'hlsl' | 'glsl' | 'msl' | 'wgsl' | 'spirv' | 'cg';
export type ShaderStage = 'vertex' | 'fragment' | 'compute' | 'geometry' | 'tessellation_control' | 'tessellation_eval' | 'mesh' | 'task' | 'ray_generation' | 'ray_intersection' | 'ray_closest_hit' | 'ray_miss';

export interface ShaderCompileTarget {
    source_language: ShaderLanguage;
    target_language: ShaderLanguage;
    target_api: GpuApi;
    optimization_level: 0 | 1 | 2 | 3;
    debug_info: boolean;
}

export interface ShaderVariant {
    id: string;
    name: string;
    defines: Record<string, string | boolean>;
    /** e.g., shadow_on/shadow_off, mobile/desktop */
    description: string;
}

export interface ShaderHotReloadConfig {
    enabled: boolean;
    /** Watch directory for shader source files */
    watch_paths: string[];
    /** Auto-recompile on save */
    auto_compile: boolean;
    /** Inject into running game without restart */
    live_inject: boolean;
    /** Rollback on compile error */
    rollback_on_error: boolean;
}

export interface ShaderProfileResult {
    shader_name: string;
    stage: ShaderStage;
    alu_instructions: number;
    texture_instructions: number;
    register_pressure: number;
    occupancy_pct: number;
    estimated_cycles: number;
    hotspots: Array<{ line: number; cost_pct: number; instruction: string }>;
}

// ══════════════════════════════════════════════════════════════════
// 3. BUILD FARM & RENDER PIPELINE
// ══════════════════════════════════════════════════════════════════

export interface BuildFarmConfig {
    /** Number of build agents in the pool */
    agent_count: number;
    /** Hardware spec per agent */
    agent_hardware: VmHardwareSpec;
    /** Distributed compile tool */
    distribute_tool: 'incredibuild' | 'sn_dbs' | 'distcc' | 'sccache' | 'built_in';
    /** Shared build cache */
    cache_enabled: boolean;
    cache_size_gb: number;
    /** Max parallel compilations per agent */
    parallel_jobs_per_agent: number;
}

export interface BuildJob {
    id: string;
    platform: string;
    config: 'debug' | 'development' | 'shipping' | 'test';
    status: 'queued' | 'building' | 'succeeded' | 'failed' | 'cancelled';
    start_time?: string;
    duration_sec?: number;
    agent_id?: string;
    error_log?: string;
}

export interface RenderFarmConfig {
    /** Number of render nodes */
    node_count: number;
    /** GPU type per node */
    gpu_type: string;
    /** GPU VRAM per node */
    gpu_vram_gb: number;
    /** Render tasks */
    task_types: Array<'lightmap_bake' | 'gi_bake' | 'cinematic_render' | 'texture_bake' | 'reflection_probe'>;
}

export interface AssetCookerConfig {
    /** Platform-specific packaging */
    target_platforms: Array<{
        platform: string;
        gpu_api: GpuApi;
        texture_format: string;
        max_texture_size: number;
        compress_meshes: boolean;
    }>;
    /** Strip debug data for shipping */
    strip_debug: boolean;
    /** Generate content hashes for patching */
    content_hashing: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 4. MULTIPLAYER NETCODE TESTING
// ══════════════════════════════════════════════════════════════════

export type NetcodeModel = 'client_server' | 'p2p' | 'relay' | 'deterministic_lockstep' | 'rollback';

export interface NetcodeSimulatorConfig {
    model: NetcodeModel;
    tick_rate_hz: number;
    /** Rollback frames buffer */
    rollback_frames: number;
    /** Interpolation delay in ticks */
    interpolation_delay: number;
    /** State serialization format */
    serialization: 'binary' | 'json' | 'protobuf' | 'flatbuffers';
    /** Jitter buffer size in ms */
    jitter_buffer_ms: number;
}

export interface MultiClientTestConfig {
    /** Number of simulated clients */
    client_count: number;
    /** Per-client network conditions */
    client_profiles: Array<{
        client_id: string;
        network: NetworkProfile;
        /** Simulated input latency in ms */
        input_delay_ms: number;
        /** Region simulation */
        region: string;
    }>;
    /** Server hardware */
    server_hardware: VmHardwareSpec;
    /** Test duration in seconds */
    duration_sec: number;
    /** Record replay data */
    record_replay: boolean;
}

export interface MatchmakingTestConfig {
    /** Number of simulated players in pool */
    player_pool_size: number;
    /** MMR distribution (mean, stddev) */
    mmr_distribution: { mean: number; stddev: number };
    /** Max queue time before expanding search */
    max_queue_time_sec: number;
    /** Team size */
    team_size: number;
    /** Matchmaking algorithm */
    algorithm: 'elo' | 'trueskill' | 'glicko2' | 'custom';
}

export interface NetcodeTestResult {
    avg_desync_events: number;
    rollback_frequency_per_sec: number;
    avg_state_size_bytes: number;
    bandwidth_per_client_kbps: number;
    worst_case_latency_ms: number;
    client_disconnect_count: number;
    server_tick_overrun_count: number;
}

// ══════════════════════════════════════════════════════════════════
// 5. ASSET PIPELINE & MANAGEMENT
// ══════════════════════════════════════════════════════════════════

export type TextureFormat = 'astc' | 'bc7' | 'bc5' | 'bc3' | 'etc2' | 'pvrtc' | 'raw' | 'ktx2';

export interface AssetPipelineConfig {
    /** Source asset directory */
    source_dir: string;
    /** Output directory */
    output_dir: string;
    /** Asset processing stages */
    stages: AssetPipelineStage[];
    /** Enable incremental builds */
    incremental: boolean;
    /** Dependency tracking */
    track_dependencies: boolean;
    /** Large file storage backend */
    lfs_backend: 'git_lfs' | 'perforce' | 'plastic_scm' | 'built_in';
}

export type AssetPipelineStage =
    | { type: 'texture_compress'; format: TextureFormat; quality: number; max_size: number }
    | { type: 'mesh_lod'; levels: number; quality_per_level: number[] }
    | { type: 'audio_transcode'; format: 'ogg' | 'aac' | 'opus' | 'wav'; bitrate_kbps: number }
    | { type: 'sprite_atlas'; max_size: number; padding: number }
    | { type: 'animation_compress'; error_threshold: number }
    | { type: 'bundle'; bundle_name: string; streaming: boolean }
    | { type: 'custom'; script_path: string; args: string[] };

export interface AssetBundleConfig {
    /** Bundle name */
    name: string;
    /** Assets in this bundle */
    asset_paths: string[];
    /** Dependency bundles */
    dependencies: string[];
    /** Streaming priority (lower = higher) */
    priority: number;
    /** Compression */
    compression: 'lz4' | 'lzma' | 'zstd' | 'none';
    /** Max bundle size before splitting */
    max_size_mb: number;
}

// ══════════════════════════════════════════════════════════════════
// 6. PHYSICS DEBUGGING
// ══════════════════════════════════════════════════════════════════

export type PhysicsEngine = 'box2d' | 'physx' | 'bullet' | 'havok' | 'jolt' | 'rapier' | 'built_in';

export interface PhysicsDebuggerConfig {
    engine: PhysicsEngine;
    /** Visualize collision shapes */
    show_colliders: boolean;
    /** Show contact points */
    show_contacts: boolean;
    /** Show velocity vectors */
    show_velocities: boolean;
    /** Show raycasts */
    show_raycasts: boolean;
    /** Show broadphase AABB */
    show_broadphase: boolean;
    /** Show collision layers/masks */
    show_layers: boolean;
    /** Deterministic replay seed */
    replay_seed?: number;
}

export interface PhysicsProfileResult {
    active_bodies: number;
    sleeping_bodies: number;
    broadphase_time_ms: number;
    narrowphase_time_ms: number;
    solver_time_ms: number;
    total_step_time_ms: number;
    contact_count: number;
    constraint_count: number;
}

// ══════════════════════════════════════════════════════════════════
// 7. INPUT DEVICE EMULATION
// ══════════════════════════════════════════════════════════════════

export type GamepadType = 'xbox_series' | 'ps5_dualsense' | 'switch_pro' | 'steam_deck' | 'generic_xinput' | 'generic_dinput';

export interface GamepadEmulatorConfig {
    type: GamepadType;
    /** Dead zone configuration */
    stick_deadzone: number;
    /** Trigger sensitivity */
    trigger_sensitivity: number;
    /** Enable rumble/haptics */
    haptics_enabled: boolean;
    /** Adaptive trigger resistance (PS5) */
    adaptive_triggers?: { left: number; right: number };
    /** Gyroscope simulation */
    gyro_enabled: boolean;
}

export interface TouchSimulatorConfig {
    /** Max simultaneous touch points */
    max_touches: number;
    /** Screen DPI simulation */
    dpi: number;
    /** Gesture recognition */
    gestures: Array<'tap' | 'double_tap' | 'long_press' | 'swipe' | 'pinch' | 'rotate' | 'pan'>;
    /** Pressure sensitivity (3D Touch / Force Touch) */
    pressure_levels: number;
}

export interface VrControllerConfig {
    /** Controller type */
    type: 'quest_touch_pro' | 'quest3_controllers' | 'vive_focus' | 'index_knuckles' | 'psvr2_sense';
    /** 6DOF tracking */
    tracking_dof: 3 | 6;
    /** Finger tracking (Quest hand tracking) */
    finger_tracking: boolean;
    /** Eye tracking */
    eye_tracking: boolean;
    /** Haptic channels */
    haptic_channels: number;
}

export interface InputRecordingConfig {
    /** Record all input events */
    record: boolean;
    /** Playback recorded input for regression testing */
    playback_path?: string;
    /** Playback speed multiplier */
    playback_speed: number;
    /** Frame-perfect deterministic replay */
    deterministic: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 8. GAME QA & AUTOMATED PLAYTESTING
// ══════════════════════════════════════════════════════════════════

export interface PlaytestBotConfig {
    /** Exploration strategy */
    strategy: 'random_walk' | 'systematic' | 'ml_curiosity' | 'directed';
    /** Max exploration time in minutes */
    max_duration_min: number;
    /** Detect stuck states */
    stuck_detection: boolean;
    /** Screenshot on anomaly */
    screenshot_on_anomaly: boolean;
    /** Log coverage map (% of level explored) */
    coverage_tracking: boolean;
}

export interface PerformanceGateConfig {
    /** Minimum acceptable FPS */
    min_fps: number;
    /** Maximum acceptable frame time variance */
    max_frame_time_variance_ms: number;
    /** Maximum acceptable memory usage */
    max_memory_mb: number;
    /** Maximum acceptable load time */
    max_load_time_sec: number;
    /** Block deployment if gate fails */
    block_deploy: boolean;
    /** Target device for testing */
    target_device_template: string;
}

export interface ScreenshotComparisonConfig {
    /** Reference screenshot directory */
    reference_dir: string;
    /** Maximum pixel difference threshold (0-1) */
    diff_threshold: number;
    /** Regions to exclude from comparison */
    exclude_regions: Array<{ x: number; y: number; width: number; height: number }>;
    /** Generate diff image on failure */
    generate_diff_image: boolean;
}

// ══════════════════════════════════════════════════════════════════
// 9. MEMORY PROFILING (GAME-SPECIFIC)
// ══════════════════════════════════════════════════════════════════

export interface MemoryProfilerConfig {
    /** Track all allocations */
    track_allocations: boolean;
    /** Track per-category budgets */
    budgets: MemoryBudget;
    /** Snapshot interval in seconds */
    snapshot_interval_sec: number;
    /** Alert on budget exceed */
    alert_on_exceed: boolean;
    /** Leak detection heuristic */
    leak_detection: boolean;
}

export interface MemoryBudget {
    /** Target platform memory ceiling */
    total_budget_mb: number;
    textures_mb: number;
    meshes_mb: number;
    audio_mb: number;
    scripts_mb: number;
    physics_mb: number;
    animation_mb: number;
    ui_mb: number;
    misc_mb: number;
}

/** Preset memory budgets for common platforms */
export const MEMORY_BUDGETS: Record<string, MemoryBudget> = {
    switch: { total_budget_mb: 3200, textures_mb: 1200, meshes_mb: 600, audio_mb: 300, scripts_mb: 200, physics_mb: 200, animation_mb: 200, ui_mb: 150, misc_mb: 350 },
    steam_deck: { total_budget_mb: 12000, textures_mb: 4000, meshes_mb: 2000, audio_mb: 1000, scripts_mb: 500, physics_mb: 500, animation_mb: 800, ui_mb: 400, misc_mb: 2800 },
    mobile_low: { total_budget_mb: 1500, textures_mb: 500, meshes_mb: 300, audio_mb: 150, scripts_mb: 100, physics_mb: 100, animation_mb: 100, ui_mb: 80, misc_mb: 170 },
    mobile_high: { total_budget_mb: 4000, textures_mb: 1500, meshes_mb: 800, audio_mb: 400, scripts_mb: 300, physics_mb: 200, animation_mb: 300, ui_mb: 200, misc_mb: 300 },
    console: { total_budget_mb: 12000, textures_mb: 4000, meshes_mb: 2500, audio_mb: 1000, scripts_mb: 500, physics_mb: 600, animation_mb: 800, ui_mb: 400, misc_mb: 2200 },
    pc_high: { total_budget_mb: 32000, textures_mb: 12000, meshes_mb: 6000, audio_mb: 2000, scripts_mb: 1000, physics_mb: 1500, animation_mb: 2000, ui_mb: 800, misc_mb: 6700 },
};

export interface MemorySnapshotDiff {
    timestamp_a: string;
    timestamp_b: string;
    delta_total_mb: number;
    delta_by_category: Record<string, number>;
    leaked_allocations: Array<{
        address: string;
        size_bytes: number;
        stack_trace: string;
        age_sec: number;
    }>;
    fragmentation_pct: number;
}

// ══════════════════════════════════════════════════════════════════
// 10. CROSS-PLATFORM BUILD MATRIX
// ══════════════════════════════════════════════════════════════════

export interface BuildMatrixConfig {
    /** Matrix of platform×arch×config combinations */
    entries: BuildMatrixEntry[];
    /** Run all combinations in parallel */
    parallel: boolean;
    /** Fail fast — cancel all on first failure */
    fail_fast: boolean;
    /** Performance gate per entry */
    perf_gates?: Record<string, PerformanceGateConfig>;
}

export interface BuildMatrixEntry {
    platform: string;
    arch: string;
    config: 'debug' | 'development' | 'shipping' | 'test';
    gpu_api: GpuApi;
    enabled: boolean;
}

export interface StoreSubmissionConfig {
    store: 'app_store' | 'google_play' | 'steam' | 'epic_games' | 'microsoft_store' | 'meta_quest' | 'itch_io';
    auto_upload: boolean;
    /** Metadata templates */
    metadata: {
        title: string;
        description: string;
        screenshots: string[];
        age_rating: string;
        categories: string[];
    };
    /** Beta testing track */
    beta_track?: string;
}

// ══════════════════════════════════════════════════════════════════
// 11. PLUGIN / SDK SANDBOX
// ══════════════════════════════════════════════════════════════════

export interface SdkSandboxConfig {
    /** SDK identifier */
    sdk_name: string;
    /** SDK version */
    sdk_version: string;
    /** Isolated test environment */
    isolation_level: 'process' | 'container' | 'vm';
    /** Mock backend services */
    mock_services: SdkMockService[];
    /** Detect symbol/dependency clashes */
    conflict_detection: boolean;
}

export interface SdkMockService {
    service: 'firebase' | 'playfab' | 'steam_api' | 'epic_eos' | 'game_center' | 'google_play_services' | 'admob' | 'unity_ads' | 'custom';
    /** Mock response configuration */
    responses: Record<string, unknown>;
    /** Simulate latency */
    latency_ms: number;
    /** Simulate errors */
    error_rate_pct: number;
}

// ══════════════════════════════════════════════════════════════════
// 12. GAME DEV TIER LIMITS
// ══════════════════════════════════════════════════════════════════

export interface GameDevTierLimits {
    gpu_profiling: boolean;
    shader_hot_reload: boolean;
    build_farm_agents: number;
    render_farm_nodes: number;
    netcode_test_clients: number;
    asset_pipeline_stages: number;
    physics_debugger: boolean;
    input_emulation: boolean;
    memory_profiler: boolean;
    build_matrix_entries: number;
    store_submissions: string[];
    sdk_sandboxes: number;
    playtest_bots: number;
    perf_gates: boolean;
}

export const GAME_DEV_TIERS: Record<ScmTier, GameDevTierLimits> = {
    free: {
        gpu_profiling: false,
        shader_hot_reload: false,
        build_farm_agents: 0,
        render_farm_nodes: 0,
        netcode_test_clients: 2,
        asset_pipeline_stages: 3,
        physics_debugger: false,
        input_emulation: false,
        memory_profiler: false,
        build_matrix_entries: 2,
        store_submissions: [],
        sdk_sandboxes: 1,
        playtest_bots: 0,
        perf_gates: false,
    },
    standard: {
        gpu_profiling: true,
        shader_hot_reload: true,
        build_farm_agents: 2,
        render_farm_nodes: 1,
        netcode_test_clients: 8,
        asset_pipeline_stages: 10,
        physics_debugger: true,
        input_emulation: true,
        memory_profiler: true,
        build_matrix_entries: 6,
        store_submissions: ['steam', 'itch_io'],
        sdk_sandboxes: 3,
        playtest_bots: 1,
        perf_gates: true,
    },
    advanced: {
        gpu_profiling: true,
        shader_hot_reload: true,
        build_farm_agents: 8,
        render_farm_nodes: 4,
        netcode_test_clients: 32,
        asset_pipeline_stages: Infinity,
        physics_debugger: true,
        input_emulation: true,
        memory_profiler: true,
        build_matrix_entries: 20,
        store_submissions: ['steam', 'itch_io', 'app_store', 'google_play', 'epic_games', 'meta_quest'],
        sdk_sandboxes: 10,
        playtest_bots: 5,
        perf_gates: true,
    },
    enterprise: {
        gpu_profiling: true,
        shader_hot_reload: true,
        build_farm_agents: Infinity,
        render_farm_nodes: Infinity,
        netcode_test_clients: Infinity,
        asset_pipeline_stages: Infinity,
        physics_debugger: true,
        input_emulation: true,
        memory_profiler: true,
        build_matrix_entries: Infinity,
        store_submissions: ['steam', 'itch_io', 'app_store', 'google_play', 'epic_games', 'meta_quest', 'microsoft_store'],
        sdk_sandboxes: Infinity,
        playtest_bots: Infinity,
        perf_gates: true,
    },
};

// ══════════════════════════════════════════════════════════════════
// 13. GAME-OPTIMIZED DEVICE TEMPLATES
// ══════════════════════════════════════════════════════════════════

import type { DeviceTemplate } from './types.js';

export const GAME_DEV_TEMPLATES: DeviceTemplate[] = [
    {
        id: 'game-dev-workstation',
        name: 'Game Dev Workstation',
        description: 'High-GPU workstation for Unity/Unreal/Godot development. Dual-GPU, 64GB RAM, NVMe storage.',
        platform: 'linux',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'x86_64', cpu_cores: 16, ram_gb: 64,
            storage_gb: 1024, gpu_enabled: true, gpu_vram_gb: 16, network_mode: 'bridged',
        },
        os_versions: ['Ubuntu 24.04', 'Windows 11 Pro'],
        preview_image: '/vm/game-dev-workstation.png',
        device_variants: ['Mid-range (8GB VRAM)', 'High-end (16GB VRAM)', 'Ultra (24GB VRAM)'],
        min_tier: 'standard',
    },
    {
        id: 'gpu-compute-cluster',
        name: 'GPU Compute Cluster',
        description: 'Multi-GPU server for ML training, render farms, and lightmap baking. Up to 8× GPUs.',
        platform: 'linux',
        form_factor: 'server',
        arch: ['x86_64'],
        default_hardware: {
            cpu_arch: 'x86_64', cpu_cores: 32, ram_gb: 128,
            storage_gb: 2048, gpu_enabled: true, gpu_vram_gb: 48, network_mode: 'bridged',
        },
        os_versions: ['Ubuntu 22.04 Server', 'Rocky Linux 9'],
        preview_image: '/vm/gpu-compute-cluster.png',
        device_variants: ['2× GPU', '4× GPU', '8× GPU'],
        min_tier: 'advanced',
    },
    {
        id: 'webgpu-browser-test',
        name: 'WebGPU Browser Test',
        description: 'Chrome/Firefox with WebGPU enabled for web-based game and 3D visualization testing.',
        platform: 'linux',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 64, gpu_enabled: true, gpu_vram_gb: 4, network_mode: 'bridged',
        },
        os_versions: ['Chrome 130+', 'Firefox 130+', 'Safari 18+'],
        preview_image: '/vm/webgpu-browser.png',
        device_variants: ['Chrome', 'Firefox', 'Safari', 'Multi-browser'],
        min_tier: 'standard',
    },
    {
        id: 'console-devkit',
        name: 'Console DevKit Emulator',
        description: 'Console development kit emulator for Switch, PlayStation, Xbox performance profiling and submission testing.',
        platform: 'linux',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'x86_64', cpu_cores: 8, ram_gb: 16,
            storage_gb: 256, gpu_enabled: true, gpu_vram_gb: 8, network_mode: 'bridged',
        },
        os_versions: ['Switch Profile', 'PS5 Profile', 'Xbox Series Profile'],
        preview_image: '/vm/console-devkit.png',
        device_variants: ['Switch (4GB profile)', 'PS5 (16GB profile)', 'Xbox Series X (16GB profile)', 'Steam Deck (16GB profile)'],
        min_tier: 'advanced',
    },
];
