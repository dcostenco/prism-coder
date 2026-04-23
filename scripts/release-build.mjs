#!/usr/bin/env node

/**
 * Release Build Script — Creates standalone executables for all platforms.
 *
 * Targets:
 *   - prism-win-x64.exe    (Windows 10+ x64)
 *   - prism-macos-x64      (macOS Intel)
 *   - prism-macos-arm64    (macOS Apple Silicon)
 *   - prism-linux-x64      (Linux x64)
 *
 * Usage:
 *   npm run release:all     # Build all platforms
 *   npm run release:win     # Build Windows only
 *   npm run release:mac-arm # Build macOS ARM only
 */

import { execSync } from 'child_process';
import { mkdirSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const RELEASE_DIR = 'release';
const PKG_BIN = 'npx -y @yao-pkg/pkg';

const TARGETS = [
    { name: 'prism-win-x64.exe', target: 'node20-win-x64', platform: 'Windows x64' },
    { name: 'prism-macos-x64', target: 'node20-macos-x64', platform: 'macOS Intel' },
    { name: 'prism-macos-arm64', target: 'node20-macos-arm64', platform: 'macOS Apple Silicon' },
    { name: 'prism-linux-x64', target: 'node20-linux-x64', platform: 'Linux x64' },
];

console.log('\n🔨  Prism Release Builder');
console.log('━'.repeat(50));

// Ensure release directory exists
mkdirSync(RELEASE_DIR, { recursive: true });

// Read version from package.json
const pkg = JSON.parse(
    (await import('fs')).readFileSync('package.json', 'utf-8'),
);
console.log(`📦  Version: ${pkg.version}`);
console.log(`🎯  Entry:   dist/cli.js\n`);

let success = 0;
let failed = 0;

for (const t of TARGETS) {
    const output = join(RELEASE_DIR, t.name);
    console.log(`  Building ${t.platform}...`);
    try {
        execSync(
            `${PKG_BIN} dist/cli.js --target ${t.target} --output ${output} --compress Brotli`,
            { stdio: 'pipe', timeout: 300000 },
        );
        if (existsSync(output)) {
            const size = statSync(output).size;
            const sizeMB = (size / 1024 / 1024).toFixed(1);
            console.log(`  ✅ ${t.name} (${sizeMB} MB)`);
            success++;
        } else {
            console.log(`  ❌ ${t.name} — output file not found`);
            failed++;
        }
    } catch (e) {
        console.log(`  ❌ ${t.name} — ${e instanceof Error ? e.message.split('\n')[0] : 'Build failed'}`);
        failed++;
    }
}

console.log(`\n${'━'.repeat(50)}`);
console.log(`✅ ${success} succeeded, ❌ ${failed} failed`);

if (success > 0) {
    console.log(`\n📁 Release artifacts:`);
    for (const f of readdirSync(RELEASE_DIR)) {
        const size = (statSync(join(RELEASE_DIR, f)).size / 1024 / 1024).toFixed(1);
        console.log(`   ${RELEASE_DIR}/${f}  (${size} MB)`);
    }
}

console.log('');
