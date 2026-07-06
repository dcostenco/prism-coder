/**
 * VM & Device Types — Prism IDE Integration
 * ==========================================
 * Interfaces for virtual machine management, device templates,
 * and deployment pipelines. Apps deployed via this system inherit
 * Synalux subscription tiers (free → enterprise).
 *
 * Only interfaces live in Prism — implementations stay in Synalux.
 *
 * @see Synalux portal — vm-manager, device-registry
 */

import type { ScmTier } from '../scm/types.js';

// ── CPU Architecture ────────────────────────────────────────

export type CpuArch = 'x86_64' | 'arm64' | 'universal';

// ── Hypervisor Support ──────────────────────────────────────

export type HypervisorType =
    | 'apple_virtualization'   // macOS native (Apple Silicon)
    | 'vmware_fusion'          // VMware Fusion / Workstation
    | 'parallels'              // Parallels Desktop
    | 'qemu'                   // QEMU/KVM (Linux)
    | 'hyper_v'                // Windows Hyper-V
    | 'xcode_simulator'        // iOS/watchOS/tvOS/visionOS simulators
    | 'android_emulator'       // Android AVD
    | 'reality_simulator'      // visionOS / Meta Horizon OS
    | 'custom';                // User-provided

// ── OS Platform ─────────────────────────────────────────────

export type OsPlatform =
    | 'linux'
    | 'windows'
    | 'macos'
    | 'ios'
    | 'ipados'
    | 'watchos'
    | 'tvos'
    | 'visionos'        // Apple Vision Pro
    | 'meta_horizon'    // Meta Quest
    | 'android'
    | 'wear_os'
    | 'custom';

// ── Device Form Factor ──────────────────────────────────────

export type DeviceFormFactor =
    | 'desktop'
    | 'laptop'
    | 'server'
    | 'phone'
    | 'tablet'
    | 'watch'
    | 'headset'         // VR/AR/MR headsets
    | 'tv'
    | 'embedded'
    | 'custom';

// ── Network Profiles ────────────────────────────────────────

export type NetworkType =
    | 'ethernet_1g'
    | 'ethernet_10g'
    | 'wifi_6'
    | 'wifi_6e'
    | 'wifi_7'
    | '5g_cellular'
    | '4g_lte'
    | '3g'
    | 'satellite'
    | 'custom';

export interface NetworkProfile {
    type: NetworkType;
    /** Bandwidth limit in Mbps (0 = unlimited) */
    bandwidth_mbps: number;
    /** Simulated latency in ms */
    latency_ms: number;
    /** Packet loss percentage (0-100) */
    packet_loss_pct: number;
    /** Jitter in ms (variation in latency) */
    jitter_ms: number;
    /** DNS resolution delay in ms */
    dns_delay_ms?: number;
    /** Simulate connection drops every N seconds (0 = never) */
    drop_interval_sec?: number;
}

/** Preset network conditions for load testing */
export const NETWORK_PRESETS: Record<string, NetworkProfile> = {
    perfect: { type: 'ethernet_10g', bandwidth_mbps: 10_000, latency_ms: 0, packet_loss_pct: 0, jitter_ms: 0 },
    broadband: { type: 'ethernet_1g', bandwidth_mbps: 100, latency_ms: 5, packet_loss_pct: 0, jitter_ms: 1 },
    wifi_good: { type: 'wifi_6', bandwidth_mbps: 200, latency_ms: 10, packet_loss_pct: 0.1, jitter_ms: 3 },
    wifi_poor: { type: 'wifi_6', bandwidth_mbps: 15, latency_ms: 80, packet_loss_pct: 2, jitter_ms: 20 },
    '4g_normal': { type: '4g_lte', bandwidth_mbps: 30, latency_ms: 50, packet_loss_pct: 0.5, jitter_ms: 15 },
    '3g_slow': { type: '3g', bandwidth_mbps: 1.5, latency_ms: 300, packet_loss_pct: 3, jitter_ms: 100 },
    satellite: { type: 'satellite', bandwidth_mbps: 25, latency_ms: 600, packet_loss_pct: 1, jitter_ms: 50 },
    offline: { type: 'custom', bandwidth_mbps: 0, latency_ms: 0, packet_loss_pct: 100, jitter_ms: 0 },
    stress_test: { type: 'ethernet_1g', bandwidth_mbps: 1000, latency_ms: 0, packet_loss_pct: 5, jitter_ms: 50, drop_interval_sec: 30 },
    chaos: { type: 'custom', bandwidth_mbps: 10, latency_ms: 500, packet_loss_pct: 15, jitter_ms: 200, drop_interval_sec: 10 },
};

