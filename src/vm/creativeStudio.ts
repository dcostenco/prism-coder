/**
 * Creative Studio — 3D/5D Visualization, Video Production, Audio Generation
 * ══════════════════════════════════════════════════════════════════════════
 *
 * High-quality creative production tools integrated into Prism IDE:
 *   - 3D/5D vector visualization and design
 *   - Video clip creation and editing
 *   - Audio generation and production
 *   - All tier-gated through Synalux subscription
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. 3D / 5D VECTOR VISUALIZATION & DESIGN
// ══════════════════════════════════════════════════════════════════

export type RenderEngine = 'raytracing' | 'rasterization' | 'path_tracing' | 'hybrid';
export type SceneFormat = 'gltf' | 'usdz' | 'fbx' | 'obj' | 'blend' | 'step' | 'iges';

export interface Vector3D {
    x: number; y: number; z: number;
}

/** 5D vector: 3D position + 2D parametric (UV, time-phase, etc.) */
export interface Vector5D {
    x: number; y: number; z: number;
    u: number; v: number;
}

export interface Visualization3DConfig {
    /** Render engine */
    engine: RenderEngine;
    /** Output resolution */
    resolution: { width: number; height: number };
    /** Samples per pixel (for ray/path tracing) */
    samples_per_pixel: number;
    /** Max bounce depth */
    max_bounces: number;
    /** HDR environment map */
    environment_map?: string;
    /** Tone mapping */
    tone_mapping: 'aces' | 'filmic' | 'reinhard' | 'linear';
    /** Anti-aliasing */
    anti_aliasing: 'none' | 'fxaa' | 'taa' | 'msaa_2x' | 'msaa_4x' | 'msaa_8x';
    /** Real-time preview FPS target */
    preview_fps: number;
}

export interface Visualization5DConfig extends Visualization3DConfig {
    /** Extra dimensions for parametric visualization */
    param_dimensions: Array<{
        name: string;
        min: number;
        max: number;
        step: number;
        /** Map to visual property */
        visual_mapping: 'color' | 'size' | 'opacity' | 'displacement' | 'animation_time';
    }>;
    /** Data source for 5D point clouds */
    data_source?: 'csv' | 'json' | 'binary' | 'live_stream';
    /** Interpolation between data points */
    interpolation: 'nearest' | 'linear' | 'cubic' | 'catmull_rom';
}

export interface Scene3DObject {
    id: string;
    name: string;
    type: 'mesh' | 'light' | 'camera' | 'particle_system' | 'volume' | 'curve' | 'text_3d';
    position: Vector3D;
    rotation: Vector3D;
    scale: Vector3D;
    material?: MaterialConfig;
    children: string[];
    visible: boolean;
    /** LOD levels */
    lod_levels?: Array<{ distance: number; mesh_path: string; triangle_count: number }>;
}

export interface MaterialConfig {
    type: 'pbr' | 'unlit' | 'toon' | 'glass' | 'subsurface' | 'custom_shader';
    albedo_color?: string;
    albedo_texture?: string;
    normal_map?: string;
    metallic: number;
    roughness: number;
    emissive_color?: string;
    emissive_strength: number;
    opacity: number;
    /** Custom shader path (for type: 'custom_shader') */
    shader_path?: string;
}

export interface SceneExportConfig {
    format: SceneFormat;
    /** Embed textures in file */
    embed_textures: boolean;
    /** Draco mesh compression */
    mesh_compression: boolean;
    /** KTX2 texture compression */
    texture_compression: boolean;
    /** Animation export */
    include_animations: boolean;
    /** Target platform optimization */
    target: 'web' | 'mobile' | 'desktop' | 'vr' | 'ar';
}

// ══════════════════════════════════════════════════════════════════
// 2. VIDEO CLIP CREATION & EDITING
// ══════════════════════════════════════════════════════════════════

