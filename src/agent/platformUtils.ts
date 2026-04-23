/**
 * Platform Utilities — Cross-platform abstractions for Prism CLI
 * ================================================================
 *
 * Provides OS-aware implementations for shell commands, file operations,
 * and system tools. Supports macOS, Linux, and Windows 10+.
 */

import { execSync } from 'child_process';
import * as os from 'os';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// Shell / Command helpers
// ---------------------------------------------------------------------------

/** Open a URL in the default browser */
export function openUrlCommand(url: string): string {
    if (IS_WINDOWS) return `start "" "${url}"`;
    if (IS_MAC) return `open "${url}"`;
    return `xdg-open "${url}"`;  // Linux
}

/**
 * Locate a CLI binary on any platform.
 * Returns the resolved path or null if not found.
 */
export function findBinary(name: string): string | null {
    try {
        const cmd = IS_WINDOWS ? `where ${name}` : `which ${name}`;
        const result = execSync(cmd, { stdio: 'pipe', timeout: 5000 }).toString().trim();
        // `where` on Windows may return multiple lines — take the first
        return result.split('\n')[0]?.trim() || null;
    } catch {
        return null;
    }
}

/**
 * Resolve a CLI tool path — tries PATH first, then common install locations.
 * Falls back to bare command name (relies on PATH at runtime).
 */
export function resolveCli(name: string): string {
    // Try PATH first
    const inPath = findBinary(name);
    if (inPath) return `"${inPath}"`;

    // macOS Homebrew fallback locations
    if (IS_MAC) {
        const homebrewPaths = [
            `/opt/homebrew/bin/${name}`,
            `/usr/local/bin/${name}`,
        ];
        for (const p of homebrewPaths) {
            try {
                execSync(`test -f "${p}"`, { stdio: 'pipe' });
                return `"${p}"`;
            } catch { /* not found */ }
        }
    }

    // Windows: try common install paths
    if (IS_WINDOWS) {
        const winPaths = [
            `${os.homedir()}\\AppData\\Roaming\\npm\\${name}.cmd`,
            `${os.homedir()}\\AppData\\Local\\Programs\\${name}\\${name}.exe`,
            `C:\\Program Files\\${name}\\${name}.exe`,
        ];
        for (const p of winPaths) {
            try {
                execSync(`if exist "${p}" echo found`, { stdio: 'pipe' });
                return `"${p}"`;
            } catch { /* not found */ }
        }
    }

    // Bare name — hope it's in PATH at runtime
    return name;
}

// ---------------------------------------------------------------------------
// fetch_url — cross-platform HTML fetching
// ---------------------------------------------------------------------------

/**
 * Build the shell command to fetch and strip HTML from a URL.
 * Uses curl on all platforms but adjusts the text processing pipeline.
 */
