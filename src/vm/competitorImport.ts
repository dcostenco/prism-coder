/**
 * Competitor Project Import & Migration
 * ══════════════════════════════════════
 *
 * Import projects from competing IDEs and game engines:
 *   - Unity (C#/.unity)
 *   - Unreal Engine (C++/Blueprints)
 *   - Godot (.tscn/.tres)
 *   - Xcode (Swift/Obj-C)
 *   - Android Studio (Kotlin/Java)
 *   - Visual Studio (C++/C#)
 *   - JetBrains Rider
 *   - Eclipse
 *   - Flutter/Dart
 *
 * BOUNDARY: Interfaces only — implementations in synalux-private.
 */

import type { ScmTier } from '../scm/types.js';

// ══════════════════════════════════════════════════════════════════
// 1. SOURCE PLATFORM DEFINITIONS
// ══════════════════════════════════════════════════════════════════

export type CompetitorPlatform =
    | 'unity'
    | 'unreal_engine'
    | 'godot'
    | 'xcode'
    | 'android_studio'
    | 'visual_studio'
    | 'jetbrains_rider'
    | 'eclipse'
    | 'flutter'
    | 'cocos2d'
    | 'construct3'
    | 'gamemaker'
    | 'rpg_maker'
    | 'defold';

export interface CompetitorPlatformInfo {
    id: CompetitorPlatform;
    display_name: string;
    description: string;
    /** File extensions that identify this platform */
    file_signatures: string[];
    /** Project file patterns */
    project_patterns: string[];
    /** Languages used */
    languages: string[];
    /** Supported import versions */
    supported_versions: string[];
    icon: string;
}

export const COMPETITOR_PLATFORMS: CompetitorPlatformInfo[] = [
    {
        id: 'unity',
        display_name: 'Unity',
        description: 'Import Unity projects — C# scripts, scenes, prefabs, assets, and packages.',
        file_signatures: ['.unity', '.asset', '.prefab', '.meta', '.asmdef'],
        project_patterns: ['Assets/', 'ProjectSettings/', 'Packages/'],
        languages: ['C#', 'ShaderLab', 'HLSL'],
        supported_versions: ['2021 LTS', '2022 LTS', 'Unity 6', 'Unity 6.1'],
        icon: '/icons/unity.svg',
    },
    {
        id: 'unreal_engine',
        display_name: 'Unreal Engine',
        description: 'Import Unreal Engine projects — C++, Blueprints, assets, and plugins.',
        file_signatures: ['.uproject', '.uasset', '.umap', '.uplugin'],
        project_patterns: ['Source/', 'Content/', 'Config/'],
        languages: ['C++', 'Blueprints', 'HLSL'],
        supported_versions: ['UE 5.3', 'UE 5.4', 'UE 5.5', 'UE 5.6'],
        icon: '/icons/unreal.svg',
    },
    {
        id: 'godot',
        display_name: 'Godot',
        description: 'Import Godot projects — GDScript, C#, scenes, and resources.',
        file_signatures: ['.tscn', '.tres', '.gd', '.godot'],
        project_patterns: ['project.godot', 'scenes/', 'scripts/'],
        languages: ['GDScript', 'C#', 'GDNative/C++'],
        supported_versions: ['4.0', '4.1', '4.2', '4.3', '4.4'],
        icon: '/icons/godot.svg',
    },
    {
        id: 'xcode',
        display_name: 'Xcode',
        description: 'Import Xcode projects — Swift, Objective-C, SwiftUI, storyboards.',
        file_signatures: ['.xcodeproj', '.xcworkspace', '.swift', '.storyboard', '.xib'],
        project_patterns: ['*.xcodeproj/', '*.xcworkspace/', 'Podfile'],
        languages: ['Swift', 'Objective-C', 'Metal Shading Language'],
        supported_versions: ['15', '16'],
        icon: '/icons/xcode.svg',
    },
    {
        id: 'android_studio',
        display_name: 'Android Studio',
        description: 'Import Android Studio projects — Kotlin, Java, Gradle, Jetpack Compose.',
        file_signatures: ['.gradle', '.kts', 'AndroidManifest.xml'],
        project_patterns: ['app/src/', 'build.gradle', 'settings.gradle'],
        languages: ['Kotlin', 'Java', 'XML'],
        supported_versions: ['Hedgehog', 'Iguana', 'Jellyfish', 'Koala', 'Ladybug', 'Meerkat'],
        icon: '/icons/android-studio.svg',
    },
    {
        id: 'visual_studio',
        display_name: 'Visual Studio',
        description: 'Import Visual Studio solutions — C++, C#, .NET, CMake.',
        file_signatures: ['.sln', '.vcxproj', '.csproj'],
        project_patterns: ['*.sln', '*.vcxproj', 'CMakeLists.txt'],
        languages: ['C++', 'C#', 'F#', 'HLSL'],
        supported_versions: ['2019', '2022'],
        icon: '/icons/visual-studio.svg',
    },
    {
        id: 'flutter',
        display_name: 'Flutter',
        description: 'Import Flutter projects — Dart, widgets, platform-specific code.',
        file_signatures: ['pubspec.yaml', '.dart'],
        project_patterns: ['lib/', 'test/', 'pubspec.yaml', 'android/', 'ios/'],
        languages: ['Dart'],
        supported_versions: ['3.16', '3.19', '3.22', '3.24', '3.27'],
        icon: '/icons/flutter.svg',
    },
    {
        id: 'gamemaker',
        display_name: 'GameMaker',
        description: 'Import GameMaker projects — GML scripts, rooms, sprites, objects.',
        file_signatures: ['.yyp', '.yy', '.gml'],
        project_patterns: ['*.yyp', 'rooms/', 'sprites/', 'objects/'],
        languages: ['GML'],
        supported_versions: ['2024.2', '2024.6', '2024.8'],
        icon: '/icons/gamemaker.svg',
    },
    {
        id: 'construct3',
        display_name: 'Construct 3',
        description: 'Import Construct 3 projects — event sheets, layouts, behaviors.',
        file_signatures: ['.c3p', '.c3proj'],
        project_patterns: ['*.c3p', 'eventSheets/', 'layouts/'],
        languages: ['JavaScript', 'Event Sheets'],
        supported_versions: ['r350+'],
        icon: '/icons/construct3.svg',
    },
    {
        id: 'defold',
        display_name: 'Defold',
        description: 'Import Defold projects — Lua scripts, game objects, collections.',
        file_signatures: ['.project', '.collection', '.go', '.gui', '.script'],
        project_patterns: ['game.project', 'main/'],
        languages: ['Lua'],
        supported_versions: ['1.6+', '1.7+', '1.8+', '1.9+'],
        icon: '/icons/defold.svg',
    },
];