export type VideoCodec = 'h264' | 'h265' | 'av1' | 'vp9' | 'prores' | 'dnxhr';
export type VideoContainer = 'mp4' | 'mov' | 'webm' | 'mkv' | 'gif' | 'apng';

export interface VideoProjectConfig {
    /** Output resolution */
    resolution: { width: number; height: number };
    /** Frame rate */
    fps: 24 | 30 | 48 | 60 | 120;
    /** Duration in seconds */
    duration_sec: number;
    /** Color space */
    color_space: 'srgb' | 'rec709' | 'rec2020' | 'dci_p3';
    /** HDR */
    hdr: boolean;
    /** Codec */
    codec: VideoCodec;
    /** Container */
    container: VideoContainer;
    /** Bitrate in Mbps */
    bitrate_mbps: number;
}

export interface VideoTimeline {
    tracks: VideoTrack[];
    markers: Array<{ time_sec: number; label: string; color: string }>;
    duration_sec: number;
}

export type VideoTrack =
    | { type: 'video'; clips: VideoClip[] }
    | { type: 'audio'; clips: AudioClip[] }
    | { type: 'text'; clips: TextOverlay[] }
    | { type: 'effect'; clips: EffectClip[] };

export interface VideoClip {
    id: string;
    source_path: string;
    start_time_sec: number;
    duration_sec: number;
    /** Trim points within source */
    in_point_sec: number;
    out_point_sec: number;
    /** Playback speed (1.0 = normal) */
    speed: number;
    /** Transition to next clip */
    transition?: { type: 'cut' | 'dissolve' | 'fade' | 'wipe' | 'slide'; duration_sec: number };
    /** Color grading / LUT */
    color_lut?: string;
}

export interface AudioClip {
    id: string;
    source_path: string;
    start_time_sec: number;
    duration_sec: number;
    volume: number;
    /** Fade in/out in seconds */
    fade_in_sec: number;
    fade_out_sec: number;
    /** Pan (-1=left, 0=center, 1=right) */
    pan: number;
}

export interface TextOverlay {
    id: string;
    text: string;
    start_time_sec: number;
    duration_sec: number;
    position: { x: number; y: number };
    font: string;
    font_size: number;
    color: string;
    background_color?: string;
    /** Animation */
    animation: 'none' | 'fade_in' | 'typewriter' | 'slide_up' | 'bounce';
}

export interface EffectClip {
    id: string;
    effect: 'blur' | 'sharpen' | 'vignette' | 'film_grain' | 'chromatic_aberration' | 'bloom' | 'lens_flare' | 'custom';
    start_time_sec: number;
    duration_sec: number;
    intensity: number;
    /** Custom shader for effect: 'custom' */
    shader_path?: string;
}

/** Cinematic camera for automated trailer generation */
export interface CinematicCameraPath {
    name: string;
    keyframes: Array<{
        time_sec: number;
        position: Vector3D;
        look_at: Vector3D;
        fov_degrees: number;
        /** Depth of field */
        dof_focus_distance?: number;
        dof_aperture?: number;
    }>;
    interpolation: 'linear' | 'bezier' | 'catmull_rom';
    /** Total path duration */
    duration_sec: number;
}

export interface ScreenRecorderConfig {
    /** Capture resolution */
    resolution: { width: number; height: number };
    /** Capture FPS */
    fps: 30 | 60 | 120;
    /** Codec */
    codec: VideoCodec;
    /** Lossless mode */
    lossless: boolean;
    /** Include audio */
    capture_audio: boolean;
    /** Include cursor */
    capture_cursor: boolean;
    /** Auto-trim dead frames */
    auto_trim: boolean;
    /** Max recording length in seconds */
    max_duration_sec: number;
    /** GIF export shortcut */
    gif_mode?: { max_colors: number; dither: boolean; loop: boolean };
}

// ══════════════════════════════════════════════════════════════════
// 3. AUDIO GENERATION & PRODUCTION
// ══════════════════════════════════════════════════════════════════