export function fetchUrlCommand(url: string): string {
    const safeUrl = url.replace(/"/g, '\\"');
    const curlBase = `curl -sL --max-time 15 --max-filesize 1048576 -H "User-Agent: Mozilla/5.0" "${safeUrl}"`;

    if (IS_WINDOWS) {
        // PowerShell pipeline: strip HTML tags, collapse whitespace
        return `powershell -NoProfile -Command "& { (Invoke-WebRequest -Uri '${safeUrl}' -UseBasicParsing -TimeoutSec 15).Content -replace '<script[^>]*>[\\s\\S]*?</script>','' -replace '<style[^>]*>[\\s\\S]*?</style>','' -replace '<[^>]+>','' -replace '\\s+',' ' | Select-Object -First 300 }"`;
    }

    // macOS / Linux: curl + sed pipeline
    return (
        `${curlBase} | ` +
        `sed 's/<script[^>]*>.*<\\/script>//gi' | ` +
        `sed 's/<style[^>]*>.*<\\/style>//gi' | ` +
        `sed 's/<[^>]*>//g' | ` +
        `tr -s '[:space:]' '\\n' | ` +
        `sed '/^$/d' | head -300`
    );
}

// ---------------------------------------------------------------------------
// list_files — cross-platform directory listing
// ---------------------------------------------------------------------------

export function listFilesCommand(dir: string, maxDepth: number, pattern?: string): string {
    if (IS_WINDOWS) {
        // PowerShell: Get-ChildItem with depth and exclusions
        let cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${dir}' -Recurse -Depth ${maxDepth}`;
        cmd += ` | Where-Object { $_.FullName -notmatch 'node_modules|.git' }`;
        if (pattern) {
            cmd += ` | Where-Object { $_.Name -like '${pattern}' }`;
        }
        cmd += ` | Select-Object -First 100 -ExpandProperty FullName"`;
        return cmd;
    }

    // macOS / Linux: find
    let cmd = `find "${dir}" -maxdepth ${maxDepth} -not -path '*/node_modules/*' -not -path '*/.git/*'`;
    if (pattern) {
        cmd += ` -name "${pattern}"`;
    }
    cmd += ' | head -100 | sort';
    return cmd;
}

// ---------------------------------------------------------------------------
// search_files — cross-platform text search
// ---------------------------------------------------------------------------

export function searchFilesCommand(
    query: string,
    dir: string,
    maxResults: number,
    filePattern?: string,
): string {
    const escapedQuery = query.replace(/"/g, '\\"');

    // Try ripgrep first (cross-platform)
    if (findBinary('rg')) {
        let cmd = `rg --no-heading --line-number --max-count=${maxResults}`;
        if (filePattern) cmd += ` -g "${filePattern}"`;
        cmd += ` "${escapedQuery}" "${dir}" 2>${IS_WINDOWS ? 'NUL' : '/dev/null'}`;
        cmd += IS_WINDOWS ? '' : ' | head -50';
        return cmd;
    }

    // Windows fallback: findstr
    if (IS_WINDOWS) {
        return `findstr /S /N /I /C:"${escapedQuery}" "${dir}\\*${filePattern || '.*'}"`;
    }

    // Unix fallback: grep -r
    let cmd = `grep -rn "${escapedQuery}" "${dir}"`;
    if (filePattern) cmd += ` --include="${filePattern}"`;
    cmd += ' | head -50';
    return cmd;
}

// ---------------------------------------------------------------------------
// Multimodal — cross-platform voice/camera/TTS/clipboard
// ---------------------------------------------------------------------------

/** TTS command: read text aloud */
export function ttsCommand(text: string, rate = 190): string {
    const safe = text.replace(/"/g, '\\"').slice(0, 3000);

    if (IS_MAC) {
        return `say -r ${rate} "${safe}"`;
    }

    if (IS_WINDOWS) {
        // PowerShell System.Speech
        return `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = ${Math.round((rate - 150) / 25)}; $s.Speak('${safe.replace(/'/g, "''")}')"`;
    }

    // Linux: try espeak, then spd-say
    if (findBinary('espeak')) {
        return `espeak -s ${rate} "${safe}"`;
    }
    return `spd-say "${safe}"`;
}

/** Clipboard paste image to file path */
export function clipboardImageCommand(outputPath: string): { cmd: string; available: boolean } {
    if (IS_MAC) {
        if (findBinary('pngpaste')) {
            return { cmd: `pngpaste "${outputPath}"`, available: true };
        }
        return { cmd: '', available: false };
    }

    if (IS_WINDOWS) {
        // PowerShell: save clipboard image
        const ps = `Add-Type -AssemblyName System.Windows.Forms; ` +
            `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
            `if ($img) { $img.Save('${outputPath.replace(/'/g, "''")}') } ` +
            `else { throw 'No image in clipboard' }`;
        return { cmd: `powershell -NoProfile -Command "${ps}"`, available: true };
    }

    // Linux: xclip
    if (findBinary('xclip')) {
        return { cmd: `xclip -selection clipboard -t image/png -o > "${outputPath}"`, available: true };
    }
    return { cmd: '', available: false };
}

/** Camera capture command */
export function cameraCaptureCommand(outputPath: string): { cmd: string; available: boolean; waitMs: number } {
    if (IS_MAC) {
        if (findBinary('imagesnap')) {
            return { cmd: `imagesnap -w 1 "${outputPath}"`, available: true, waitMs: 3000 };
        }
        return { cmd: '', available: false, waitMs: 0 };
    }

    if (IS_WINDOWS) {
        // ffmpeg can capture from DirectShow webcam
        if (findBinary('ffmpeg')) {
            return {
                cmd: `ffmpeg -f dshow -i video="Integrated Camera" -frames:v 1 -y "${outputPath}" 2>NUL`,
                available: true,
                waitMs: 5000,
            };
        }
        // PowerShell + .NET fallback (requires Windows.Media.Capture)
        return { cmd: '', available: false, waitMs: 0 };
    }

    // Linux: ffmpeg with v4l2
    if (findBinary('ffmpeg')) {
        return {
            cmd: `ffmpeg -f v4l2 -i /dev/video0 -frames:v 1 -y "${outputPath}" 2>/dev/null`,
            available: true,
            waitMs: 3000,
        };
    }
    return { cmd: '', available: false, waitMs: 0 };
}

/** Voice recording — avlisten binary path by platform */
export function avlistenPath(): string {
    if (IS_WINDOWS) {
        return `${os.homedir()}\\.cache\\synalux\\avlisten.exe`;
    }
    return `${os.homedir()}/.cache/synalux/avlisten`;
}

/** Dev null path by platform */
export function devNull(): string {
    return IS_WINDOWS ? 'NUL' : '/dev/null';
}