// ── Network Load Testing ────────────────────────────────────

export interface NetworkLoadTest {
    /** Name of the test scenario */
    name: string;
    /** Concurrent connections to simulate */
    concurrent_connections: number;
    /** Requests per second */
    rps: number;
    /** Test duration in seconds */
    duration_sec: number;
    /** Network profile to apply during the test */
    network_profile: NetworkProfile;
    /** Target URL or service to test against */
    target_url?: string;
    /** Ramp-up period in seconds (gradually increase load) */
    ramp_up_sec?: number;
    /** Payload size per request in bytes */
    payload_bytes?: number;
    /** Protocol */
    protocol: 'http' | 'https' | 'websocket' | 'grpc' | 'tcp' | 'udp';
}

export interface NetworkLoadTestResult {
    test_name: string;
    avg_latency_ms: number;
    p50_latency_ms: number;
    p95_latency_ms: number;
    p99_latency_ms: number;
    max_latency_ms: number;
    total_requests: number;
    successful_requests: number;
    failed_requests: number;
    throughput_rps: number;
    bandwidth_used_mbps: number;
    errors: Record<string, number>;
    duration_sec: number;
}

// ── Host Resource Sharing ───────────────────────────────────

export interface HostResourceSharing {
    /** Inherit host network (DNS, proxy, VPN) — default true for standard+ */
    inherit_network: boolean;
    /** Shared folders from host → VM */
    shared_drives: Array<{
        host_path: string;
        guest_mount: string;
        read_only: boolean;
    }>;
    /** USB/peripheral passthrough */
    peripheral_passthrough: boolean;
    /** Share host clipboard */
    clipboard_sync: boolean;
    /** Share host audio devices */
    audio_passthrough: boolean;
    /** Share host camera */
    camera_passthrough: boolean;
    /** Host printer access */
    printer_sharing: boolean;
    /** Inherit host timezone */
    inherit_timezone: boolean;
}

export const DEFAULT_HOST_SHARING: HostResourceSharing = {
    inherit_network: true,
    shared_drives: [],
    peripheral_passthrough: false,
    clipboard_sync: true,
    audio_passthrough: false,
    camera_passthrough: false,
    printer_sharing: false,
    inherit_timezone: true,
};

// ── Custom Hardware Configuration ───────────────────────────

export type StorageType = 'nvme_ssd' | 'sata_ssd' | 'hdd_7200' | 'hdd_5400' | 'ram_disk' | 'custom';
export type NicType = 'virtio' | 'e1000' | 'e1000e' | 'vmxnet3' | 'rtl8139' | 'custom';

export interface CustomHardwareConfig {
    /** CPU model override (e.g. "Apple M4 Max", "Intel i9-14900K", "AMD EPYC 9654") */
    cpu_model?: string;
    /** Storage type simulation */
    storage_type: StorageType;
    /** Storage IOPS limit (0 = unlimited) */
    storage_iops?: number;
    /** Storage bandwidth in MB/s (0 = unlimited) */
    storage_bandwidth_mbps?: number;
    /** Network interface card type */
    nic_type: NicType;
    /** Number of NICs */
    nic_count: number;
    /** TPM 2.0 module */
    tpm_enabled: boolean;
    /** Secure Boot */
    secure_boot: boolean;
    /** UEFI vs Legacy BIOS */
    firmware: 'uefi' | 'legacy_bios';
    /** Custom NUMA topology */
    numa_nodes?: number;
    /** Hardware RNG */
    hw_rng: boolean;
}

// ── VM Hardware Spec ────────────────────────────────────────