export type AudioFormat = 'wav' | 'mp3' | 'ogg' | 'aac' | 'flac' | 'opus';
export type AudioChannelLayout = 'mono' | 'stereo' | '5.1' | '7.1' | 'binaural' | 'atmos' | 'ambisonics';

export interface AudioProjectConfig {
    /** Sample rate */
    sample_rate: 22050 | 44100 | 48000 | 96000;
    /** Bit depth */
    bit_depth: 16 | 24 | 32;
    /** Channel layout */
    channels: AudioChannelLayout;
    /** Output format */
    format: AudioFormat;
    /** Project tempo (BPM) for music */
    tempo_bpm?: number;
    /** Time signature */
    time_signature?: { numerator: number; denominator: number };
}

export interface AudioGenerationConfig {
    /** Generation type */
    type: 'music' | 'sfx' | 'ambient' | 'voice' | 'foley';
    /** Text prompt for AI generation */
    prompt: string;
    /** Duration in seconds */
    duration_sec: number;
    /** Style/genre */
    style?: string;
    /** Reference audio for style matching */
    reference_audio?: string;
    /** Variation count */
    variations: number;
    /** Seed for reproducibility */
    seed?: number;
}

export interface SpatialAudioConfig {
    /** HRTF profile */
    hrtf_profile: 'generic' | 'custom';
    /** Reverb zones */
    reverb_zones: Array<{
        name: string;
        position: { x: number; y: number; z: number };
        radius: number;
        preset: 'small_room' | 'large_hall' | 'outdoor' | 'cave' | 'stadium' | 'custom';
        decay_time_sec: number;
        wet_mix: number;
    }>;
    /** Distance attenuation curve */
    attenuation_model: 'inverse' | 'linear' | 'logarithmic' | 'custom';
    /** Max audible distance */
    max_distance: number;
    /** Doppler effect */
    doppler_enabled: boolean;
    doppler_factor: number;
    /** Occlusion (sound blocked by geometry) */
    occlusion_enabled: boolean;
}

export interface AudioMixerConfig {
    /** Master volume (0-1) */
    master_volume: number;
    /** Mix buses */
    buses: Array<{
        name: string;
        volume: number;
        /** DSP effects chain */
        effects: AudioEffect[];
        /** Sidechain source */
        sidechain?: string;
    }>;
}

export type AudioEffect =
    | { type: 'eq'; bands: Array<{ frequency_hz: number; gain_db: number; q: number }> }
    | { type: 'compressor'; threshold_db: number; ratio: number; attack_ms: number; release_ms: number }
    | { type: 'reverb'; preset: string; wet_mix: number }
    | { type: 'delay'; time_ms: number; feedback: number; wet_mix: number }
    | { type: 'distortion'; drive: number; tone: number }
    | { type: 'chorus'; rate_hz: number; depth: number; wet_mix: number }
    | { type: 'limiter'; ceiling_db: number }
    | { type: 'custom'; plugin_path: string; params: Record<string, number> };

export interface AudioDeviceEmulatorConfig {
    /** Simulate different output hardware */
    device: 'studio_monitors' | 'headphones' | 'earbuds' | 'tv_speakers' | 'phone_speaker' | 'gaming_headset' | 'car_stereo' | 'laptop_speakers';
    /** Frequency response simulation */
    frequency_response_enabled: boolean;
}

export interface AudioProfileResult {
    /** Active voice/channel count */
    active_voices: number;
    /** DSP CPU usage percentage */
    dsp_cpu_pct: number;
    /** Streaming buffer underruns */
    buffer_underruns: number;
    /** Peak level (dBFS) */
    peak_level_dbfs: number;
    /** Latency from trigger to output */
    latency_ms: number;
    /** Memory used by audio */
    memory_used_mb: number;
}

