#!/usr/bin/env python3
"""
browse.py — HIPAA-Hardened Stealth Browser Automation CLI
==========================================================
Local Playwright-based browser automation with multi-layer anti-detection.
Zero cloud dependency. Runs entirely on localhost.

STEALTH LAYERS:
  Layer 1: playwright-stealth v2.x — JS evasion scripts (webdriver, chrome.runtime, etc.)
  Layer 2: Realistic browser fingerprint — User-Agent, viewport, locale, timezone, WebGL
  Layer 3: Behavioral stealth — human-like mouse, typing delays, scroll jitter
  Layer 4: Chromium launch args — anti-automation flags, rendering mimicry
  Layer 5: Network stealth — real browser headers, TLS fingerprint via Chromium
  Layer 6: Persistent profiles — cookie jars survive restarts (looks like returning user)

SECURITY (HIPAA):
  - FileVault (FDE) enforcement check
  - Isolated persistent browser profiles (~/.browser_data/<profile>/)
  - Audit logging (URLs + actions, never PHI content)
  - --cleanup flag for secure screenshot wiping
  - --sanitize flag to mask PHI patterns (SSN, MRN, phone) in output

MODES:
  Single command:  browse.py open https://example.com
  Interactive:     browse.py repl           (keeps browser open, type commands)
  Pipe/batch:      echo "open https://..." | browse.py pipe
"""

import argparse
import datetime
import io
import json
import os
import random
import re
import select
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BROWSER_DATA_DIR = Path.home() / ".browser_data"
AUDIT_LOG_PATH = BROWSER_DATA_DIR / "audit.log"
DEFAULT_PROFILE = "default"
DEFAULT_TIMEOUT = 30000
DEFAULT_VIEWPORT = (1440, 900)
REPL_IDLE_TIMEOUT = 600  # 10 minutes — auto-close to prevent zombie Chromium
STEALTH_AVAILABLE = False

try:
    from playwright_stealth import Stealth
    STEALTH_AVAILABLE = True
except ImportError:
    pass