export interface VmHardwareSpec {
    cpu_arch: CpuArch;
    cpu_cores: number;
    ram_gb: number;
    storage_gb: number;
    gpu_enabled: boolean;
    gpu_vram_gb?: number;
    network_mode: 'nat' | 'bridged' | 'host_only' | 'none';
    /** Network simulation profile */
    network_profile?: NetworkProfile;
    /** Host resource sharing — standard VMs inherit host network/drives by default */
    host_sharing?: HostResourceSharing;
    /** Extended hardware config (storage type, NIC, TPM, etc.) */
    custom_hardware?: CustomHardwareConfig;
}

// ── VM Image ────────────────────────────────────────────────

export interface VmImage {
    id: string;
    name: string;
    platform: OsPlatform;
    version: string;               // e.g. "24.04 LTS", "11 Pro", "18.0"
    arch: CpuArch;
    form_factor: DeviceFormFactor;
    hypervisor: HypervisorType;
    hardware: VmHardwareSpec;

    /** Preview image URL for the IDE gallery */
    preview_image: string;

    /** Is this a built-in template or user-created? */
    source: 'builtin' | 'imported' | 'custom';

    /** For imported VMs: original file path (.vmx, .pvm, .ova, .qcow2) */
    import_path?: string;
    import_format?: 'vmx' | 'pvm' | 'ova' | 'qcow2' | 'vhdx' | 'raw';

    /** User-defined custom parameters (key-value pairs) */
    custom_params?: Record<string, string | number | boolean>;

    /** Synalux tier this VM's deployed apps inherit */
    inherited_tier: ScmTier;

    created_at: string;
    updated_at: string;
}

// ── Built-in Device Templates ───────────────────────────────

export interface DeviceTemplate {
    id: string;
    name: string;
    description: string;
    platform: OsPlatform;
    form_factor: DeviceFormFactor;
    arch: CpuArch[];              // Supported architectures
    default_hardware: VmHardwareSpec;
    os_versions: string[];        // Available OS versions
    preview_image: string;
    device_variants: string[];    // e.g. ["iPhone 16 Pro", "iPhone 16 Pro Max"]

    /** Min tier required to use this template */
    min_tier: ScmTier;
}

/**
 * Built-in device templates — the IDE gallery.
 * Users can create custom devices via VmImage with source: 'custom'.
 */