// ══════════════════════════════════════════════════════════════════
// 4. CREATIVE STUDIO TIER LIMITS
// ══════════════════════════════════════════════════════════════════

export interface CreativeStudioTierLimits {
    /** 3D visualization */
    viz_3d_enabled: boolean;
    /** 5D parametric visualization */
    viz_5d_enabled: boolean;
    /** Max render resolution (longest edge) */
    max_render_resolution: number;
    /** Ray/path tracing */
    raytracing_enabled: boolean;
    /** Samples per pixel limit */
    max_spp: number;

    /** Video production */
    video_enabled: boolean;
    /** Max video export resolution */
    max_video_resolution: number;
    /** Max video duration in seconds */
    max_video_duration_sec: number;
    /** Codecs available */
    video_codecs: VideoCodec[];
    /** Screen recorder */
    screen_recorder: boolean;
    /** Cinematic camera */
    cinematic_camera: boolean;

    /** Audio production */
    audio_enabled: boolean;
    /** AI audio generation */
    ai_audio_generation: boolean;
    /** Max audio duration per generation */
    max_audio_gen_sec: number;
    /** Spatial audio */
    spatial_audio: boolean;
    /** Max sample rate */
    max_sample_rate: number;
    /** Audio device emulator */
    audio_device_emulator: boolean;
}

export const CREATIVE_STUDIO_TIERS: Record<ScmTier, CreativeStudioTierLimits> = {
    free: {
        viz_3d_enabled: true,
        viz_5d_enabled: false,
        max_render_resolution: 1920,
        raytracing_enabled: false,
        max_spp: 16,
        video_enabled: true,
        max_video_resolution: 1080,
        max_video_duration_sec: 60,
        video_codecs: ['h264'],
        screen_recorder: true,
        cinematic_camera: false,
        audio_enabled: true,
        ai_audio_generation: false,
        max_audio_gen_sec: 0,
        spatial_audio: false,
        max_sample_rate: 44100,
        audio_device_emulator: false,
    },
    standard: {
        viz_3d_enabled: true,
        viz_5d_enabled: true,
        max_render_resolution: 4096,
        raytracing_enabled: true,
        max_spp: 128,
        video_enabled: true,
        max_video_resolution: 2160,
        max_video_duration_sec: 300,
        video_codecs: ['h264', 'h265', 'vp9'],
        screen_recorder: true,
        cinematic_camera: true,
        audio_enabled: true,
        ai_audio_generation: true,
        max_audio_gen_sec: 30,
        spatial_audio: true,
        max_sample_rate: 48000,
        audio_device_emulator: true,
    },
    advanced: {
        viz_3d_enabled: true,
        viz_5d_enabled: true,
        max_render_resolution: 8192,
        raytracing_enabled: true,
        max_spp: 1024,
        video_enabled: true,
        max_video_resolution: 4320,
        max_video_duration_sec: 1800,
        video_codecs: ['h264', 'h265', 'av1', 'vp9', 'prores'],
        screen_recorder: true,
        cinematic_camera: true,
        audio_enabled: true,
        ai_audio_generation: true,
        max_audio_gen_sec: 120,
        spatial_audio: true,
        max_sample_rate: 96000,
        audio_device_emulator: true,
    },
    enterprise: {
        viz_3d_enabled: true,
        viz_5d_enabled: true,
        max_render_resolution: Infinity,
        raytracing_enabled: true,
        max_spp: Infinity,
        video_enabled: true,
        max_video_resolution: Infinity,
        max_video_duration_sec: Infinity,
        video_codecs: ['h264', 'h265', 'av1', 'vp9', 'prores', 'dnxhr'],
        screen_recorder: true,
        cinematic_camera: true,
        audio_enabled: true,
        ai_audio_generation: true,
        max_audio_gen_sec: Infinity,
        spatial_audio: true,
        max_sample_rate: 96000,
        audio_device_emulator: true,
    },
};
