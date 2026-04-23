/**
 * Platform Utilities — Cross-platform abstractions for Prism CLI
 * ================================================================
 *
 * Provides OS-aware implementations for shell commands, file operations,
 * and system tools. Supports macOS, Linux, and Windows 10+.
 *
 * Key design decisions:
 * - Never hardcode paths like /tmp/ or /opt/homebrew/
 * - Always auto-detect binary locations via PATH
 * - Use PowerShell on Windows for complex pipelines
 * - Provide graceful fallbacks on every platform
 */

import { execSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';

export const IS_WINDOWS = process.platform === 'win32';
export const IS_MAC = process.platform === 'darwin';
export const IS_LINUX = process.platform === 'linux';

// ---------------------------------------------------------------------------
// ANSI / Terminal
// ---------------------------------------------------------------------------

/**
 * Enable ANSI escape sequence processing on Windows.
 * Windows Terminal supports ANSI natively, but legacy cmd.exe and
 * ConHost need ENABLE_VIRTUAL_TERMINAL_PROCESSING (0x0004) set
 * on the console output handle. Node.js does NOT set this by default.
 *
 * Call this once at CLI startup.
 */
export function enableAnsiOnWindows(): void {
    if (!IS_WINDOWS) return;

    // Windows Terminal already supports ANSI — check via WT_SESSION env
    if (process.env.WT_SESSION) return;

    try {
        // Use PowerShell to flip the VT processing bit on the console
        execSync(
            `powershell -NoProfile -Command "` +
            `$k = Add-Type -MemberDefinition '` +
            `[DllImport(\\\"kernel32.dll\\\")]public static extern IntPtr GetStdHandle(int h);` +
            `[DllImport(\\\"kernel32.dll\\\")]public static extern bool GetConsoleMode(IntPtr h,out int m);` +
            `[DllImport(\\\"kernel32.dll\\\")]public static extern bool SetConsoleMode(IntPtr h,int m);` +
            `' -Name K -PassThru;` +
            `$h=[K]::GetStdHandle(-11);$m=0;[K]::GetConsoleMode($h,[ref]$m);` +
            `[K]::SetConsoleMode($h,$m -bor 4)"`,
            { stdio: 'pipe', timeout: 5000 },
        );
    } catch {
        // Silently fail — colors just won't render in legacy terminals
    }
}

/** Whether the terminal likely supports ANSI colors */
export function supportsAnsi(): boolean {
    if (IS_WINDOWS) {
        // Windows Terminal, VS Code terminal, or ConEmu
        return !!(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI);
    }
    return process.stdout.isTTY === true;
}

// ---------------------------------------------------------------------------
// Temp directory — NEVER use /tmp/ directly
// ---------------------------------------------------------------------------

/** Get a cross-platform temp file path */
export function tempPath(filename: string): string {
    return path.join(os.tmpdir(), filename);
}

// ---------------------------------------------------------------------------
// Shell / Command helpers
// ---------------------------------------------------------------------------

/** The shell to use for PowerShell commands on Windows */
export function windowsShell(): string | undefined {
    return IS_WINDOWS ? 'powershell.exe' : undefined;
}

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
            path.join(os.homedir(), 'AppData', 'Roaming', 'npm', `${name}.cmd`),
            path.join(os.homedir(), 'AppData', 'Local', 'Programs', name, `${name}.exe`),
            path.join('C:', 'Program Files', name, `${name}.exe`),
            path.join(os.homedir(), 'scoop', 'shims', `${name}.exe`),
        ];
        for (const p of winPaths) {
            try {
                execSync(`if exist "${p}" echo found`, { stdio: 'pipe', shell: 'cmd.exe' });
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
 * Uses curl on Unix, PowerShell Invoke-WebRequest on Windows.
 */
export function fetchUrlCommand(url: string): string {
    const safeUrl = url.replace(/"/g, '\\"');

    if (IS_WINDOWS) {
        // PowerShell pipeline: strip HTML tags, collapse whitespace
        const psUrl = url.replace(/'/g, "''");
        return (
            `powershell -NoProfile -Command "& { ` +
            `$r = Invoke-WebRequest -Uri '${psUrl}' -UseBasicParsing -TimeoutSec 15; ` +
            `$t = $r.Content -replace '<script[^>]*>[\\s\\S]*?</script>','' ` +
            `-replace '<style[^>]*>[\\s\\S]*?</style>','' ` +
            `-replace '<[^>]+>','' -replace '\\s+',' '; ` +
            `$t.Substring(0, [Math]::Min($t.Length, 8000)) }"`
        );
    }

    // macOS / Linux: curl + sed pipeline
    const curlBase = `curl -sL --max-time 15 --max-filesize 1048576 -H "User-Agent: Mozilla/5.0" "${safeUrl}"`;
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
        const psDir = dir.replace(/'/g, "''");
        let cmd = `powershell -NoProfile -Command "Get-ChildItem -Path '${psDir}' -Recurse -Depth ${maxDepth}`;
        cmd += ` | Where-Object { $_.FullName -notmatch 'node_modules|\\.git' }`;
        if (pattern) {
            cmd += ` | Where-Object { $_.Name -like '${pattern.replace(/'/g, "''")}' }`;
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

    // Try ripgrep first (cross-platform, fast)
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
        // PowerShell System.Speech (built into Windows, no install needed)
        const psText = safe.replace(/'/g, "''");
        const psRate = Math.max(-10, Math.min(10, Math.round((rate - 150) / 25)));
        return (
            `powershell -NoProfile -Command "` +
            `Add-Type -AssemblyName System.Speech; ` +
            `$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ` +
            `$s.Rate = ${psRate}; ` +
            `$s.Speak('${psText}')"`
        );
    }

    // Linux: try espeak-ng first (modern), then espeak, then spd-say
    if (findBinary('espeak-ng')) {
        return `espeak-ng -s ${rate} "${safe}"`;
    }
    if (findBinary('espeak')) {
        return `espeak -s ${rate} "${safe}"`;
    }
    if (findBinary('spd-say')) {
        return `spd-say "${safe}"`;
    }
    return `echo "TTS unavailable — install espeak-ng: sudo apt install espeak-ng"`;
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
        // PowerShell: save clipboard image — works on all Windows 10+
        const psPath = outputPath.replace(/'/g, "''");
        const ps = (
            `Add-Type -AssemblyName System.Windows.Forms; ` +
            `$img = [System.Windows.Forms.Clipboard]::GetImage(); ` +
            `if ($img) { $img.Save('${psPath}') } ` +
            `else { throw 'No image in clipboard' }`
        );
        return { cmd: `powershell -NoProfile -Command "${ps}"`, available: true };
    }

    // Linux: xclip → xsel → wl-paste (Wayland)
    if (findBinary('xclip')) {
        return { cmd: `xclip -selection clipboard -t image/png -o > "${outputPath}"`, available: true };
    }
    if (findBinary('wl-paste')) {
        return { cmd: `wl-paste --type image/png > "${outputPath}"`, available: true };
    }
    return { cmd: '', available: false };
}

/**
 * Camera capture command — auto-detects webcam device on each platform.
 *
 * macOS: imagesnap (simple, reliable)
 * Windows: ffmpeg with DirectShow — auto-lists devices to find webcam name
 * Linux: ffmpeg with v4l2 — uses /dev/video0 by default
 */
export function cameraCaptureCommand(outputPath: string): { cmd: string; available: boolean; waitMs: number } {
    if (IS_MAC) {
        if (findBinary('imagesnap')) {
            return { cmd: `imagesnap -w 1 "${outputPath}"`, available: true, waitMs: 3000 };
        }
        // ffmpeg fallback on macOS
        if (findBinary('ffmpeg')) {
            return {
                cmd: `ffmpeg -f avfoundation -framerate 30 -i "0" -frames:v 1 -y "${outputPath}" 2>/dev/null`,
                available: true,
                waitMs: 3000,
            };
        }
        return { cmd: '', available: false, waitMs: 0 };
    }

    if (IS_WINDOWS) {
        if (findBinary('ffmpeg')) {
            // Auto-detect webcam device name via DirectShow listing
            let deviceName = 'Integrated Camera'; // sensible default
            try {
                const listOutput = execSync(
                    'ffmpeg -list_devices true -f dshow -i dummy 2>&1',
                    { stdio: 'pipe', timeout: 5000, shell: 'cmd.exe' },
                ).toString();
                // Parse: DirectShow video devices — find first video device
                const videoMatch = listOutput.match(/\] "([^"]+)"\s*\n.*Alternative name/);
                if (videoMatch?.[1]) {
                    deviceName = videoMatch[1];
                }
            } catch (e: unknown) {
                // ffmpeg -list_devices returns exit code 1 but stderr has the data
                const stderr = (e as { stderr?: Buffer })?.stderr?.toString() || '';
                const videoMatch = stderr.match(/\] "([^"]+)"\s*\r?\n.*Alternative name/);
                if (videoMatch?.[1]) {
                    deviceName = videoMatch[1];
                }
            }
            return {
                cmd: `ffmpeg -f dshow -i video="${deviceName}" -frames:v 1 -y "${outputPath}" 2>NUL`,
                available: true,
                waitMs: 5000,
            };
        }
        return { cmd: '', available: false, waitMs: 0 };
    }

    // Linux: ffmpeg with v4l2 — auto-detect video device
    if (findBinary('ffmpeg')) {
        let device = '/dev/video0';
        try {
            // Check if v4l2-ctl is available for better detection
            if (findBinary('v4l2-ctl')) {
                const devOutput = execSync('v4l2-ctl --list-devices 2>/dev/null', {
                    stdio: 'pipe',
                    timeout: 3000,
                }).toString();
                const devMatch = devOutput.match(/(\/dev\/video\d+)/);
                if (devMatch?.[1]) device = devMatch[1];
            }
        } catch { /* use default */ }
        return {
            cmd: `ffmpeg -f v4l2 -i ${device} -frames:v 1 -y "${outputPath}" 2>/dev/null`,
            available: true,
            waitMs: 3000,
        };
    }
    return { cmd: '', available: false, waitMs: 0 };
}

// ---------------------------------------------------------------------------
// Voice recording — cross-platform
// ---------------------------------------------------------------------------

/** Voice recording binary path per platform */
export function avlistenPath(): string {
    if (IS_WINDOWS) {
        return path.join(os.homedir(), '.cache', 'synalux', 'avlisten.exe');
    }
    return path.join(os.homedir(), '.cache', 'synalux', 'avlisten');
}

/**
 * Cross-platform audio recording command.
 * Used as a FALLBACK when avlisten is not available.
 *
 * Records a WAV file that can be sent to Gemini for transcription.
 * Returns { cmd, available, outputPath }.
 */
export function audioRecordCommand(durationSec: number): {
    cmd: string;
    available: boolean;
    outputPath: string;
    format: string;
} {
    const outPath = tempPath('prism-voice-recording.wav');

    if (IS_MAC) {
        // SoX (brew install sox) — most reliable
        if (findBinary('sox')) {
            return {
                cmd: `sox -d -r 16000 -c 1 -b 16 "${outPath}" trim 0 ${durationSec}`,
                available: true,
                outputPath: outPath,
                format: 'audio/wav',
            };
        }
        // ffmpeg with AVFoundation
        if (findBinary('ffmpeg')) {
            return {
                cmd: `ffmpeg -f avfoundation -i ":0" -t ${durationSec} -ar 16000 -ac 1 -y "${outPath}" 2>/dev/null`,
                available: true,
                outputPath: outPath,
                format: 'audio/wav',
            };
        }
        return { cmd: '', available: false, outputPath: '', format: '' };
    }

    if (IS_WINDOWS) {
        // SoX for Windows
        if (findBinary('sox')) {
            return {
                cmd: `sox -d -r 16000 -c 1 -b 16 "${outPath}" trim 0 ${durationSec}`,
                available: true,
                outputPath: outPath,
                format: 'audio/wav',
            };
        }
        // ffmpeg with DirectShow audio
        if (findBinary('ffmpeg')) {
            // Auto-detect microphone
            let micName = 'Microphone';
            try {
                const listOutput = execSync(
                    'ffmpeg -list_devices true -f dshow -i dummy 2>&1',
                    { stdio: 'pipe', timeout: 5000, shell: 'cmd.exe' },
                ).toString();
                const audioMatch = listOutput.match(/DirectShow audio devices[\s\S]*?\] "([^"]+)"/);
                if (audioMatch?.[1]) micName = audioMatch[1];
            } catch (e: unknown) {
                const stderr = (e as { stderr?: Buffer })?.stderr?.toString() || '';
                const audioMatch = stderr.match(/DirectShow audio devices[\s\S]*?\] "([^"]+)"/);
                if (audioMatch?.[1]) micName = audioMatch[1];
            }
            return {
                cmd: `ffmpeg -f dshow -i audio="${micName}" -t ${durationSec} -ar 16000 -ac 1 -y "${outPath}" 2>NUL`,
                available: true,
                outputPath: outPath,
                format: 'audio/wav',
            };
        }
        // PowerShell + .NET AudioEndpoints as last resort
        return {
            cmd: `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; $r = New-Object System.Speech.Recognition.SpeechRecognitionEngine; $r.SetInputToDefaultAudioDevice(); $r.LoadGrammar((New-Object System.Speech.Recognition.DictationGrammar)); $result = $r.Recognize((New-Object TimeSpan(0,0,${durationSec}))); if($result){$result.Text}else{'(no speech detected)'}"`,
            available: true,
            outputPath: '',  // returns text directly, not a file
            format: 'text',
        };
    }

    // Linux
    // arecord (ALSA) — most common on Linux
    if (findBinary('arecord')) {
        return {
            cmd: `arecord -d ${durationSec} -f cd -t wav "${outPath}" 2>/dev/null`,
            available: true,
            outputPath: outPath,
            format: 'audio/wav',
        };
    }
    // SoX
    if (findBinary('sox')) {
        return {
            cmd: `sox -d -r 16000 -c 1 -b 16 "${outPath}" trim 0 ${durationSec}`,
            available: true,
            outputPath: outPath,
            format: 'audio/wav',
        };
    }
    // ffmpeg PulseAudio
    if (findBinary('ffmpeg')) {
        return {
            cmd: `ffmpeg -f pulse -i default -t ${durationSec} -ar 16000 -ac 1 -y "${outPath}" 2>/dev/null`,
            available: true,
            outputPath: outPath,
            format: 'audio/wav',
        };
    }
    return { cmd: '', available: false, outputPath: '', format: '' };
}

/**
 * Get install instructions for voice recording tools.
 */
export function voiceInstallInstructions(): string {
    if (IS_MAC) return 'Install SoX: brew install sox';
    if (IS_WINDOWS) return 'Install SoX: choco install sox  OR  winget install sox  OR install ffmpeg';
    return 'Install arecord (ALSA): sudo apt install alsa-utils  OR  SoX: sudo apt install sox';
}

/** Dev null path by platform */
export function devNull(): string {
    return IS_WINDOWS ? 'NUL' : '/dev/null';
}