export const DEVICE_TEMPLATES: DeviceTemplate[] = [
    // ── Linux ───────────────────────────────────────────
    {
        id: 'linux-ubuntu',
        name: 'Ubuntu Server / Desktop',
        description: 'Ubuntu 24.04 LTS with full dev toolchain. Supports x86_64 and ARM64 natively.',
        platform: 'linux',
        form_factor: 'server',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 64, gpu_enabled: false, network_mode: 'bridged',
        },
        os_versions: ['24.04 LTS', '22.04 LTS', '20.04 LTS'],
        preview_image: '/vm/linux-ubuntu.png',
        device_variants: ['Ubuntu Desktop', 'Ubuntu Server', 'Ubuntu Minimal'],
        min_tier: 'free',
    },
    {
        id: 'linux-fedora',
        name: 'Fedora Workstation',
        description: 'Fedora 41 with GNOME desktop. Ideal for cutting-edge development.',
        platform: 'linux',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 64, gpu_enabled: false, network_mode: 'bridged',
        },
        os_versions: ['41', '40', '39'],
        preview_image: '/vm/linux-fedora.png',
        device_variants: ['Workstation', 'Server', 'CoreOS'],
        min_tier: 'free',
    },
    {
        id: 'linux-debian',
        name: 'Debian Stable',
        description: 'Debian 12 Bookworm — rock-solid server/container base. Ideal for production-mirroring.',
        platform: 'linux',
        form_factor: 'server',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 2, ram_gb: 4,
            storage_gb: 32, gpu_enabled: false, network_mode: 'bridged',
        },
        os_versions: ['12 Bookworm', '11 Bullseye'],
        preview_image: '/vm/linux-debian.png',
        device_variants: ['Desktop', 'Server', 'Minimal'],
        min_tier: 'free',
    },
    {
        id: 'linux-arch',
        name: 'Arch Linux',
        description: 'Arch Linux rolling release — bleeding-edge packages, fully customizable.',
        platform: 'linux',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 64, gpu_enabled: false, network_mode: 'bridged',
        },
        os_versions: ['rolling'],
        preview_image: '/vm/linux-arch.png',
        device_variants: ['Desktop', 'Server', 'Minimal'],
        min_tier: 'free',
    },

    // ── macOS ───────────────────────────────────────────
    {
        id: 'macos-sequoia',
        name: 'macOS Sequoia',
        description: 'macOS 15 Sequoia with Xcode, Homebrew, and full Apple dev toolchain. Apple Silicon native.',
        platform: 'macos',
        form_factor: 'desktop',
        arch: ['arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 8, ram_gb: 16,
            storage_gb: 128, gpu_enabled: true, gpu_vram_gb: 4, network_mode: 'bridged',
        },
        os_versions: ['15 Sequoia', '14 Sonoma', '13 Ventura'],
        preview_image: '/vm/macos-sequoia.png',
        device_variants: ['Mac mini', 'MacBook Pro 14"', 'MacBook Pro 16"', 'Mac Studio', 'Mac Pro'],
        min_tier: 'advanced',
    },

    // ── Windows ─────────────────────────────────────────
    {
        id: 'windows-11',
        name: 'Windows 11 Pro',
        description: 'Windows 11 with .NET, Visual Studio, and PowerShell. x86_64 and ARM64.',
        platform: 'windows',
        form_factor: 'desktop',
        arch: ['x86_64', 'arm64'],
        default_hardware: {
            cpu_arch: 'x86_64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 128, gpu_enabled: true, gpu_vram_gb: 2, network_mode: 'nat',
        },
        os_versions: ['11 Pro 24H2', '11 Pro 23H2', '10 Pro 22H2'],
        preview_image: '/vm/windows-11.png',
        device_variants: ['Windows 11 Pro', 'Windows 11 Enterprise', 'Windows Server 2025'],
        min_tier: 'standard',
    },

    // ── iOS / iPadOS ────────────────────────────────────
    {
        id: 'ios-simulator',
        name: 'iOS Simulator',
        description: 'Xcode iOS Simulator for iPhone and iPad. SwiftUI live preview included.',
        platform: 'ios',
        form_factor: 'phone',
        arch: ['arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 2, ram_gb: 4,
            storage_gb: 16, gpu_enabled: true, gpu_vram_gb: 1, network_mode: 'nat',
        },
        os_versions: ['18.0', '17.5', '16.4'],
        preview_image: '/vm/ios-simulator.png',
        device_variants: ['iPhone 16 Pro', 'iPhone 16 Pro Max', 'iPhone 16', 'iPhone SE'],
        min_tier: 'standard',
    },
    {
        id: 'ipados-simulator',
        name: 'iPadOS Simulator',
        description: 'Xcode iPadOS Simulator for iPad Pro and iPad Air.',
        platform: 'ipados',
        form_factor: 'tablet',
        arch: ['arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 32, gpu_enabled: true, gpu_vram_gb: 2, network_mode: 'nat',
        },
        os_versions: ['18.0', '17.5'],
        preview_image: '/vm/ipados-simulator.png',
        device_variants: ['iPad Pro 13"', 'iPad Pro 11"', 'iPad Air', 'iPad mini'],
        min_tier: 'standard',
    },

    // ── watchOS / Wear OS ───────────────────────────────
    {
        id: 'watchos-simulator',
        name: 'Apple Watch Simulator',
        description: 'watchOS simulator for Apple Watch. HealthKit and workout APIs included.',
        platform: 'watchos',
        form_factor: 'watch',
        arch: ['arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 1, ram_gb: 1,
            storage_gb: 4, gpu_enabled: false, network_mode: 'nat',
        },
        os_versions: ['11.0', '10.5', '10.0'],
        preview_image: '/vm/watchos-simulator.png',
        device_variants: ['Apple Watch Ultra 2', 'Apple Watch Series 10', 'Apple Watch SE'],
        min_tier: 'advanced',
    },
    {
        id: 'wearos-emulator',
        name: 'Wear OS Emulator',
        description: 'Google Wear OS emulator for Samsung Galaxy Watch and Pixel Watch.',
        platform: 'wear_os',
        form_factor: 'watch',
        arch: ['arm64', 'x86_64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 1, ram_gb: 1,
            storage_gb: 4, gpu_enabled: false, network_mode: 'nat',
        },
        os_versions: ['5.0', '4.0'],
        preview_image: '/vm/wearos-emulator.png',
        device_variants: ['Galaxy Watch 7', 'Galaxy Watch Ultra', 'Pixel Watch 3'],
        min_tier: 'advanced',
    },

    // ── Android ─────────────────────────────────────────
    {
        id: 'android-emulator',
        name: 'Android Emulator',
        description: 'Android 15 emulator with Material Design 3. Pixel and Samsung skins.',
        platform: 'android',
        form_factor: 'phone',
        arch: ['arm64', 'x86_64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 4,
            storage_gb: 32, gpu_enabled: true, gpu_vram_gb: 1, network_mode: 'nat',
        },
        os_versions: ['15 (API 35)', '14 (API 34)', '13 (API 33)'],
        preview_image: '/vm/android-emulator.png',
        device_variants: ['Pixel 9 Pro', 'Pixel 9', 'Samsung Galaxy S25 Ultra', 'Samsung Galaxy S25'],
        min_tier: 'standard',
    },
    {
        id: 'android-tablet',
        name: 'Android Tablet Emulator',
        description: 'Android tablet emulator for Samsung Galaxy Tab and Pixel Tablet.',
        platform: 'android',
        form_factor: 'tablet',
        arch: ['arm64', 'x86_64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 4, ram_gb: 8,
            storage_gb: 64, gpu_enabled: true, gpu_vram_gb: 2, network_mode: 'nat',
        },
        os_versions: ['15 (API 35)', '14 (API 34)'],
        preview_image: '/vm/android-tablet.png',
        device_variants: ['Galaxy Tab S10 Ultra', 'Pixel Tablet'],
        min_tier: 'advanced',
    },

    // ── VR / AR Headsets ─────────────────────────────────
    {
        id: 'visionos-simulator',
        name: 'Apple Vision Pro Simulator',
        description: 'visionOS simulator for spatial computing. ARKit, RealityKit, and SwiftUI Volumes.',
        platform: 'visionos',
        form_factor: 'headset',
        arch: ['arm64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 8, ram_gb: 16,
            storage_gb: 64, gpu_enabled: true, gpu_vram_gb: 8, network_mode: 'nat',
        },
        os_versions: ['2.0', '1.2', '1.0'],
        preview_image: '/vm/visionos-simulator.png',
        device_variants: ['Apple Vision Pro'],
        min_tier: 'advanced',
    },
    {
        id: 'meta-quest-emulator',
        name: 'Meta Quest Emulator',
        description: 'Meta Horizon OS emulator for Quest 3/Pro. Supports passthrough MR and full VR.',
        platform: 'meta_horizon',
        form_factor: 'headset',
        arch: ['arm64', 'x86_64'],
        default_hardware: {
            cpu_arch: 'arm64', cpu_cores: 8, ram_gb: 12,
            storage_gb: 128, gpu_enabled: true, gpu_vram_gb: 6, network_mode: 'nat',
        },
        os_versions: ['Horizon OS v69', 'Horizon OS v67'],
        preview_image: '/vm/meta-quest-emulator.png',
        device_variants: ['Meta Quest 3', 'Meta Quest 3S', 'Meta Quest Pro'],
        min_tier: 'advanced',
    },
];

