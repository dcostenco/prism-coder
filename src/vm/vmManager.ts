/**
 * VM Manager — Prism IDE Hypervisor Abstraction
 * ==============================================
 * Interface layer for VM lifecycle management.
 * Implementations are portal-side (Synalux VM manager).
 *
 * Supports:
 * - VM creation from built-in templates or custom specs
 * - Import from VMware Fusion (.vmx), Parallels (.pvm), OVA, QCOW2, VHDX
 * - Lifecycle: create → start → stop → snapshot → destroy
 * - Deployment via GitHub Actions, Vercel, or local VM
 * - Thin-client proxy to Synalux for remote VMs
 */

import type {
    VmImage, VmImportRequest, VmImportResult,
    CustomDeviceSpec, DeployConfig, DeployResult,
    DeviceTemplate, VmTierLimits, HypervisorType,
    DEVICE_TEMPLATES, VM_TIERS,
} from './types.js';
import type { ScmTier } from '../scm/types.js';

// ── VM Lifecycle States ─────────────────────────────────────

export type VmState =
    | 'creating'
    | 'importing'
    | 'stopped'
    | 'starting'
    | 'running'
    | 'paused'
    | 'snapshotting'
    | 'deploying'
    | 'error'
    | 'destroyed';

// ── VM Instance ─────────────────────────────────────────────

export interface VmInstance {
    id: string;
    image: VmImage;
    state: VmState;
    ip_address?: string;
    ssh_port?: number;
    vnc_port?: number;
    uptime_seconds: number;
    cpu_usage_pct: number;
    ram_usage_mb: number;
    last_snapshot?: string;
    deploy_history: DeployResult[];
}

// ── Manager Interface ───────────────────────────────────────

export interface IVmManager {
    // ── Inventory ───────────────────────────────────────
    /** List all available device templates for the user's tier */
    listTemplates(tier: ScmTier): DeviceTemplate[];

    /** List all VM images (built-in + imported + custom) */
    listImages(): Promise<VmImage[]>;

    /** List running VM instances */
    listInstances(): Promise<VmInstance[]>;

    // ── Creation ────────────────────────────────────────
    /** Create VM from a built-in template */
    createFromTemplate(templateId: string, overrides?: Partial<CustomDeviceSpec>): Promise<VmInstance>;

    /** Create VM from custom device spec (user-defined parameters) */
    createCustom(spec: CustomDeviceSpec): Promise<VmInstance>;

    /** Import VM from VMware, Parallels, OVA, QCOW2, or VHDX */
    importVm(request: VmImportRequest): Promise<VmImportResult>;

    // ── Lifecycle ───────────────────────────────────────
    start(vmId: string): Promise<VmInstance>;
    stop(vmId: string): Promise<VmInstance>;
    pause(vmId: string): Promise<VmInstance>;
    resume(vmId: string): Promise<VmInstance>;
    destroy(vmId: string): Promise<void>;

    /** Save VM state to a named snapshot */
    snapshot(vmId: string, name: string): Promise<string>;

    /** Restore VM to a snapshot */
    restoreSnapshot(vmId: string, snapshotId: string): Promise<VmInstance>;

    // ── Deployment ──────────────────────────────────────
    /** Deploy app to VM or cloud target */
    deploy(config: DeployConfig): Promise<DeployResult>;

    /** Get deployment status */
    getDeployStatus(deployId: string): Promise<DeployResult>;

    /** Rollback to a previous deployment */
    rollback(deployId: string): Promise<DeployResult>;

    // ── Tier Enforcement ────────────────────────────────
    /** Get VM limits for the current tier */
    getTierLimits(tier: ScmTier): VmTierLimits;

    /** Check if an operation is allowed for the tier */
    checkTierAccess(tier: ScmTier, operation: string): { allowed: boolean; reason?: string };

    // ── Thin Client ─────────────────────────────────────
    /** Connect to a remote Synalux-hosted VM via thin-client proxy */
    connectThinClient(vmId: string): Promise<{ ws_url: string; auth_token: string }>;

    // ── Hypervisor Detection ────────────────────────────
    /** Detect available hypervisors on the host machine */
    detectHypervisors(): Promise<HypervisorType[]>;
}