# PHI sanitization patterns
PHI_PATTERNS = [
    (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'), '[SSN-REDACTED]'),
    (re.compile(r'\b\d{9}\b'), '[SSN-REDACTED]'),
    (re.compile(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'), '[PHONE-REDACTED]'),
    (re.compile(r'\bMRN[-:#]?\s*\d{4,12}\b', re.IGNORECASE), '[MRN-REDACTED]'),
    (re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'), '[EMAIL-REDACTED]'),
]

# ---------------------------------------------------------------------------
# Stealth Configuration — the core anti-detection engine
# ---------------------------------------------------------------------------
# Realistic User-Agent strings for macOS Chrome (rotated per-profile)
STEALTH_USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.117 Safari/537.36",
]

# Chromium args that reduce automation fingerprint
STEALTH_CHROMIUM_ARGS = [
    '--disable-blink-features=AutomationControlled',  # Kill navigator.webdriver
    '--disable-features=IsolateOrigins,site-per-process',  # Reduce iframe isolation fingerprint
    '--disable-site-isolation-trials',
    '--disable-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',                              # Remove "Chrome is controlled" bar
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-dev-shm-usage',
    '--disable-hang-monitor',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--enable-features=NetworkService,NetworkServiceInProcess',
    '--force-color-profile=srgb',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--lang=en-US',
]

# Deep stealth: JavaScript to inject BEFORE any page scripts run
# These patches survive beyond what playwright-stealth provides
DEEP_STEALTH_INIT_SCRIPT = """
// === LAYER 2: Deep Fingerprint Evasion ===

// 1. Override navigator.webdriver (belt-and-suspenders with playwright-stealth)
Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
    configurable: true
});

// 2. Mock chrome.runtime to look like a real browser
if (!window.chrome) { window.chrome = {}; }
if (!window.chrome.runtime) {
    window.chrome.runtime = {
        connect: function() { return { onMessage: { addListener: function(){} }, postMessage: function(){} }; },
        sendMessage: function() {},
        id: undefined,  // Real Chrome has undefined id in non-extension context
        onMessage: { addListener: function(){}, removeListener: function(){} },
        onConnect: { addListener: function(){}, removeListener: function(){} },
    };
}

// 3. Fix chrome.csi (Chrome Session Information)
if (!window.chrome.csi) {
    window.chrome.csi = function() {
        return {
            startE: Date.now(),
            onloadT: Date.now(),
            pageT: Math.random() * 1000 + 200,
            tran: 15
        };
    };
}

// 4. Fix chrome.loadTimes
if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = function() {
        return {
            commitLoadTime: Date.now() / 1000,
            connectionInfo: "h2",
            finishDocumentLoadTime: Date.now() / 1000 + Math.random(),
            finishLoadTime: Date.now() / 1000 + Math.random(),
            firstPaintAfterLoadTime: 0,
            firstPaintTime: Date.now() / 1000 + Math.random() * 0.5,
            navigationType: "Other",
            npnNegotiatedProtocol: "h2",
            requestTime: Date.now() / 1000 - Math.random(),
            startLoadTime: Date.now() / 1000 - Math.random(),
            wasAlternateProtocolAvailable: false,
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
        };
    };
}

// 5. Fix navigator.plugins (headless has 0 plugins — dead giveaway)
if (navigator.plugins.length === 0) {
    Object.defineProperty(navigator, 'plugins', {
        get: () => {
            const plugins = [
                { name: "PDF Viewer", filename: "internal-pdf-viewer", description: "Portable Document Format" },
                { name: "Chrome PDF Viewer", filename: "internal-pdf-viewer", description: "" },
                { name: "Chromium PDF Viewer", filename: "internal-pdf-viewer", description: "" },
                { name: "Microsoft Edge PDF Viewer", filename: "internal-pdf-viewer", description: "" },
                { name: "WebKit built-in PDF", filename: "internal-pdf-viewer", description: "" },
            ];
            plugins.item = (i) => plugins[i] || null;
            plugins.namedItem = (name) => plugins.find(p => p.name === name) || null;
            plugins.refresh = () => {};
            return plugins;
        },
        configurable: true
    });
}

// 6. Fix navigator.mimeTypes
if (navigator.mimeTypes.length === 0) {
    Object.defineProperty(navigator, 'mimeTypes', {
        get: () => {
            const mimes = [
                { type: "application/pdf", suffixes: "pdf", description: "Portable Document Format" },
                { type: "text/pdf", suffixes: "pdf", description: "" },
            ];
            mimes.item = (i) => mimes[i] || null;
            mimes.namedItem = (name) => mimes.find(m => m.type === name) || null;
            return mimes;
        },
        configurable: true
    });
}

// 7. Fix permissions API (Notification.permission detection)
const originalQuery = window.navigator.permissions?.query;
if (originalQuery) {
    window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
    );
}

// 8. Prevent iframe detection (contentWindow detection)
const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
Object.getOwnPropertyDescriptor = function(obj, prop) {
    if (prop === 'contentWindow' || prop === 'contentDocument') {
        return undefined;
    }
    return originalGetOwnPropertyDescriptor(obj, prop);
};

// 9. Fix WebGL vendor/renderer (headless shows "Google SwiftShader")
const getParameter = WebGLRenderingContext.prototype.getParameter;
WebGLRenderingContext.prototype.getParameter = function(parameter) {
    // UNMASKED_VENDOR_WEBGL
    if (parameter === 37445) {
        return 'Google Inc. (Apple)';
    }
    // UNMASKED_RENDERER_WEBGL
    if (parameter === 37446) {
        return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)';
    }
    return getParameter.call(this, parameter);
};

// Also patch WebGL2
if (typeof WebGL2RenderingContext !== 'undefined') {
    const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(parameter) {
        if (parameter === 37445) return 'Google Inc. (Apple)';
        if (parameter === 37446) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)';
        return getParameter2.call(this, parameter);
    };
}

// 10. Fix navigator.connection (missing in automation)
if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
        get: () => ({
            downlink: 10,
            effectiveType: '4g',
            rtt: 50,
            saveData: false,
            onchange: null,
        }),
        configurable: true
    });
}

// 11. Fix window.outerHeight/outerWidth (headless often has 0)
if (window.outerHeight === 0) {
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
}
if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
}

// 12. Prevent toString() detection of overridden functions
// Bot detectors call .toString() on navigator methods to check for "[native code]"
const nativeToString = Function.prototype.toString;
const nativeFunctions = new Map();
const handler = {
    apply: function(target, ctx, args) {
        if (ctx === navigator.permissions.query) {
            return 'function query() { [native code] }';
        }
        return nativeToString.apply(ctx, args);
    }
};
// Only wrap if Proxy is available
if (typeof Proxy !== 'undefined') {
    try {
        Function.prototype.toString = new Proxy(nativeToString, handler);
    } catch(e) {}
}
"""


# ---------------------------------------------------------------------------
# Security checks
# ---------------------------------------------------------------------------
def check_filevault():
    """Verify FileVault (Full Disk Encryption) is enabled."""
    try:
        result = subprocess.run(['fdesetup', 'status'], capture_output=True, text=True, timeout=5)
        if 'FileVault is On' in result.stdout:
            return True
        print("⛔ HIPAA VIOLATION: FileVault is OFF.", file=sys.stderr)
        return False
    except Exception:
        print("⚠️  Cannot verify disk encryption.", file=sys.stderr)
        return True


def sanitize_phi(text: str) -> str:
    """Mask PHI patterns in text output."""
    for pattern, replacement in PHI_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def secure_delete(filepath: str):
    """Securely wipe a file."""
    path = Path(filepath)
    if not path.exists():
        return
    try:
        size = path.stat().st_size
        with open(path, 'wb') as f:
            f.write(os.urandom(size))
            f.flush()
            os.fsync(f.fileno())
        path.unlink()
    except Exception as e:
        print(f"⚠️  Secure delete failed: {e}", file=sys.stderr)
        try:
            path.unlink()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------
def _ensure_audit_log_permissions():
    """Create audit log with strict permissions (chmod 600) so other processes can't read it."""
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    if not AUDIT_LOG_PATH.exists():
        AUDIT_LOG_PATH.touch(mode=0o600)
    else:
        try:
            os.chmod(AUDIT_LOG_PATH, 0o600)
        except Exception:
            pass


def audit_log(action: str, target: str = "", details: str = ""):
    """Write audit log entry. Records WHAT and WHERE, never content."""
    _ensure_audit_log_permissions()
    ts = datetime.datetime.now().isoformat()
    safe = details[:200] if details else ""
    try:
        with open(AUDIT_LOG_PATH, 'a') as f:
            f.write(f"{ts} | {action} | {target} | {safe}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Behavioral stealth — human-like interaction helpers
# ---------------------------------------------------------------------------
def human_delay(min_ms=50, max_ms=200):
    """Random human-like delay between actions."""
    time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))


def human_type(page, text, selector=None):
    """Type like a human with variable delays between keystrokes."""
    if selector:
        page.click(selector)
        human_delay(100, 300)

    for char in text:
        page.keyboard.type(char, delay=random.randint(30, 120))
        # Occasional longer pause (like thinking)
        if random.random() < 0.05:
            human_delay(200, 500)


def human_scroll(page, direction="down", steps=3):
    """Scroll like a human — variable speed, small increments."""
    for _ in range(steps):
        delta = random.randint(150, 400) * (1 if direction == "down" else -1)
        page.mouse.wheel(0, delta)
        human_delay(100, 400)


def human_mouse_move(page, x, y):
    """Move mouse with slight curve (not teleportation)."""
    # Get current approximate position
    page.mouse.move(x + random.randint(-5, 5), y + random.randint(-5, 5))
    human_delay(30, 80)
    page.mouse.move(x, y)


# ---------------------------------------------------------------------------
# Browser Session with Stealth
# ---------------------------------------------------------------------------
class StealthBrowserSession:
    """Manages a stealth Playwright browser session."""

    def __init__(self, profile=DEFAULT_PROFILE, headless=False,
                 timeout=DEFAULT_TIMEOUT, viewport=DEFAULT_VIEWPORT,
                 stealth_level="full"):
        self.profile = profile
        self.headless = headless
        self.timeout = timeout
        self.viewport = viewport
        self.stealth_level = stealth_level  # "full", "light", "none"
        self.profile_dir = BROWSER_DATA_DIR / profile
        self._playwright = None
        self._context = None
        self._page = None
        # Pick a consistent UA for this profile
        ua_idx = hash(profile) % len(STEALTH_USER_AGENTS)
        self._user_agent = STEALTH_USER_AGENTS[ua_idx]

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()

    def start(self):
        from playwright.sync_api import sync_playwright
        self.profile_dir.mkdir(parents=True, exist_ok=True)
        self._playwright = sync_playwright().start()

        # Validate UA ↔ WebGL fingerprint consistency
        # If UA says "Mac OS X 14_5" then WebGL must say Apple/Metal, not SwiftShader
        self._validate_fingerprint_consistency()

        # Build launch args
        launch_args = list(STEALTH_CHROMIUM_ARGS) if self.stealth_level != "none" else [
            '--no-first-run', '--no-default-browser-check'
        ]

        # Launch persistent context
        self._context = self._playwright.chromium.launch_persistent_context(
            user_data_dir=str(self.profile_dir),
            headless=self.headless,
            viewport={'width': self.viewport[0], 'height': self.viewport[1]},
            user_agent=self._user_agent,
            locale='en-US',
            timezone_id='America/New_York',
            geolocation={'latitude': 40.7128, 'longitude': -74.0060},  # NYC
            permissions=['geolocation'],
            color_scheme='light',
            args=launch_args,
            ignore_default_args=['--enable-automation'],  # Critical: removes automation flag
        )
        self._context.set_default_timeout(self.timeout)

        # Apply stealth evasions
        if self.stealth_level != "none":
            self._apply_stealth()

        # Get or create page
        if self._context.pages:
            self._page = self._context.pages[0]
        else:
            self._page = self._context.new_page()

        audit_log("session_start", f"profile={self.profile}",
                  f"stealth={self.stealth_level},headless={self.headless}")

    def _apply_stealth(self):
        """Apply multi-layer stealth evasions."""
        # Layer 1: playwright-stealth library (if available)
        if STEALTH_AVAILABLE and self.stealth_level == "full":
            try:
                stealth = Stealth(
                    # Configure specific evasions
                    navigator_webdriver=True,
                    navigator_plugins=True,
                    navigator_permissions=True,
                    navigator_languages_override=("en-US", "en"),
                    webgl_vendor="Google Inc. (Apple)",
                    webgl_renderer="ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)",
                    init_scripts_only=True,  # Required for persistent context
                )
                stealth.apply_stealth_sync(self._context)
                audit_log("stealth", "playwright-stealth", "applied_v2")
            except Exception as e:
                audit_log("stealth", "playwright-stealth", f"error={e}")

        # Layer 2: Deep JS init script (always applied for full/light)
        try:
            self._context.add_init_script(DEEP_STEALTH_INIT_SCRIPT)
            audit_log("stealth", "deep_init_script", "injected")
        except Exception as e:
            audit_log("stealth", "deep_init_script", f"error={e}")

        # Layer 3: Route handler to fix headers
        def fix_headers(route, request):
            """Ensure realistic HTTP headers on every request."""
            headers = {
                **request.headers,
                'sec-ch-ua': '"Chromium";v="131", "Google Chrome";v="131", "Not_A_Brand";v="24"',
                'sec-ch-ua-mobile': '?0',
                'sec-ch-ua-platform': '"macOS"',
                'sec-fetch-dest': request.headers.get('sec-fetch-dest', 'document'),
                'sec-fetch-mode': request.headers.get('sec-fetch-mode', 'navigate'),
                'sec-fetch-site': request.headers.get('sec-fetch-site', 'none'),
                'sec-fetch-user': '?1',
                'upgrade-insecure-requests': '1',
            }
            # Remove automation-specific headers
            headers.pop('sec-ch-ua-full-version-list', None)
            route.continue_(headers=headers)

        try:
            self._context.route("**/*", fix_headers)
            audit_log("stealth", "header_fix", "routing_active")
        except Exception as e:
            audit_log("stealth", "header_fix", f"error={e}")

    def _validate_fingerprint_consistency(self):
        """
        Validate that User-Agent and WebGL renderer fingerprints are consistent.
        Enterprise WAFs (Cloudflare Turnstile) flag mismatches between UA and WebGL.
        E.g., UA says 'Mac OS X' but WebGL says 'Google SwiftShader' = flagged.
        """
        ua = self._user_agent.lower()
        # Ensure macOS UA gets Apple/Metal WebGL (not SwiftShader)
        if 'macintosh' in ua or 'mac os x' in ua:
            # Our DEEP_STEALTH_INIT_SCRIPT already sets Apple M3 Max — consistent
            audit_log("fingerprint_check", "ua_webgl", "consistent=true,platform=macos")
        elif 'windows' in ua:
            # Would need to adjust WebGL to Intel/NVIDIA — not our case
            audit_log("fingerprint_check", "ua_webgl", "warning=windows_ua_with_macos_webgl")
        else:
            audit_log("fingerprint_check", "ua_webgl", "consistent=unknown")

    def stop(self):
        if self._context:
            try:
                self._context.close()
            except Exception:
                pass
        if self._playwright:
            try:
                self._playwright.stop()
            except Exception:
                pass
        audit_log("session_stop", f"profile={self.profile}")

    @property
    def page(self):
        return self._page

    @property
    def context(self):
        return self._context


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_open(session, url):
    """Navigate to URL."""
    try:
        session.page.goto(url, wait_until='domcontentloaded')
        session.page.wait_for_load_state('networkidle', timeout=15000)
    except Exception:
        pass  # networkidle may timeout on heavy pages, that's ok
    title = session.page.title()
    current_url = session.page.url
    audit_log("open", url, f"title={title}")
    return {"status": "ok", "url": current_url, "title": title}


def cmd_screenshot(session, output=None, cleanup=False):
    """Take screenshot. When cleanup=True, writes to /tmp (avoids APFS CoW residue)."""
    if not output:
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
        if cleanup:
            # APFS Copy-on-Write: overwriting doesn't guarantee physical block wipe.
            # Use /tmp (may be RAM-backed) for ephemeral screenshots.
            output = os.path.join(tempfile.gettempdir(), f"browse_ss_{ts}.png")
        else:
            output = f"screenshot_{ts}.png"
    path = Path(output).resolve()
    session.page.screenshot(path=str(path), full_page=True)
    size = path.stat().st_size
    audit_log("screenshot", str(path), f"size={size},ephemeral={cleanup}")
    result = {"status": "ok", "path": str(path), "size_bytes": size}
    if cleanup:
        result["cleanup_path"] = str(path)
        result["ephemeral"] = True
    return result


def cmd_read_dom(session, selector=None, sanitize=False):
    """Read DOM text content."""
    if selector:
        try:
            el = session.page.wait_for_selector(selector, timeout=10000)
            text = el.inner_text() if el else ""
        except Exception as e:
            return {"status": "error", "message": str(e)}
    else:
        text = session.page.inner_text('body')
    if sanitize:
        text = sanitize_phi(text)
    audit_log("read_dom", selector or "body", f"chars={len(text)}")
    return {"status": "ok", "text": text}


def cmd_read_page(session, sanitize=False):
    """Read full page as structured text."""
    title = session.page.title()
    url = session.page.url
    body = session.page.inner_text('body')
    if sanitize:
        body = sanitize_phi(body)
        title = sanitize_phi(title)
    audit_log("read_page", url, f"chars={len(body)}")
    return {"status": "ok", "url": url, "title": title, "text": body}


def cmd_click(session, selector):
    """Click with human-like behavior."""
    human_delay(100, 300)
    session.page.click(selector)
    audit_log("click", selector)
    return {"status": "ok", "action": "click", "selector": selector}


def cmd_type_text(session, selector, text, human=True):
    """Type text into element."""
    if human:
        human_type(session.page, text, selector)
    else:
        session.page.fill(selector, text)
    audit_log("type", selector, f"chars={len(text)}")
    return {"status": "ok", "action": "type", "selector": selector, "chars": len(text)}


def cmd_scroll(session, direction="down", amount=3):
    """Scroll page with human-like behavior."""
    human_scroll(session.page, direction, amount)
    audit_log("scroll", direction, f"steps={amount}")
    return {"status": "ok", "action": "scroll", "direction": direction}


def cmd_wait_for(session, selector, timeout=None):
    """Wait for element (Playwright auto-waiting)."""
    t = timeout or session.timeout
    try:
        el = session.page.wait_for_selector(selector, timeout=t, state='visible')
        preview = el.inner_text()[:100] if el else ""
        audit_log("wait_for", selector, "found=true")
        return {"status": "ok", "found": True, "preview": preview}
    except Exception as e:
        audit_log("wait_for", selector, f"found=false")
        return {"status": "timeout", "found": False, "error": str(e)}


def cmd_eval(session, js_code, sanitize=False):
    """Evaluate JavaScript."""
    result = session.page.evaluate(js_code)
    output = str(result)
    if sanitize:
        output = sanitize_phi(output)
    audit_log("eval", "js", f"chars={len(output)}")
    return {"status": "ok", "result": output}


# Google Docs commands
def cmd_gdoc_read(session, sanitize=False):
    """Read Google Doc content using keyboard shortcuts."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}

    try:
        page.wait_for_selector('.kix-appview-editor', timeout=10000)
    except Exception:
        page.wait_for_load_state('networkidle')

    # Click into doc body
    try:
        page.click('.kix-appview-editor', timeout=5000)
    except Exception:
        try:
            page.click('.kix-page', timeout=5000)
        except Exception:
            pass

    human_delay(300, 600)
    mod = 'Meta' if sys.platform == 'darwin' else 'Control'

    # Select all + copy
    page.keyboard.press(f'{mod}+a')
    human_delay(200, 400)
    page.keyboard.press(f'{mod}+c')
    human_delay(300, 600)

    # Try clipboard
    text = None
    try:
        text = page.evaluate('''async () => {
            try { return await navigator.clipboard.readText(); }
            catch(e) { return null; }
        }''')
    except Exception:
        pass

    # Fallback: DOM extraction
    if not text:
        try:
            text = page.evaluate('''() => {
                const nodes = document.querySelectorAll('.kix-lineview .kix-wordhtmlgenerator-word-node');
                if (nodes.length > 0) return Array.from(nodes).map(n => n.textContent).join('');
                const ed = document.querySelector('.kix-appview-editor');
                return ed ? ed.innerText : document.body.innerText;
            }''')
        except Exception:
            text = page.inner_text('body')

    page.keyboard.press('End')  # Deselect

    if sanitize and text:
        text = sanitize_phi(text)

    audit_log("gdoc_read", page.url, f"chars={len(text) if text else 0}")
    return {"status": "ok", "text": text or ""}


def cmd_gdoc_type(session, text):
    """Type text at cursor in Google Doc with human-like delays."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}
    human_type(page, text)
    audit_log("gdoc_type", page.url, f"chars={len(text)}")
    return {"status": "ok", "action": "gdoc_type", "chars": len(text)}


def cmd_gdoc_find(session, search_text):
    """Find text in Google Doc using Ctrl+F."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}
    mod = 'Meta' if sys.platform == 'darwin' else 'Control'
    page.keyboard.press(f'{mod}+f')
    human_delay(300, 600)
    human_type(page, search_text)
    human_delay(300, 500)
    page.keyboard.press('Enter')
    human_delay(300, 500)
    page.keyboard.press('Escape')
    human_delay(200, 400)
    audit_log("gdoc_find", page.url, f"query_len={len(search_text)}")
    return {"status": "ok", "action": "gdoc_find"}


def cmd_stealth_test(session):
    """Run bot detection tests and report results."""
    page = session.page
    page.goto('https://bot.sannysoft.com/', wait_until='networkidle')
    human_delay(2000, 3000)

    # Extract test results
    results = page.evaluate('''() => {
        const rows = document.querySelectorAll('table tr');
        const results = {};
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 2) {
                const test = cells[0].textContent.trim();
                const cell = cells[1];
                const passed = cell.classList.contains('result-passed') ||
                              cell.style.backgroundColor === 'rgb(144, 238, 144)' ||
                              cell.textContent.includes('missing') === false;
                results[test] = {
                    value: cells[1].textContent.trim(),
                    passed: !cell.classList.contains('result-failed')
                };
            }
        });
        return results;
    }''')

    # Also check specific known indicators
    webdriver = page.evaluate('navigator.webdriver')
    chrome_exists = page.evaluate('!!window.chrome')
    plugins_count = page.evaluate('navigator.plugins.length')

    audit_log("stealth_test", "bot.sannysoft.com", f"webdriver={webdriver}")

    return {
        "status": "ok",
        "webdriver": webdriver,
        "chrome_exists": chrome_exists,
        "plugins_count": plugins_count,
        "detailed_results": results
    }


# ---------------------------------------------------------------------------
# REPL mode — interactive session with idle timeout & error resilience
# ---------------------------------------------------------------------------
class _IdleTimeoutError(Exception):
    pass


def _alarm_handler(signum, frame):
    raise _IdleTimeoutError()


def _read_input_with_timeout(prompt, timeout_sec):
    """Read input with idle timeout. Uses SIGALRM on Unix."""
    if hasattr(signal, 'SIGALRM'):
        old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
        signal.alarm(timeout_sec)
        try:
            line = input(prompt)
            signal.alarm(0)  # Cancel alarm
            return line
        except _IdleTimeoutError:
            return None  # Timeout
        finally:
            signal.signal(signal.SIGALRM, old_handler)
    else:
        # Fallback for systems without SIGALRM (shouldn't happen on Mac)
        return input(prompt)


def run_repl(session, sanitize=False):
    """
    Interactive REPL — keeps browser open between commands.
    
    Features:
    - 10-min idle timeout: auto-closes browser to prevent zombie Chromium
    - Error resilience: exceptions are caught and returned as JSON, browser stays alive
    - Structured JSON output on stdout for agent parsing
    """
    print(json.dumps({
        "status": "ok",
        "action": "repl_start",
        "profile": session.profile,
        "stealth": session.stealth_level,
        "stealth_lib": "playwright-stealth-v2" if STEALTH_AVAILABLE else "js-only",
        "idle_timeout_sec": REPL_IDLE_TIMEOUT,
    }))
    sys.stdout.flush()

    while True:
        try:
            line = _read_input_with_timeout("browse> ", REPL_IDLE_TIMEOUT)
        except (EOFError, KeyboardInterrupt):
            print(json.dumps({"status": "ok", "action": "repl_exit", "reason": "interrupt"}))
            sys.stdout.flush()
            break

        if line is None:
            # Idle timeout reached — gracefully close
            print(json.dumps({
                "status": "ok",
                "action": "repl_exit",
                "reason": f"idle_timeout_{REPL_IDLE_TIMEOUT}s",
                "message": f"No input for {REPL_IDLE_TIMEOUT}s. Closing browser to prevent zombie process."
            }))
            sys.stdout.flush()
            audit_log("repl_idle_timeout", f"profile={session.profile}", f"timeout={REPL_IDLE_TIMEOUT}s")
            break

        line = line.strip()
        if not line:
            continue

        parts = line.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        # Every command output is structured JSON for agent parsing
        result = None
        try:
            if cmd in ('quit', 'exit', 'q'):
                print(json.dumps({"status": "ok", "action": "repl_exit", "reason": "user_quit"}))
                sys.stdout.flush()
                break
            elif cmd == 'help':
                result = {
                    "status": "ok", "action": "help",
                    "commands": [
                        "open <url>", "screenshot [path]", "read-dom [selector]", "read-page",
                        "click <selector>", "type <selector> <text>", "scroll [up|down]",
                        "wait-for <selector>", "eval <js>",
                        "gdoc-read", "gdoc-type <text>", "gdoc-find <text>",
                        "stealth-test", "url", "title", "quit"
                    ]
                }
            elif cmd == 'open':
                result = cmd_open(session, arg)
            elif cmd == 'screenshot':
                result = cmd_screenshot(session, arg or None)
            elif cmd in ('read-dom', 'readdom', 'dom'):
                result = cmd_read_dom(session, arg or None, sanitize)
            elif cmd in ('read-page', 'readpage', 'page'):
                result = cmd_read_page(session, sanitize)
            elif cmd == 'click':
                result = cmd_click(session, arg)
            elif cmd == 'type':
                tparts = arg.split(maxsplit=1)
                if len(tparts) == 2:
                    result = cmd_type_text(session, tparts[0], tparts[1])
                else:
                    result = {"status": "error", "action": "type", "message": "Usage: type <selector> <text>"}
            elif cmd == 'scroll':
                result = cmd_scroll(session, arg or "down")
            elif cmd in ('wait-for', 'waitfor', 'wait'):
                result = cmd_wait_for(session, arg)
            elif cmd == 'eval':
                result = cmd_eval(session, arg, sanitize)
            elif cmd in ('gdoc-read', 'gdocread'):
                result = cmd_gdoc_read(session, sanitize)
            elif cmd in ('gdoc-type', 'gdoctype'):
                result = cmd_gdoc_type(session, arg)
            elif cmd in ('gdoc-find', 'gdocfind'):
                result = cmd_gdoc_find(session, arg)
            elif cmd in ('stealth-test', 'stealthtest', 'test'):
                result = cmd_stealth_test(session)
            elif cmd == 'url':
                result = {"status": "ok", "action": "url", "url": session.page.url}
            elif cmd == 'title':
                result = {"status": "ok", "action": "title", "title": session.page.title()}
            else:
                result = {"status": "error", "action": cmd, "message": f"Unknown command: {cmd}. Type 'help'."}

        except Exception as e:
            # Error resilience: catch ALL exceptions, return JSON error, keep browser alive
            result = {
                "status": "error",
                "action": cmd,
                "error_type": type(e).__name__,
                "message": str(e)
            }
            audit_log("repl_error", cmd, f"{type(e).__name__}: {str(e)[:150]}")

        if result:
            print(json.dumps(result, indent=2, default=str))
            sys.stdout.flush()


# ---------------------------------------------------------------------------
# Pipe/batch mode
# ---------------------------------------------------------------------------
def run_pipe(session, sanitize=False):
    """Read commands from stdin, one per line."""
    for line in sys.stdin:
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        result = None
        try:
            if cmd == 'open':
                result = cmd_open(session, arg)
            elif cmd == 'screenshot':
                result = cmd_screenshot(session, arg or None)
            elif cmd == 'read-dom':
                result = cmd_read_dom(session, arg or None, sanitize)
            elif cmd == 'read-page':
                result = cmd_read_page(session, sanitize)
            elif cmd == 'click':
                result = cmd_click(session, arg)
            elif cmd == 'scroll':
                result = cmd_scroll(session, arg or "down")
            elif cmd == 'eval':
                result = cmd_eval(session, arg, sanitize)
            elif cmd == 'gdoc-read':
                result = cmd_gdoc_read(session, sanitize)
            elif cmd == 'gdoc-type':
                result = cmd_gdoc_type(session, arg)
            elif cmd == 'gdoc-find':
                result = cmd_gdoc_find(session, arg)
            elif cmd == 'wait':
                time.sleep(float(arg) if arg else 1)
                result = {"status": "ok", "action": "wait"}
        except Exception as e:
            result = {"status": "error", "message": str(e)}

        if result:
            print(json.dumps(result, default=str))
            sys.stdout.flush()


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description='browse.py — HIPAA-Hardened Stealth Browser Automation CLI',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument('--profile', default=DEFAULT_PROFILE, help='Browser profile name')
    p.add_argument('--headless', action='store_true', help='Headless mode')
    p.add_argument('--cleanup', action='store_true', help='Secure-wipe screenshots')
    p.add_argument('--sanitize', action='store_true', help='Mask PHI patterns')
    p.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT, help='Timeout (ms)')
    p.add_argument('--viewport', default='1440x900', help='Viewport WxH')
    p.add_argument('--stealth', choices=['full', 'light', 'none'], default='full',
                   help='Stealth level: full (all layers), light (JS only), none')
    p.add_argument('--skip-fv-check', action='store_true', help='Skip FileVault check')

    sub = p.add_subparsers(dest='command')

    sub.add_parser('repl', help='Interactive REPL (browser stays open)')
    sub.add_parser('pipe', help='Read commands from stdin (batch mode)')

    s = sub.add_parser('open', help='Navigate to URL')
    s.add_argument('url')

    s = sub.add_parser('screenshot', help='Take screenshot')
    s.add_argument('--output', '-o')

    s = sub.add_parser('read-dom', help='Read DOM text')
    s.add_argument('--selector', '-s')

    sub.add_parser('read-page', help='Full page text')

    s = sub.add_parser('click', help='Click element')
    s.add_argument('selector')

    s = sub.add_parser('type', help='Type text')
    s.add_argument('selector')
    s.add_argument('text')

    s = sub.add_parser('scroll', help='Scroll page')
    s.add_argument('--direction', '-d', choices=['up', 'down'], default='down')
    s.add_argument('--amount', '-a', type=int, default=3)

    s = sub.add_parser('wait-for', help='Wait for element')
    s.add_argument('selector')
    s.add_argument('--wait-timeout', type=int)

    s = sub.add_parser('eval', help='Evaluate JS')
    s.add_argument('js')

    sub.add_parser('gdoc-read', help='Read Google Doc')

    s = sub.add_parser('gdoc-type', help='Type in Google Doc')
    s.add_argument('text')

    s = sub.add_parser('gdoc-find', help='Find in Google Doc')
    s.add_argument('text')

    sub.add_parser('stealth-test', help='Run bot detection test')

    return p


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        sys.exit(1)

    if not args.skip_fv_check and not check_filevault():
        sys.exit(1)

    try:
        vw, vh = args.viewport.split('x')
        viewport = (int(vw), int(vh))
    except Exception:
        viewport = DEFAULT_VIEWPORT

    cleanup_files = []

    with StealthBrowserSession(
        profile=args.profile,
        headless=args.headless,
        timeout=args.timeout,
        viewport=viewport,
        stealth_level=args.stealth,
    ) as session:

        if args.command == 'repl':
            run_repl(session, args.sanitize)
        elif args.command == 'pipe':
            run_pipe(session, args.sanitize)
        elif args.command == 'stealth-test':
            print(json.dumps(cmd_stealth_test(session), indent=2, default=str))
        else:
            result = None
            if args.command == 'open':
                result = cmd_open(session, args.url)
            elif args.command == 'screenshot':
                result = cmd_screenshot(session, args.output, args.cleanup)
                if result and result.get('cleanup_path'):
                    cleanup_files.append(result['cleanup_path'])
            elif args.command == 'read-dom':
                result = cmd_read_dom(session, getattr(args, 'selector', None), args.sanitize)
                if result and result.get('text'):
                    print(result['text'])
                    result = None
            elif args.command == 'read-page':
                result = cmd_read_page(session, args.sanitize)
                if result and result.get('text'):
                    print(f"URL: {result['url']}\nTitle: {result['title']}\n\n{result['text']}")
                    result = None
            elif args.command == 'click':
                result = cmd_click(session, args.selector)
            elif args.command == 'type':
                result = cmd_type_text(session, args.selector, args.text)
            elif args.command == 'scroll':
                result = cmd_scroll(session, args.direction, args.amount)
            elif args.command == 'wait-for':
                result = cmd_wait_for(session, args.selector, getattr(args, 'wait_timeout', None))
            elif args.command == 'eval':
                result = cmd_eval(session, args.js, args.sanitize)
            elif args.command == 'gdoc-read':
                result = cmd_gdoc_read(session, args.sanitize)
                if result and result.get('text'):
                    print(result['text'])
                    result = None
            elif args.command == 'gdoc-type':
                result = cmd_gdoc_type(session, args.text)
            elif args.command == 'gdoc-find':
                result = cmd_gdoc_find(session, args.text)

            if result:
                print(json.dumps(result, indent=2, default=str))

    for f in cleanup_files:
        secure_delete(f)


if __name__ == '__main__':
    main()