// ── VM Import ───────────────────────────────────────────────

export type VmImportFormat = 'vmx' | 'pvm' | 'ova' | 'qcow2' | 'vhdx' | 'raw';

export interface VmImportRequest {
    /** Path to the VM image file on disk */
    source_path: string;
    format: VmImportFormat;
    /** User-defined name for the imported VM */
    name: string;
    /** Override default hardware spec */
    hardware_overrides?: Partial<VmHardwareSpec>;
    /** User-supplied custom parameters (unlimited key-value) */
    custom_params?: Record<string, string | number | boolean>;
    /** Tier for apps deployed from this VM */
    inherited_tier?: ScmTier;
}

export interface VmImportResult {
    success: boolean;
    vm_id: string;
    image: VmImage;
    warnings: string[];
    import_time_ms: number;
}

// ── Custom Device Parameters ────────────────────────────────

export interface CustomDeviceSpec {
    name: string;
    platform: OsPlatform;
    form_factor: DeviceFormFactor;
    arch: CpuArch;
    os_version: string;
    hardware: VmHardwareSpec;
    hypervisor: HypervisorType;

    /** Screen resolution for device simulators */
    screen_resolution?: { width: number; height: number; dpi: number };

    /** Network simulation profile (user-defined bandwidth, latency, loss) */
    network_profile?: NetworkProfile;

