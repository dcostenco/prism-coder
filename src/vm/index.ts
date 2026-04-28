// ── Core VM types ───────────────────────────────────────────────
export type { VmImage, VmImportRequest, VmImportResult, CustomDeviceSpec, DeployConfig, DeployResult, DeviceTemplate, VmTierLimits, CpuArch, HypervisorType, OsPlatform, DeviceFormFactor, VmHardwareSpec, VmImportFormat, DeployTarget, NetworkType, NetworkProfile, NetworkLoadTest, NetworkLoadTestResult, HostResourceSharing, StorageType, NicType, CustomHardwareConfig } from './types.js';
export { DEVICE_TEMPLATES, VM_TIERS, NETWORK_PRESETS, DEFAULT_HOST_SHARING } from './types.js';
export type { VmState, VmInstance, IVmManager } from './vmManager.js';

// ── Game Engine ─────────────────────────────────────────────────
export type { GpuProfilerConfig, GpuFrameCapture, RenderPassInfo, FrameDebuggerConfig, ShaderCompileTarget, ShaderVariant, ShaderHotReloadConfig, ShaderProfileResult, BuildFarmConfig, BuildJob, RenderFarmConfig, AssetCookerConfig, NetcodeSimulatorConfig, MultiClientTestConfig, MatchmakingTestConfig, NetcodeTestResult, AssetPipelineConfig, AssetBundleConfig, PhysicsDebuggerConfig, PhysicsProfileResult, GamepadEmulatorConfig, TouchSimulatorConfig, VrControllerConfig, InputRecordingConfig, PlaytestBotConfig, PerformanceGateConfig, ScreenshotComparisonConfig, MemoryProfilerConfig, MemoryBudget, MemorySnapshotDiff, BuildMatrixConfig, BuildMatrixEntry, StoreSubmissionConfig, SdkSandboxConfig, SdkMockService, GameDevTierLimits } from './gameEngine.js';
export { MEMORY_BUDGETS, GAME_DEV_TIERS, GAME_DEV_TEMPLATES } from './gameEngine.js';

// ── Creative Studio ─────────────────────────────────────────────
export type { Visualization3DConfig, Visualization5DConfig, Scene3DObject, MaterialConfig, SceneExportConfig, VideoProjectConfig, VideoTimeline, VideoClip, AudioClip, TextOverlay, EffectClip, CinematicCameraPath, ScreenRecorderConfig, AudioProjectConfig, AudioGenerationConfig, SpatialAudioConfig, AudioMixerConfig, AudioDeviceEmulatorConfig, AudioProfileResult, CreativeStudioTierLimits } from './creativeStudio.js';
export { CREATIVE_STUDIO_TIERS } from './creativeStudio.js';

// ── Competitor Import ───────────────────────────────────────────
export type { CompetitorImportRequest, CompetitorImportResult, CompetitorImportOptions, CompetitorPlatformInfo, CompatibilityReport, CompetitorImportTierLimits } from './competitorImport.js';
export { COMPETITOR_PLATFORMS, COMPETITOR_IMPORT_TIERS } from './competitorImport.js';

// ── Component Marketplace ───────────────────────────────────────
export type { MarketplaceComponent, PublisherProfile, ComponentPricing, ComponentReview, ComponentPurchase, ComponentInstallRequest, ComponentInstallResult, ComponentPublishRequest, ComponentPublishResult, MarketplaceSearchRequest, MarketplaceSearchResult, MarketplaceTierLimits } from './componentMarketplace.js';
export { MARKETPLACE_TIERS } from './componentMarketplace.js';

// ── Project Templates ───────────────────────────────────────────
export type { ProjectTemplate, TemplateCreateRequest, TemplateCreateResult, TemplateTierLimits } from './projectTemplates.js';
export { GAME_TEMPLATES, APP_TEMPLATES, CREATIVE_TEMPLATES, ALL_PROJECT_TEMPLATES, TEMPLATE_TIERS } from './projectTemplates.js';