// ══════════════════════════════════════════════════════════════════
// 2. IMPORT WORKFLOW
// ══════════════════════════════════════════════════════════════════

export interface CompetitorImportRequest {
    /** Source platform */
    source_platform: CompetitorPlatform;
    /** Path to source project (local or git URL) */
    source_path: string;
    /** Source version (e.g., "Unity 6.1", "UE 5.6") */
    source_version: string;
    /** What to import */
    import_options: CompetitorImportOptions;
    /** Target Prism project name */
    target_project_name: string;
}

export interface CompetitorImportOptions {
    /** Import source code */
    import_code: boolean;
    /** Import assets (textures, models, audio) */
    import_assets: boolean;
    /** Import scenes/levels/layouts */
    import_scenes: boolean;
    /** Import project settings/configuration */
    import_settings: boolean;
    /** Import build configurations */
    import_build_configs: boolean;
    /** Import plugins/packages/dependencies */
    import_plugins: boolean;
    /** Import VCS history (git log) */
    import_vcs_history: boolean;
    /** Convert scripts to target language */
    convert_scripts: boolean;
    /** Target language for script conversion */
    target_language?: string;
    /** Preserve original file structure */
    preserve_structure: boolean;
}

export interface CompetitorImportResult {
    success: boolean;
    /** Files imported */
    files_imported: number;
    /** Files skipped (unsupported) */
    files_skipped: number;
    /** Conversion warnings */
    warnings: ImportWarning[];
    /** Critical errors */
    errors: ImportError[];
    /** Compatibility report */
    compatibility: CompatibilityReport;
    /** Time taken in ms */
    import_time_ms: number;
}

export interface ImportWarning {
    file: string;
    message: string;
    severity: 'info' | 'warning';
    /** Suggested manual fix */
    suggestion?: string;
}

export interface ImportError {
    file: string;
    message: string;
    /** Can the import continue despite this error? */
    recoverable: boolean;
}

export interface CompatibilityReport {
    /** Overall compatibility score (0-100) */
    score: number;
    /** Features that mapped cleanly */
    supported_features: string[];
    /** Features that need manual adaptation */
    partial_features: string[];
    /** Features with no equivalent */
    unsupported_features: string[];
    /** Estimated manual work remaining (hours) */
    estimated_manual_hours: number;
}

// ══════════════════════════════════════════════════════════════════
// 3. IMPORT TIER LIMITS
// ══════════════════════════════════════════════════════════════════

export interface CompetitorImportTierLimits {
    /** Platforms available for import */
    platforms: CompetitorPlatform[];
    /** Max project size for import */
    max_project_size_gb: number;
    /** Script auto-conversion */
    script_conversion: boolean;
    /** Asset conversion (texture recompression, mesh re-export) */
    asset_conversion: boolean;
    /** VCS history import */
    vcs_history_import: boolean;
    /** Max imports per month */
    imports_per_month: number;
}

export const COMPETITOR_IMPORT_TIERS: Record<ScmTier, CompetitorImportTierLimits> = {
    free: {
        platforms: ['godot', 'flutter', 'construct3', 'defold'],
        max_project_size_gb: 1,
        script_conversion: false,
        asset_conversion: false,
        vcs_history_import: false,
        imports_per_month: 3,
    },
    standard: {
        platforms: ['unity', 'godot', 'xcode', 'android_studio', 'flutter', 'gamemaker', 'construct3', 'defold'],
        max_project_size_gb: 10,
        script_conversion: true,
        asset_conversion: true,
        vcs_history_import: true,
        imports_per_month: 20,
    },
    advanced: {
        platforms: ['unity', 'unreal_engine', 'godot', 'xcode', 'android_studio', 'visual_studio', 'flutter', 'gamemaker', 'construct3', 'defold'],
        max_project_size_gb: 50,
        script_conversion: true,
        asset_conversion: true,
        vcs_history_import: true,
        imports_per_month: 100,
    },
    enterprise: {
        platforms: ['unity', 'unreal_engine', 'godot', 'xcode', 'android_studio', 'visual_studio', 'jetbrains_rider', 'eclipse', 'flutter', 'cocos2d', 'gamemaker', 'construct3', 'rpg_maker', 'defold'],
        max_project_size_gb: Infinity,
        script_conversion: true,
        asset_conversion: true,
        vcs_history_import: true,
        imports_per_month: Infinity,
    },
};