    /** Network load test scenarios to run against this device */
    load_tests?: NetworkLoadTest[];

    /** Host resource sharing (drives, peripherals, clipboard) */
    host_sharing?: HostResourceSharing;

    /** Extended hardware (storage type, NIC, TPM, secure boot) */
    custom_hardware?: CustomHardwareConfig;

    /** User-defined parameters — fully open-ended */
    custom_params: Record<string, string | number | boolean>;

    /** Environment variables to inject into the VM */
    env_vars?: Record<string, string>;

    /** Startup script to run on boot */
    startup_script?: string;

    /** Port forwarding rules */
    port_forwards?: Array<{ host: number; guest: number; protocol: 'tcp' | 'udp' }>;
}

// ── Deployment ──────────────────────────────────────────────

export type DeployTarget =
    | 'github_actions'
    | 'vercel'
    | 'local_vm'
    | 'synalux_cloud'
    | 'custom_server';

export interface DeployConfig {
    target: DeployTarget;
    vm_id?: string;                // Deploy to a specific VM
    repo_url?: string;             // GitHub repo for CI/CD
    branch: string;
    build_command: string;
    test_command?: string;
    env_vars: Record<string, string>;

    /** Apps inherit Synalux tier from the workspace */
    inherited_tier: ScmTier;

    /** Auto-deploy on push? */
    auto_deploy: boolean;
}

export interface DeployResult {
    success: boolean;
    deploy_id: string;
    url?: string;
    logs_url?: string;
    test_results?: {
        passed: number;
        failed: number;
        skipped: number;
        duration_ms: number;
    };
    timestamp: string;
}

// ── VM Tier Limits ──────────────────────────────────────────

export interface VmTierLimits {
    /** Max concurrent VMs */
    max_concurrent_vms: number;
    /** Max RAM allocated across all VMs (GB) */
    max_total_ram_gb: number;
    /** Max storage across all VMs (GB) */
    max_total_storage_gb: number;
    /** Available OS platforms */
    platforms: OsPlatform[];
    /** Can import from VMware/Parallels? */
    vm_import: boolean;
    /** Can create custom devices? */
    custom_devices: boolean;
    /** GPU passthrough support */
    gpu_passthrough: boolean;
    /** Max deployments per day */
    deploys_per_day: number;
    /** Thin-client proxy to Synalux */
    thin_client: boolean;
}

export const VM_TIERS: Record<ScmTier, VmTierLimits> = {
    free: {
        max_concurrent_vms: 1,
        max_total_ram_gb: 4,
        max_total_storage_gb: 32,
        platforms: ['linux'],
        vm_import: false,
        custom_devices: false,
        gpu_passthrough: false,
        deploys_per_day: 3,
        thin_client: false,
    },
    standard: {
        max_concurrent_vms: 3,
        max_total_ram_gb: 16,
        max_total_storage_gb: 256,
        platforms: ['linux', 'windows', 'ios', 'android'],
        vm_import: true,
        custom_devices: true,
        gpu_passthrough: false,
        deploys_per_day: 25,
        thin_client: true,
    },
    advanced: {
        max_concurrent_vms: 8,
        max_total_ram_gb: 64,
        max_total_storage_gb: 1024,
        platforms: ['linux', 'windows', 'macos', 'ios', 'ipados', 'android', 'watchos', 'wear_os', 'visionos', 'meta_horizon'],
        vm_import: true,
        custom_devices: true,
        gpu_passthrough: true,
        deploys_per_day: 100,
        thin_client: true,
    },
    enterprise: {
        max_concurrent_vms: Infinity,
        max_total_ram_gb: Infinity,
        max_total_storage_gb: Infinity,
        platforms: ['linux', 'windows', 'macos', 'ios', 'ipados', 'android', 'watchos', 'wear_os', 'visionos', 'meta_horizon', 'tvos', 'custom'],
        vm_import: true,
        custom_devices: true,
        gpu_passthrough: true,
        deploys_per_day: Infinity,
        thin_client: true,
    },
};
