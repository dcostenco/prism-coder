#!/usr/bin/env python3
"""
browse.py — Local Playwright browser runner for agent-driven testing
====================================================================
Structured CLI over Python Playwright for repeatable local acceptance checks,
debugging, and DOM/visual verification. Runs entirely on localhost.

FINGERPRINT / COMPATIBILITY PATCHES:
  Layer 1: playwright-stealth 2.x evasions (webdriver, plugins, permissions,
           navigator.userAgentData, Sec-CH-UA, WebGL vendor/renderer)
  Layer 2: CDP Emulation.setUserAgentOverride with full userAgentMetadata —
           the only reliable way to keep the UA string, navigator.userAgentData,
           and the Sec-CH-UA request headers mutually consistent
  Layer 3: Supplementary JS init script (chrome.runtime/csi/loadTimes, WebGL,
           navigator.connection, outer window metrics)
  Layer 4: Chromium launch args (automation flags, rendering determinism)
  Layer 5: Persistent profiles — cookie jars survive restarts

  These are best-effort test aids. They are NOT a guarantee against bot
  detection and NOT authorization to bypass access controls, CAPTCHAs, or a
  site's terms. Layer application is verified at startup and reported; a
  requested layer that cannot be applied fails loudly instead of degrading
  silently.

SECURITY:
  - FileVault (FDE) check, fail-closed (override with --skip-fv-check)
  - Isolated persistent browser profiles (~/.browser_data/<profile>/)
  - Audit logging (actions + redacted targets, never page content)
  - --local-only network isolation: HTTP route blocking, service workers
    blocked, and WebSocket/EventSource/WebRTC/sendBeacon hardening
  - --cleanup for ephemeral screenshots, --sanitize to mask PHI patterns

DEBUGGING:
  Console errors, uncaught page exceptions, failed requests, and blocked
  socket attempts are captured and attached to command output. An uncaught
  page exception fails a pipe run.

MODES:
  Single command:  browse.py open http://127.0.0.1:3000
  Interactive:     browse.py repl
  Pipe/batch:      printf 'open ...\\nassert-text #app Ready\\n' | browse.py pipe
"""

import argparse
import datetime
import hashlib
import json
import os
import random
import re
import select
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BROWSER_DATA_DIR = Path.home() / ".browser_data"
AUDIT_LOG_PATH = BROWSER_DATA_DIR / "audit.log"
DEFAULT_PROFILE = "default"
DEFAULT_TIMEOUT = 30000
DEFAULT_VIEWPORT = (1440, 900)
REPL_IDLE_TIMEOUT = 600  # 10 minutes — auto-close to prevent zombie Chromium
PIPE_IDLE_TIMEOUT = 600  # stdin held open with no commands — same protection
MAX_INIT_SCRIPT_BYTES = 256 * 1024
PROFILE_NAME_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
MIN_SCREENSHOT_BYTES = 1024
AUDIT_LOG_MAX_BYTES = 8 * 1024 * 1024
AUDIT_LOG_KEEP = 3
DIAGNOSTIC_LIMIT = 50
STEALTH_AVAILABLE = False

try:
    from playwright_stealth import Stealth
    STEALTH_AVAILABLE = True
except ImportError:
    pass

# PHI sanitization patterns.
# Deliberately broad: in this codebase a false positive (a redacted order ID)
# is preferable to a leaked identifier. Numeric assertions must therefore not
# rely on --sanitize output.
PHI_PATTERNS = [
    (re.compile(r'\b\d{3}-\d{2}-\d{4}\b'), '[SSN-REDACTED]'),
    (re.compile(r'\b\d{9}\b'), '[SSN-REDACTED]'),
    (re.compile(r'\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b'), '[PHONE-REDACTED]'),
    (re.compile(r'\bMRN[-:#]?\s*\d{4,12}\b', re.IGNORECASE), '[MRN-REDACTED]'),
    (re.compile(r'\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b'), '[EMAIL-REDACTED]'),
]


class StealthConfigurationError(RuntimeError):
    """A requested fingerprint layer could not be applied."""


class AssertionFailure(Exception):
    """An assert-* command evaluated to false. Distinct from an error."""


def validate_profile_name(profile: str) -> str:
    """Keep persistent profiles inside BROWSER_DATA_DIR."""
    if not PROFILE_NAME_PATTERN.fullmatch(profile):
        raise ValueError(
            "Profile names must be 1-64 characters using letters, numbers, '.', '_' or '-'."
        )
    return profile


def stable_profile_index(profile: str, count: int) -> int:
    """Return a cross-process stable choice for profile-scoped settings."""
    if count <= 0:
        raise ValueError("count must be positive")
    digest = hashlib.sha256(profile.encode('utf-8')).digest()
    return int.from_bytes(digest[:8], 'big') % count


def is_local_test_url(url: str, allow_internal=False) -> bool:
    """Allow only loopback HTTP(S) and self-contained browser URLs."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False

    if parsed.scheme in ('data', 'about'):
        return True
    if allow_internal and parsed.scheme == 'blob':
        return is_local_test_url(parsed.path, allow_internal=False)
    if parsed.scheme in ('ws', 'wss'):
        hostname = (parsed.hostname or '').lower().rstrip('.')
        return hostname in ('localhost', '127.0.0.1', '::1') or hostname.endswith('.localhost')
    if parsed.scheme not in ('http', 'https'):
        return False

    hostname = (parsed.hostname or '').lower().rstrip('.')
    return (
        hostname in ('localhost', '127.0.0.1', '::1')
        or hostname.endswith('.localhost')
    )


def redact_audit_target(target: str) -> str:
    """Remove credentials, query strings, fragments and data payloads from audit targets."""
    if not target:
        return ""
    compact = str(target).replace('\n', ' ').replace('\r', ' ')
    try:
        parsed = urlsplit(compact)
    except ValueError:
        return sanitize_phi(compact)[:300]

    if parsed.scheme == 'data':
        return 'data:[redacted]'
    if parsed.scheme in ('http', 'https', 'ws', 'wss'):
        hostname = parsed.hostname or ''
        if ':' in hostname and not hostname.startswith('['):
            hostname = f'[{hostname}]'
        netloc = hostname
        try:
            port = parsed.port
        except ValueError:
            port = None
        if port:
            netloc = f'{netloc}:{port}'
        # The path can carry record identifiers (/patients/123456789/notes),
        # so it is sanitized rather than trusted.
        safe_path = sanitize_phi(parsed.path or '/')
        return urlunsplit((parsed.scheme, netloc, safe_path, '', ''))[:300]
    return sanitize_phi(compact)[:300]


def _sanitize_audit_text(value: str) -> str:
    """Sanitize arbitrary audit details, including embedded URLs."""
    compact = str(value).replace('\n', ' ').replace('\r', ' ')
    url_pattern = re.compile(r'(?i)(?:https?|wss?|data):[^\s|]+')
    compact = url_pattern.sub(lambda match: redact_audit_target(match.group(0)), compact)
    return sanitize_phi(compact)[:300]


def load_local_init_script(script_path: str) -> tuple[str, str]:
    """Load and guard a custom pre-navigation script for local test pages only."""
    candidate = Path(script_path).expanduser()
    if candidate.is_symlink():
        raise ValueError(f"Init script must not be a symlink: {script_path}")
    try:
        stat = candidate.stat()
    except OSError as exc:
        raise ValueError(f"Cannot read init script: {script_path}") from exc
    if not candidate.is_file() or candidate.suffix.lower() not in ('.js', '.mjs'):
        raise ValueError("Init scripts must be regular .js or .mjs files.")
    if stat.st_size > MAX_INIT_SCRIPT_BYTES:
        raise ValueError(f"Init scripts must be at most {MAX_INIT_SCRIPT_BYTES} bytes.")
    try:
        source = candidate.read_text(encoding='utf-8')
    except UnicodeDecodeError as exc:
        raise ValueError("Init scripts must be UTF-8 text.") from exc
    if re.search(r'^\s*(?:import|export)\s', source, re.MULTILINE):
        raise ValueError(
            "Init scripts run as classic scripts before page code; ES module "
            "'import'/'export' syntax cannot work. Inline the dependency instead."
        )

    digest = hashlib.sha256(source.encode('utf-8')).hexdigest()[:12]
    guarded = f"""
(() => {{
  const host = location.hostname.toLowerCase().replace(/\\.$/, '');
  const allowed = location.protocol === 'data:' || location.protocol === 'about:' ||
    host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  if (!allowed) return;
  {source}
}})();
"""
    return guarded, digest


# ---------------------------------------------------------------------------
# Fingerprint configuration
# ---------------------------------------------------------------------------
STEALTH_USER_AGENTS = [
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4_1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.117 Safari/537.36",
]

WEBGL_VENDOR = "Google Inc. (Apple)"
WEBGL_RENDERER = "ANGLE (Apple, ANGLE Metal Renderer: Apple M3 Max, Unspecified Version)"

# Chromium args that reduce the automation fingerprint.
# Site isolation, phishing detection, and popup blocking are deliberately NOT
# disabled: these profiles hold live authenticated cookies, and trading away
# Spectre/UXSS mitigations for a fingerprint delta is the wrong exchange.
# Each --disable-features / --enable-features switch appears exactly once
# because Chromium honors only the last occurrence.
STEALTH_CHROMIUM_ARGS = [
    '--disable-blink-features=AutomationControlled',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-infobars',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-component-update',
    '--disable-dev-shm-usage',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--disable-sync',
    '--metrics-recording-only',
    '--no-service-autorun',
    '--password-store=basic',
    '--use-mock-keychain',
    '--force-color-profile=srgb',
    '--disable-domain-reliability',
    '--force-webrtc-ip-handling-policy=default_public_interface_only',
    '--lang=en-US',
    '--disable-features=OptimizationHints,MediaRouter',
    '--enable-features=NetworkService,NetworkServiceInProcess',
]

# Supplementary JS patches. Anything that playwright-stealth already covers
# (webdriver, plugins, permissions, userAgentData, Sec-CH-UA, WebGL) is left to
# it so there is a single owner per surface.
#
# NOTE: no Object.getOwnPropertyDescriptor override. The previous iframe
# evasion replaced that global on every page, which broke legitimate
# descriptor reads on both HTMLIFrameElement.prototype and ordinary objects
# carrying a `contentWindow` key, was readable via .toString(), and was
# bypassed in one line by Object.getOwnPropertyDescriptors. It corrupted the
# application under test for no detection benefit.
DEEP_STEALTH_INIT_SCRIPT = """
(() => {
  const nativeToString = Function.prototype.toString;
  const patched = new WeakMap();
  const cloak = (fn, label) => {
    try { patched.set(fn, `function ${label}() { [native code] }`); } catch (e) {}
    return fn;
  };

  if (!window.chrome) { window.chrome = {}; }
  if (!window.chrome.runtime) {
    window.chrome.runtime = {
      connect: cloak(function connect() {
        return { onMessage: { addListener() {} }, postMessage() {} };
      }, 'connect'),
      sendMessage: cloak(function sendMessage() {}, 'sendMessage'),
      id: undefined,
      onMessage: { addListener() {}, removeListener() {} },
      onConnect: { addListener() {}, removeListener() {} },
    };
  }

  if (!window.chrome.csi) {
    window.chrome.csi = cloak(function csi() {
      return { startE: Date.now(), onloadT: Date.now(), pageT: Math.random() * 1000 + 200, tran: 15 };
    }, 'csi');
  }

  if (!window.chrome.loadTimes) {
    window.chrome.loadTimes = cloak(function loadTimes() {
      const now = Date.now() / 1000;
      return {
        commitLoadTime: now,
        connectionInfo: 'h2',
        finishDocumentLoadTime: now + Math.random(),
        finishLoadTime: now + Math.random(),
        firstPaintAfterLoadTime: 0,
        firstPaintTime: now + Math.random() * 0.5,
        navigationType: 'Other',
        npnNegotiatedProtocol: 'h2',
        requestTime: now - Math.random(),
        startLoadTime: now - Math.random(),
        wasAlternateProtocolAvailable: false,
        wasFetchedViaSpdy: true,
        wasNpnNegotiated: true,
      };
    }, 'loadTimes');
  }

  const patchWebGL = (ctor) => {
    if (typeof ctor === 'undefined') return;
    const original = ctor.prototype.getParameter;
    const replacement = function getParameter(parameter) {
      if (parameter === 37445) return '__WEBGL_VENDOR__';
      if (parameter === 37446) return '__WEBGL_RENDERER__';
      return original.call(this, parameter);
    };
    cloak(replacement, 'getParameter');
    ctor.prototype.getParameter = replacement;
  };
  patchWebGL(typeof WebGLRenderingContext !== 'undefined' ? WebGLRenderingContext : undefined);
  patchWebGL(typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : undefined);

  if (!navigator.connection) {
    Object.defineProperty(navigator, 'connection', {
      get: () => ({ downlink: 10, effectiveType: '4g', rtt: 50, saveData: false, onchange: null }),
      configurable: true,
    });
  }

  if (window.outerHeight === 0) {
    Object.defineProperty(window, 'outerHeight', { get: () => window.innerHeight + 85 });
  }
  if (window.outerWidth === 0) {
    Object.defineProperty(window, 'outerWidth', { get: () => window.innerWidth });
  }

  // Cloak only the functions this script actually replaced. A blanket
  // Function.prototype.toString proxy that special-cases one method leaves
  // every other patch readable, which is worse than not cloaking at all.
  const toStringProxy = new Proxy(nativeToString, {
    apply(target, ctx, args) {
      const spoofed = patched.get(ctx);
      if (spoofed) return spoofed;
      return Reflect.apply(target, ctx, args);
    },
  });
  try {
    Function.prototype.toString = toStringProxy;
    patched.set(toStringProxy, 'function toString() { [native code] }');
  } catch (e) {}
})();
"""

# Blocks the egress channels that Playwright's request routing cannot see.
# Defense in depth for --local-only, not a kernel-level guarantee.
LOCAL_ONLY_SOCKET_GUARD = """
(() => {
  const allowed = (raw) => {
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === 'data:' || url.protocol === 'about:' || url.protocol === 'blob:') return true;
      const host = url.hostname.toLowerCase().replace(/\\.$/, '');
      return host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
        host === '[::1]' || host.endsWith('.localhost');
    } catch (e) {
      return false;
    }
  };
  const refuse = (channel, target) => {
    try { console.error(`[prism-local-only] blocked ${channel} to ${target}`); } catch (e) {}
    throw new DOMException(`Blocked by --local-only: ${channel} to ${target}`, 'SecurityError');
  };

  const NativeWebSocket = window.WebSocket;
  if (NativeWebSocket) {
    const GuardedWebSocket = function WebSocket(url, protocols) {
      if (!allowed(url)) refuse('WebSocket', String(url));
      return protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
    };
    GuardedWebSocket.prototype = NativeWebSocket.prototype;
    for (const key of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) {
      try { GuardedWebSocket[key] = NativeWebSocket[key]; } catch (e) {}
    }
    try { window.WebSocket = GuardedWebSocket; } catch (e) {}
  }

  const NativeEventSource = window.EventSource;
  if (NativeEventSource) {
    const GuardedEventSource = function EventSource(url, config) {
      if (!allowed(url)) refuse('EventSource', String(url));
      return new NativeEventSource(url, config);
    };
    GuardedEventSource.prototype = NativeEventSource.prototype;
    try { window.EventSource = GuardedEventSource; } catch (e) {}
  }

  if (navigator.sendBeacon) {
    const nativeBeacon = navigator.sendBeacon.bind(navigator);
    try {
      Object.defineProperty(navigator, 'sendBeacon', {
        configurable: true,
        value: function sendBeacon(url, data) {
          if (!allowed(url)) {
            try { console.error(`[prism-local-only] blocked sendBeacon to ${url}`); } catch (e) {}
            return false;
          }
          return nativeBeacon(url, data);
        },
      });
    } catch (e) {}
  }

  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection']) {
    if (window[name]) {
      try {
        window[name] = function RTCPeerConnection() {
          refuse('RTCPeerConnection', 'any peer');
        };
      } catch (e) {}
    }
  }
})();
"""


# ---------------------------------------------------------------------------
# User-agent metadata
# ---------------------------------------------------------------------------
def chrome_version_parts(user_agent: str) -> tuple[str, str]:
    """Return (major, full) Chrome version parsed from a UA string."""
    match = re.search(r'Chrome/(\d+)(?:\.(\d+\.\d+\.\d+))?', user_agent)
    if not match:
        raise StealthConfigurationError(f"Cannot parse a Chrome version from UA: {user_agent}")
    major = match.group(1)
    full = f"{major}.{match.group(2)}" if match.group(2) else f"{major}.0.0.0"
    return major, full


def build_sec_ch_ua(major: str) -> str:
    """Client-hint brand list matching the advertised Chrome major version."""
    return f'"Chromium";v="{major}", "Google Chrome";v="{major}", "Not_A_Brand";v="24"'


def mac_platform_version(user_agent: str) -> str:
    """Derive a macOS platformVersion from a UA string."""
    match = re.search(r'Mac OS X (\d+)[._](\d+)(?:[._](\d+))?', user_agent)
    if not match:
        return "14.5.0"
    major, minor, patch = match.group(1), match.group(2), match.group(3) or '0'
    # Chromium reports Big Sur and later as 11+; the legacy 10_15_7 UA maps to 10.15.7.
    return f"{major}.{minor}.{patch}"


def build_user_agent_metadata(user_agent: str) -> dict:
    """Full userAgentMetadata for CDP Emulation.setUserAgentOverride."""
    major, full = chrome_version_parts(user_agent)
    brands = [
        {"brand": "Not_A_Brand", "version": "24"},
        {"brand": "Chromium", "version": major},
        {"brand": "Google Chrome", "version": major},
    ]
    full_versions = [
        {"brand": "Not_A_Brand", "version": "24.0.0.0"},
        {"brand": "Chromium", "version": full},
        {"brand": "Google Chrome", "version": full},
    ]
    return {
        "brands": brands,
        "fullVersionList": full_versions,
        "fullVersion": full,
        "platform": "macOS",
        "platformVersion": mac_platform_version(user_agent),
        "architecture": "arm",
        "model": "",
        "mobile": False,
        "bitness": "64",
        "wow64": False,
    }


# ---------------------------------------------------------------------------
# Security checks
# ---------------------------------------------------------------------------
def check_filevault() -> bool:
    """Verify FileVault (Full Disk Encryption) is enabled. Fails closed."""
    if sys.platform != 'darwin':
        print(
            "⛔ Cannot verify full-disk encryption on this platform. "
            "Pass --skip-fv-check to proceed deliberately.",
            file=sys.stderr,
        )
        return False
    try:
        result = subprocess.run(['fdesetup', 'status'], capture_output=True, text=True, timeout=5)
    except Exception as exc:
        print(
            f"⛔ Cannot verify disk encryption ({type(exc).__name__}). "
            "Pass --skip-fv-check to proceed deliberately.",
            file=sys.stderr,
        )
        return False
    if 'FileVault is On' in result.stdout:
        return True
    print("⛔ FileVault is OFF. Pass --skip-fv-check to proceed deliberately.", file=sys.stderr)
    return False


def sanitize_phi(text: str) -> str:
    """Mask PHI patterns in text output."""
    for pattern, replacement in PHI_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def secure_delete(filepath: str) -> dict:
    """
    Best-effort wipe. On APFS, copy-on-write means an in-place overwrite does
    not necessarily clear the original physical blocks, so this reports what it
    actually guarantees rather than claiming secure erasure.
    """
    path = Path(filepath)
    if not path.exists():
        return {"path": str(path), "removed": False, "reason": "missing"}
    overwritten = False
    try:
        size = path.stat().st_size
        with open(path, 'wb') as handle:
            handle.write(os.urandom(size))
            handle.flush()
            os.fsync(handle.fileno())
        overwritten = True
    except Exception as exc:
        print(f"⚠️  Overwrite before delete failed: {exc}", file=sys.stderr)
    try:
        path.unlink()
        removed = True
    except Exception as exc:
        print(f"⚠️  Delete failed: {exc}", file=sys.stderr)
        removed = False
    return {
        "path": str(path),
        "removed": removed,
        "overwritten": overwritten,
        "guarantee": "unlinked; APFS copy-on-write may retain prior blocks",
    }


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------
def _rotate_audit_log() -> None:
    """Keep the audit log bounded so it stays reviewable."""
    try:
        if not AUDIT_LOG_PATH.exists() or AUDIT_LOG_PATH.stat().st_size < AUDIT_LOG_MAX_BYTES:
            return
        for index in range(AUDIT_LOG_KEEP - 1, 0, -1):
            older = AUDIT_LOG_PATH.with_suffix(f'.log.{index}')
            newer = AUDIT_LOG_PATH.with_suffix(f'.log.{index + 1}')
            if older.exists():
                older.replace(newer)
        AUDIT_LOG_PATH.replace(AUDIT_LOG_PATH.with_suffix('.log.1'))
        AUDIT_LOG_PATH.touch(mode=0o600)
    except Exception:
        pass


def _ensure_audit_log_permissions() -> None:
    """Create audit log with strict permissions (chmod 600) so other processes can't read it."""
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        os.chmod(AUDIT_LOG_PATH.parent, 0o700)
    except Exception:
        pass
    if AUDIT_LOG_PATH.is_symlink():
        raise RuntimeError(f"Refusing symlinked audit log: {AUDIT_LOG_PATH}")
    if not AUDIT_LOG_PATH.exists():
        AUDIT_LOG_PATH.touch(mode=0o600)
    else:
        try:
            os.chmod(AUDIT_LOG_PATH, 0o600)
        except Exception:
            pass
    _rotate_audit_log()


def audit_log(action: str, target: str = "", details: str = "") -> None:
    """Write audit log entry. Records WHAT and WHERE, never page content."""
    _ensure_audit_log_permissions()
    ts = datetime.datetime.now().isoformat()
    safe_target = redact_audit_target(target)
    safe_details = _sanitize_audit_text(details) if details else ""
    try:
        with open(AUDIT_LOG_PATH, 'a', encoding='utf-8') as handle:
            handle.write(f"{ts} | {action} | {safe_target} | {safe_details}\n")
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Behavioral helpers
# ---------------------------------------------------------------------------
def human_delay(min_ms=50, max_ms=200, fast=False):
    """Random human-like delay between actions. Skipped in fast mode."""
    if fast:
        return
    time.sleep(random.uniform(min_ms / 1000, max_ms / 1000))


def human_type(page, text, selector=None, fast=False):
    """Type with variable delays, or fill instantly in fast mode."""
    if fast:
        if selector:
            page.fill(selector, text)
        else:
            page.keyboard.insert_text(text)
        return
    if selector:
        page.click(selector)
        human_delay(100, 300)
    for char in text:
        page.keyboard.type(char, delay=random.randint(30, 120))
        if random.random() < 0.05:
            human_delay(200, 500)


def human_scroll(page, direction="down", steps=3, fast=False):
    """Scroll with variable increments."""
    for _ in range(steps):
        delta = random.randint(150, 400) * (1 if direction == "down" else -1)
        page.mouse.wheel(0, delta)
        human_delay(100, 400, fast=fast)


# ---------------------------------------------------------------------------
# Diagnostics
# ---------------------------------------------------------------------------
class Diagnostics:
    """
    Collects the failure signals a headless run would otherwise discard:
    console errors, uncaught exceptions, failed requests, blocked sockets.
    """

    def __init__(self, limit: int = DIAGNOSTIC_LIMIT, sanitize: bool = False):
        self.limit = limit
        self.sanitize = sanitize
        self.console_errors: list[str] = []
        self.page_errors: list[str] = []
        self.failed_requests: list[str] = []
        self.blocked_requests: list[str] = []
        # drain() clears the per-command buckets, so page errors are also kept
        # cumulatively: an end-of-run assertion must still be able to show them.
        self.all_page_errors: list[str] = []
        self.saw_page_error = False
        self._attached: set[int] = set()

    def _clean(self, value: str) -> str:
        text = str(value).replace('\n', ' ')[:500]
        return sanitize_phi(text) if self.sanitize else text

    def _append(self, bucket: list[str], value: str) -> None:
        if len(bucket) < self.limit:
            bucket.append(self._clean(value))

    def attach(self, page) -> None:
        if id(page) in self._attached:
            return
        self._attached.add(id(page))

        def on_console(message):
            if message.type in ('error', 'warning'):
                self._append(self.console_errors, f"{message.type}: {message.text}")

        def on_page_error(error):
            self.saw_page_error = True
            self._append(self.page_errors, str(error))
            self._append(self.all_page_errors, str(error))
            audit_log("page_error", page.url, type(error).__name__)

        def on_request_failed(request):
            failure = request.failure or 'unknown'
            self._append(self.failed_requests, f"{request.method} {request.url} — {failure}")

        def on_websocket(socket):
            if not is_local_test_url(socket.url):
                self._append(self.blocked_requests, f"WEBSOCKET {socket.url}")
                audit_log("websocket_attempt", socket.url, "policy=local-only")

        page.on('console', on_console)
        page.on('pageerror', on_page_error)
        page.on('requestfailed', on_request_failed)
        page.on('websocket', on_websocket)

    def note_blocked(self, description: str) -> None:
        self._append(self.blocked_requests, description)

    def drain(self) -> dict:
        """Return signals accumulated since the last drain, then clear them."""
        payload = {}
        for key, bucket in (
            ('console_errors', self.console_errors),
            ('page_errors', self.page_errors),
            ('failed_requests', self.failed_requests),
            ('blocked_requests', self.blocked_requests),
        ):
            if bucket:
                payload[key] = list(bucket)
                bucket.clear()
        return payload


# ---------------------------------------------------------------------------
# Browser session
# ---------------------------------------------------------------------------
class StealthBrowserSession:
    """Manages a local Playwright browser session."""

    def __init__(self, profile=DEFAULT_PROFILE, headless=False,
                 timeout=DEFAULT_TIMEOUT, viewport=DEFAULT_VIEWPORT,
                 stealth_level="full", local_only=False,
                 init_script_paths=None, fast=False, sanitize=False,
                 allow_degraded_stealth=False, ephemeral_profile=False,
                 storage_state_path=None, trace_path=None, video_dir=None,
                 har_path=None, grant_permissions=None, geolocation=None,
                 allow_http_error=False):
        self.profile = validate_profile_name(profile)
        self.headless = headless
        self.timeout = timeout
        self.viewport = viewport
        self.stealth_level = stealth_level  # "full", "light", "none"
        self.local_only = local_only
        self.fast = fast
        self.sanitize = sanitize
        self.allow_degraded_stealth = allow_degraded_stealth
        self.ephemeral_profile = ephemeral_profile
        self.storage_state_path = storage_state_path
        self.trace_path = trace_path
        self.video_dir = video_dir
        self.har_path = har_path
        self.grant_permissions = list(grant_permissions or [])
        self.geolocation = geolocation
        self.allow_http_error = allow_http_error
        self.stealth_degraded: list[str] = []
        self.fingerprint: dict = {}
        self._fingerprint_reverified = False
        self.screenshot_counter = 0
        self.diagnostics = Diagnostics(sanitize=sanitize)
        self._temp_profile_dir = None
        self.profile_dir = BROWSER_DATA_DIR / self.profile
        self._playwright = None
        self._context = None
        self._page = None
        self._pages: list = []
        self._tracing_active = False

        script_paths = list(init_script_paths or [])
        if script_paths and not self.local_only:
            raise ValueError("Custom init scripts require --local-only.")
        self._init_scripts = [load_local_init_script(path) for path in script_paths]

        ua_idx = stable_profile_index(self.profile, len(STEALTH_USER_AGENTS))
        self._user_agent = STEALTH_USER_AGENTS[ua_idx]
        self._ua_major, self._ua_full = chrome_version_parts(self._user_agent)
        self._sec_ch_ua = build_sec_ch_ua(self._ua_major)
        self._ua_metadata = build_user_agent_metadata(self._user_agent)

    def __enter__(self):
        self.start()
        return self

    def __exit__(self, *args):
        self.stop()

    # -- lifecycle ---------------------------------------------------------
    def start(self):
        from playwright.sync_api import sync_playwright

        if self.ephemeral_profile:
            self._temp_profile_dir = tempfile.mkdtemp(prefix='prism-browser-ephemeral-')
            self.profile_dir = Path(self._temp_profile_dir)
        self.profile_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            os.chmod(self.profile_dir, 0o700)
        except Exception:
            pass

        self._playwright = sync_playwright().start()

        launch_args = list(STEALTH_CHROMIUM_ARGS) if self.stealth_level != "none" else [
            '--no-first-run', '--no-default-browser-check'
        ]

        launch_kwargs = dict(
            user_data_dir=str(self.profile_dir),
            headless=self.headless,
            viewport={'width': self.viewport[0], 'height': self.viewport[1]},
            user_agent=self._user_agent,
            locale='en-US',
            timezone_id='America/New_York',
            color_scheme='light',
            args=launch_args,
            ignore_default_args=['--enable-automation'],
            # Service-worker requests bypass context routing, which would
            # punch a hole straight through --local-only.
            service_workers='block' if self.local_only else 'allow',
        )
        if self.grant_permissions:
            launch_kwargs['permissions'] = self.grant_permissions
        if self.geolocation:
            launch_kwargs['geolocation'] = {
                'latitude': self.geolocation[0],
                'longitude': self.geolocation[1],
            }
        if self.video_dir:
            launch_kwargs['record_video_dir'] = str(self.video_dir)
        if self.har_path:
            launch_kwargs['record_har_path'] = str(self.har_path)

        self._context = self._playwright.chromium.launch_persistent_context(**launch_kwargs)
        self._context.set_default_timeout(self.timeout)

        if self.trace_path:
            self._context.tracing.start(screenshots=True, snapshots=True, sources=False)
            self._tracing_active = True

        if self.local_only:
            self._context.add_init_script(LOCAL_ONLY_SOCKET_GUARD)

        if self.stealth_level != "none":
            self._apply_stealth()
        self._install_request_policy()

        for source, digest in self._init_scripts:
            self._context.add_init_script(source)
            audit_log("init_script", f"sha256={digest}", "scope=local-only")

        if self._context.pages:
            self._page = self._context.pages[0]
        else:
            self._page = self._context.new_page()
        self._pages = [self._page]
        self._register_page(self._page)
        self._context.on('page', self._on_new_page)

        if self.storage_state_path:
            self._load_storage_state(self.storage_state_path)

        self._verify_init_scripts()
        # navigator.userAgentData is not exposed on about:blank, so the startup
        # probe can only check UA/platform/webdriver. The brand list is
        # re-checked on the first real navigation, where the answer is
        # meaningful, via reverify_fingerprint().
        self.fingerprint = self._verify_fingerprint(stage="startup")

        if self.stealth_degraded and not self.allow_degraded_stealth:
            if self.stealth_level == "full":
                detail = '; '.join(self.stealth_degraded)
                raise StealthConfigurationError(
                    f"--stealth full could not be applied: {detail}. "
                    "Fix the runtime, or run with --stealth light / "
                    "--allow-degraded-stealth to proceed deliberately."
                )
            for problem in self.stealth_degraded:
                print(f"⚠️  stealth degraded: {problem}", file=sys.stderr)

        audit_log(
            "session_start", f"profile={self.profile}",
            f"stealth={self.stealth_level},headless={self.headless},"
            f"local_only={self.local_only},degraded={len(self.stealth_degraded)}",
        )

    def _on_new_page(self, page):
        # Event callbacks run on the sync API's dispatcher: issuing a protocol
        # call here (a CDP session, a title() read) risks reentrancy. Record
        # only, and let _ensure_pages_registered() do the protocol work.
        self._pages.append(page)
        audit_log("page_opened", page.url, f"count={len(self._pages)}")

    def _pump_events(self):
        """
        Let playwright-python deliver queued events.

        The sync API dispatches events only while a protocol call is in flight,
        so a popup opened by the previous command stays invisible until the
        next round trip. time.sleep() does not pump anything.
        """
        try:
            self._context.cookies()
        except Exception:
            pass

    def _ensure_pages_registered(self):
        """Attach diagnostics and the UA override to any page we have not seen."""
        try:
            known = list(self._context.pages)
        except Exception:
            return
        for page in known:
            if page.is_closed():
                continue
            if page not in self._pages:
                self._pages.append(page)
            self._register_page(page)

    def _register_page(self, page):
        self.diagnostics.attach(page)
        if self.stealth_level != "none":
            self._apply_cdp_user_agent(page)

    def _apply_cdp_user_agent(self, page):
        """
        Keep the UA string, navigator.userAgentData, and the Sec-CH-UA request
        headers consistent. Playwright's route.continue_(headers=...) cannot do
        this: Chromium re-adds client hints after interception, so a header
        rewrite there leaves 'HeadlessChrome' on the wire.
        """
        try:
            cdp = self._context.new_cdp_session(page)
            cdp.send('Emulation.setUserAgentOverride', {
                'userAgent': self._user_agent,
                'acceptLanguage': 'en-US,en;q=0.9',
                # This sets navigator.platform, which on real macOS Chrome is
                # 'MacIntel'. The 'macOS' spelling belongs to
                # userAgentMetadata.platform (navigator.userAgentData.platform).
                'platform': 'MacIntel',
                'userAgentMetadata': self._ua_metadata,
            })
        except Exception as exc:
            problem = f"CDP user-agent override failed ({type(exc).__name__}: {exc})"
            if problem not in self.stealth_degraded:
                self.stealth_degraded.append(problem)
            audit_log("stealth", "cdp_ua_override", f"error={exc}")

    def _apply_stealth(self):
        """Apply fingerprint layers, recording any that could not be applied."""
        if self.stealth_level == "full":
            if not STEALTH_AVAILABLE:
                self.stealth_degraded.append(
                    "playwright-stealth is not installed (pip3 install playwright-stealth)"
                )
            else:
                try:
                    stealth = Stealth(
                        navigator_webdriver=True,
                        navigator_plugins=True,
                        navigator_permissions=True,
                        navigator_user_agent=True,
                        navigator_user_agent_data=True,
                        navigator_user_agent_override=self._user_agent,
                        navigator_languages_override=("en-US", "en"),
                        # The library default is 'Win32', which would contradict
                        # a macOS user agent on every page.
                        navigator_platform_override="MacIntel",
                        sec_ch_ua=True,
                        sec_ch_ua_override=self._sec_ch_ua,
                        webgl_vendor_override=WEBGL_VENDOR,
                        webgl_renderer_override=WEBGL_RENDERER,
                        init_scripts_only=True,  # required for persistent context
                    )
                    stealth.apply_stealth_sync(self._context)
                    audit_log("stealth", "playwright-stealth", "applied_v2")
                except Exception as exc:
                    self.stealth_degraded.append(
                        f"playwright-stealth could not be applied ({type(exc).__name__}: {exc})"
                    )
                    audit_log("stealth", "playwright-stealth", f"error={exc}")

        script = (
            DEEP_STEALTH_INIT_SCRIPT
            .replace('__WEBGL_VENDOR__', WEBGL_VENDOR)
            .replace('__WEBGL_RENDERER__', WEBGL_RENDERER)
        )
        try:
            self._context.add_init_script(script)
            audit_log("stealth", "deep_init_script", "injected")
        except Exception as exc:
            self.stealth_degraded.append(f"supplementary init script failed ({exc})")
            audit_log("stealth", "deep_init_script", f"error={exc}")

    def _install_request_policy(self):
        """
        Enforce --local-only on routable requests, and set only the headers a
        real Chrome would send. sec-ch-ua is handled by CDP, not here.
        """
        def handler(route, request):
            if self.local_only and not is_local_test_url(request.url, allow_internal=True):
                audit_log("request_blocked", request.url, "policy=local-only")
                self.diagnostics.note_blocked(f"{request.method} {request.url}")
                route.abort("blockedbyclient")
                return
            if self.stealth_level == "none":
                route.continue_()
                return
            headers = dict(request.headers)
            # Real Chrome sends Upgrade-Insecure-Requests only on navigation
            # requests, never on subresource fetches. Setting it everywhere is
            # itself a bot signal.
            try:
                is_navigation = request.is_navigation_request()
            except Exception:
                is_navigation = False
            if is_navigation:
                headers['upgrade-insecure-requests'] = '1'
            else:
                headers.pop('upgrade-insecure-requests', None)
            route.continue_(headers=headers)

        try:
            self._context.route("**/*", handler)
            audit_log("request_policy", "routing", f"local_only={self.local_only}")
        except Exception as exc:
            audit_log("request_policy", "routing", f"error={exc}")
            if self.local_only:
                raise RuntimeError("Cannot enforce --local-only network isolation.") from exc

    def _verify_init_scripts(self):
        """
        Prove the preload scripts parse. add_init_script failures are otherwise
        invisible: a syntax error produces no output at all.
        """
        if not self._init_scripts:
            return
        for source, digest in self._init_scripts:
            try:
                self._page.evaluate(f"() => {{ {source} }}")
            except Exception as exc:
                raise ValueError(
                    f"Init script sha256={digest} failed to evaluate: {exc}"
                ) from exc

    def reverify_fingerprint(self):
        """
        Re-check the fingerprint on a real page. Raises for --stealth full when
        a leak appears that about:blank could not reveal.
        """
        if self._fingerprint_reverified or self.stealth_level == "none":
            return
        self._fingerprint_reverified = True
        before = len(self.stealth_degraded)
        self.fingerprint = self._verify_fingerprint(stage="navigated")
        new_problems = self.stealth_degraded[before:]
        if not new_problems or self.allow_degraded_stealth:
            return
        detail = '; '.join(new_problems)
        if self.stealth_level == "full":
            raise StealthConfigurationError(
                f"--stealth full is leaking on a real page: {detail}. "
                "Fix the runtime, or run with --allow-degraded-stealth to proceed deliberately."
            )
        for problem in new_problems:
            print(f"⚠️  stealth degraded: {problem}", file=sys.stderr)

    def _verify_fingerprint(self, stage="startup") -> dict:
        """
        Actually compare the advertised identity against what the page sees.
        The previous implementation only wrote 'consistent=true' to the audit
        log without checking anything.
        """
        if self.stealth_level == "none":
            return {"checked": False, "reason": "stealth=none"}
        probe = """() => ({
            ua: navigator.userAgent,
            platform: navigator.platform,
            webdriver: navigator.webdriver === undefined ? 'undefined' : String(navigator.webdriver),
            brands: navigator.userAgentData
                ? navigator.userAgentData.brands.map(b => b.brand + '/' + b.version).join(',')
                : 'absent',
            uaDataPlatform: navigator.userAgentData ? navigator.userAgentData.platform : 'absent',
        })"""
        try:
            observed = self._page.evaluate(probe)
        except Exception as exc:
            self.stealth_degraded.append(f"fingerprint probe failed ({exc})")
            return {"checked": False, "reason": str(exc)}

        report = {
            "checked": True,
            "stage": stage,
            "expected_chrome_major": self._ua_major,
            "user_agent_major": (re.search(r'Chrome/(\d+)', observed.get('ua', '')) or [None, None])[1]
            if re.search(r'Chrome/(\d+)', observed.get('ua', '')) else None,
            "brands": observed.get('brands'),
            "platform": observed.get('platform'),
            "ua_data_platform": observed.get('uaDataPlatform'),
            "webdriver": observed.get('webdriver'),
        }

        brands = observed.get('brands') or ''
        if 'Headless' in brands or 'Headless' in observed.get('ua', ''):
            self.stealth_degraded.append(
                f"headless identity is still advertised (brands={brands or 'n/a'})"
            )
        elif brands != 'absent':
            versions = re.findall(r'/(\d+)', brands)
            if versions and self._ua_major not in versions:
                self.stealth_degraded.append(
                    f"userAgentData brands {brands} disagree with UA major {self._ua_major}"
                )
        if report["user_agent_major"] and report["user_agent_major"] != self._ua_major:
            self.stealth_degraded.append(
                f"navigator.userAgent major {report['user_agent_major']} != configured {self._ua_major}"
            )
        if observed.get('platform') not in ('MacIntel', None):
            self.stealth_degraded.append(
                f"navigator.platform is {observed.get('platform')}, expected MacIntel for a macOS UA"
            )
        if observed.get('webdriver') not in ('undefined', 'false'):
            self.stealth_degraded.append(f"navigator.webdriver is {observed.get('webdriver')}")

        if brands == 'absent':
            report["note"] = (
                "navigator.userAgentData is not exposed here; the brand list is "
                "re-checked after the first navigation"
            )
        report["consistent"] = not self.stealth_degraded
        audit_log(
            "fingerprint_check", "ua_webgl",
            f"stage={stage},consistent={report['consistent']},"
            f"brands={brands},platform={observed.get('platform')}",
        )
        return report

    def _load_storage_state(self, path):
        """
        Seed cookies and origin storage so authenticated runs can be hermetic.
        launch_persistent_context does not accept storage_state directly.
        """
        state = json.loads(Path(path).read_text(encoding='utf-8'))
        cookies = state.get('cookies') or []
        if cookies:
            self._context.add_cookies(cookies)
        origins = state.get('origins') or []
        if origins:
            self._context.add_init_script(
                "(() => { const seed = " + json.dumps(origins) + ";"
                " const match = seed.find(o => o.origin === location.origin);"
                " if (!match) return;"
                " for (const item of (match.localStorage || [])) {"
                "   try { localStorage.setItem(item.name, item.value); } catch (e) {}"
                " }"
                "})();"
            )
        audit_log("storage_state_loaded", str(path),
                  f"cookies={len(cookies)},origins={len(origins)}")

    def stop(self):
        if self._tracing_active and self._context:
            try:
                self._context.tracing.stop(path=str(self.trace_path))
            except Exception as exc:
                print(f"⚠️  Trace write failed: {exc}", file=sys.stderr)
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
        if self._temp_profile_dir:
            shutil.rmtree(self._temp_profile_dir, ignore_errors=True)
        audit_log("session_stop", f"profile={self.profile}")

    # -- accessors ---------------------------------------------------------
    @property
    def page(self):
        return self._page

    @property
    def context(self):
        return self._context

    @property
    def pages(self):
        # Playwright's own context.pages is the source of truth; our list only
        # preserves discovery order.
        self._pump_events()
        self._ensure_pages_registered()
        return [p for p in self._pages if not p.is_closed()]

    def switch_page(self, index: int):
        live = self.pages
        if index < 0 or index >= len(live):
            raise ValueError(f"No page at index {index} (open pages: {len(live)}).")
        self._page = live[index]
        return self._page


# ---------------------------------------------------------------------------
# Result helpers
# ---------------------------------------------------------------------------
def with_diagnostics(session, result: dict) -> dict:
    """Attach captured failure signals to a command result."""
    if not isinstance(result, dict):
        return result
    signals = session.diagnostics.drain()
    if signals:
        result = {**result, "diagnostics": signals}
    return result


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------
def cmd_open(session, url):
    """Navigate to URL. Fails on HTTP >= 400 unless allow_http_error is set."""
    if not url:
        raise ValueError("Usage: open <url>")
    if session.local_only and not is_local_test_url(url):
        raise ValueError("--local-only permits only loopback HTTP(S), data:, and about: URLs.")

    response = session.page.goto(url, wait_until='domcontentloaded')
    try:
        session.page.wait_for_load_state('networkidle', timeout=15000)
    except Exception as exc:
        # A continuously-polling page can be usable without reaching networkidle.
        if type(exc).__name__ != 'TimeoutError':
            raise
    title = session.page.title()
    current_url = session.page.url
    status = response.status if response is not None else None
    audit_log("open", url, f"status={status},title_chars={len(title)}")
    session.reverify_fingerprint()

    result = {"status": "ok", "url": current_url, "title": title, "http_status": status}
    if status is not None and status >= 400 and not session.allow_http_error:
        result["status"] = "failed"
        result["message"] = (
            f"HTTP {status} for {current_url}. Pass --allow-http-error to treat this as success."
        )
    return result


def _enforce_max_edge(path, max_edge):
    """Downscale an image in place so its longest edge is <= max_edge.

    Returns a warning string when the image remains oversized (no scaler
    available), else None. Never raises: a failed downscale must not turn a
    real capture into a failure — but it must not stay silent either.
    """
    try:
        import shutil as _shutil, subprocess as _subprocess
        if _shutil.which("sips"):
            _subprocess.run(["sips", "-Z", str(max_edge), str(path)],
                            capture_output=True, timeout=30, check=True)
            return None
        try:
            from PIL import Image  # type: ignore
            with Image.open(path) as im:
                w, h = im.size
                if max(w, h) <= max_edge:
                    return None
                scale = max_edge / max(w, h)
                im.resize((int(w * scale), int(h * scale))).save(path)
            return None
        except ImportError:
            pass
        return (f"image may exceed {max_edge}px and no scaler is available "
                f"(sips/Pillow) — large images poison Claude image attach "
                f"after ~20 images per conversation")
    except Exception as error:  # noqa: BLE001 — never fail a capture on scaling
        return f"downscale failed ({error}); image may exceed {max_edge}px"


def cmd_screenshot(session, output=None, cleanup=False, full_page=True, selector=None):
    """Capture a screenshot and validate that it is not an empty frame."""
    session.screenshot_counter += 1
    if not output:
        ts = datetime.datetime.now().strftime('%Y%m%d_%H%M%S_%f')
        name = f"screenshot_{ts}_{session.screenshot_counter:03d}.png"
        if cleanup:
            # APFS copy-on-write: prefer a temp location for ephemeral captures.
            output = os.path.join(tempfile.gettempdir(), f"browse_ss_{ts}.png")
        else:
            output = name
    path = Path(output).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)

    if selector:
        element = session.page.wait_for_selector(selector, state='visible')
        element.screenshot(path=str(path))
    else:
        session.page.screenshot(path=str(path), full_page=full_page)

    # ── Anthropic many-image rule (learned live, 2026-08-13) ─────────────
    # Past ~20 images in a conversation, the API caps every image at 2000px
    # per dimension and re-validates the WHOLE history on each request. One
    # oversized capture early in a session poisons every later attach — the
    # agent that must LOOK at screenshots loses the ability to see them,
    # mid-conversation, permanently. Full-page captures routinely exceed
    # 2000px in height, so every capture is normalized to a 1900px long edge
    # here, at the source. sips is macOS-only; elsewhere we fall back to
    # Pillow if present and otherwise WARN LOUDLY rather than emit poison
    # silently.
    _downscale_warning = _enforce_max_edge(path, 1900)

    size = path.stat().st_size
    audit_log("screenshot", str(path), f"size={size},ephemeral={cleanup}")
    result = {
        "status": "ok",
        "path": str(path),
        "size_bytes": size,
        "full_page": bool(full_page and not selector),
    }

    # A blank or error frame must not report success: a screenshot is evidence
    # only if something actually rendered.
    warnings = []
    if _downscale_warning:
        warnings.append(_downscale_warning)
    if size < MIN_SCREENSHOT_BYTES:
        result["status"] = "failed"
        warnings.append(f"image is {size} bytes, below the {MIN_SCREENSHOT_BYTES}-byte floor")
    try:
        content = session.page.evaluate(
            """() => {
                const body = document.body;
                const text = body ? body.innerText.trim().length : 0;
                const visuals = document.querySelectorAll('img,svg,canvas,video,input,button').length;
                return { text, visuals, url: location.href };
            }"""
        )
        if content['text'] == 0 and content['visuals'] == 0:
            result["status"] = "failed"
            warnings.append(f"page has no text or visual elements ({content['url']})")
    except Exception as exc:
        warnings.append(f"content probe failed: {exc}")
    if warnings:
        result["warnings"] = warnings
        result["message"] = "; ".join(warnings)
    if cleanup:
        result["cleanup_path"] = str(path)
        result["ephemeral"] = True
    return result


def cmd_read_dom(session, selector=None, sanitize=False):
    """Read DOM text content."""
    if selector:
        element = session.page.wait_for_selector(selector, timeout=10000)
        text = element.inner_text() if element else ""
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
    """Click an element."""
    if not selector:
        raise ValueError("Usage: click <selector>")
    human_delay(100, 300, fast=session.fast)
    session.page.click(selector)
    audit_log("click", selector)
    return {"status": "ok", "action": "click", "selector": selector}


def cmd_type_text(session, selector, text, human=None):
    """Type text into an element."""
    use_human = (not session.fast) if human is None else human
    human_type(session.page, text, selector, fast=not use_human)
    audit_log("type", selector, f"chars={len(text)}")
    return {"status": "ok", "action": "type", "selector": selector, "chars": len(text)}


def cmd_press(session, key):
    """Press one Playwright keyboard key or key combination."""
    if not key:
        raise ValueError("Usage: press <key>")
    session.page.keyboard.press(key)
    audit_log("press", "keyboard", f"key={key}")
    return {"status": "ok", "action": "press", "key": key}


def cmd_scroll(session, direction="down", amount=3):
    """Scroll the page."""
    human_scroll(session.page, direction, amount, fast=session.fast)
    audit_log("scroll", direction, f"steps={amount}")
    return {"status": "ok", "action": "scroll", "direction": direction}


def cmd_wait_for(session, selector, timeout=None):
    """Wait for an element to become visible."""
    if not selector:
        raise ValueError("Usage: wait-for <selector>")
    t = timeout or session.timeout
    try:
        element = session.page.wait_for_selector(selector, timeout=t, state='visible')
        preview = element.inner_text()[:100] if element else ""
        audit_log("wait_for", selector, "found=true")
        return {"status": "ok", "found": True, "preview": preview}
    except Exception as exc:
        audit_log("wait_for", selector, "found=false")
        return {"status": "timeout", "found": False, "error": str(exc)}


def _json_safe(value):
    """Return the value if JSON-serializable, else a marker."""
    try:
        json.dumps(value)
        return value, True
    except (TypeError, ValueError):
        return str(value), False


def cmd_eval(session, js_code, sanitize=False):
    """
    Evaluate JavaScript and return the native value, JSON-encoded by the
    caller. The previous implementation returned str(result), which produced
    Python reprs ("None", "False", "{'a': 1}") that no JSON consumer can parse.
    """
    if not js_code:
        raise ValueError("Usage: eval <js>")
    raw = session.page.evaluate(js_code)
    value, serializable = _json_safe(raw)
    if sanitize and isinstance(value, str):
        value = sanitize_phi(value)
    digest = hashlib.sha256(js_code.encode('utf-8')).hexdigest()[:12]
    audit_log("eval", f"sha256={digest}", f"source={js_code[:120]}")
    return {
        "status": "ok",
        "result": value,
        "type": type(raw).__name__,
        "serializable": serializable,
    }


# -- assertions ---------------------------------------------------------------
def _assertion(passed: bool, detail: dict) -> dict:
    payload = {"status": "ok" if passed else "failed", "passed": passed, **detail}
    if not passed:
        payload["message"] = detail.get("message") or "assertion failed"
    return payload


def cmd_assert_text(session, selector, expected, timeout=None):
    """Assert that an element's text contains the expected substring."""
    if not selector or expected is None:
        raise ValueError('Usage: assert-text <selector> <expected>')
    element = session.page.wait_for_selector(selector, timeout=timeout or session.timeout)
    actual = element.inner_text() if element else ""
    passed = expected in actual
    audit_log("assert_text", selector, f"passed={passed}")
    return _assertion(passed, {
        "assertion": "text-contains",
        "selector": selector,
        "expected": expected,
        "actual": (sanitize_phi(actual) if session.sanitize else actual)[:400],
        "message": None if passed else f"{selector!r} text does not contain {expected!r}",
    })


def cmd_assert_visible(session, selector, expect_visible=True, timeout=None):
    """Assert that an element is (or is not) visible."""
    if not selector:
        raise ValueError('Usage: assert-visible <selector>')
    state = 'visible' if expect_visible else 'hidden'
    try:
        session.page.wait_for_selector(selector, timeout=timeout or session.timeout, state=state)
        passed = True
        error = None
    except Exception as exc:
        passed = False
        error = str(exc).split('\n')[0]
    audit_log("assert_visible", selector, f"expect={state},passed={passed}")
    return _assertion(passed, {
        "assertion": state,
        "selector": selector,
        "message": None if passed else f"{selector!r} is not {state}: {error}",
    })


def cmd_assert_count(session, selector, expected):
    """Assert an exact match count for a selector."""
    if not selector or expected is None:
        raise ValueError('Usage: assert-count <selector> <n>')
    expected_n = int(expected)
    actual = len(session.page.query_selector_all(selector))
    passed = actual == expected_n
    audit_log("assert_count", selector, f"expected={expected_n},actual={actual}")
    return _assertion(passed, {
        "assertion": "count",
        "selector": selector,
        "expected": expected_n,
        "actual": actual,
        "message": None if passed else f"expected {expected_n} match(es) for {selector!r}, found {actual}",
    })


def cmd_assert_url(session, expected):
    """Assert that the current URL contains the expected substring."""
    if not expected:
        raise ValueError('Usage: assert-url <substring>')
    actual = session.page.url
    passed = expected in actual
    audit_log("assert_url", actual, f"passed={passed}")
    return _assertion(passed, {
        "assertion": "url-contains",
        "expected": expected,
        "actual": actual,
        "message": None if passed else f"URL {actual!r} does not contain {expected!r}",
    })


def cmd_assert_title(session, expected):
    """Assert that the document title contains the expected substring."""
    if not expected:
        raise ValueError('Usage: assert-title <substring>')
    actual = session.page.title()
    passed = expected in actual
    audit_log("assert_title", "title", f"passed={passed}")
    return _assertion(passed, {
        "assertion": "title-contains",
        "expected": expected,
        "actual": actual,
        "message": None if passed else f"title {actual!r} does not contain {expected!r}",
    })


def cmd_assert_eval(session, js_code):
    """Assert that a JavaScript expression is truthy."""
    if not js_code:
        raise ValueError('Usage: assert-eval <js>')
    raw = session.page.evaluate(js_code)
    value, _ = _json_safe(raw)
    passed = bool(raw)
    digest = hashlib.sha256(js_code.encode('utf-8')).hexdigest()[:12]
    audit_log("assert_eval", f"sha256={digest}", f"passed={passed},source={js_code[:120]}")
    return _assertion(passed, {
        "assertion": "eval-truthy",
        "result": value,
        "message": None if passed else f"expression is falsy (result={value!r})",
    })


def cmd_assert_no_page_errors(session):
    """Assert that no uncaught page exception occurred in this session."""
    passed = not session.diagnostics.saw_page_error
    errors = list(session.diagnostics.all_page_errors)
    return _assertion(passed, {
        "assertion": "no-page-errors",
        "page_errors": errors,
        "message": None if passed else f"{len(errors) or 'some'} uncaught page error(s) occurred",
    })


# -- page management ----------------------------------------------------------
def cmd_pages(session):
    """List open pages so popups and OAuth windows are reachable."""
    live = session.pages
    current = session.page
    listing = []
    for index, page in enumerate(live):
        listing.append({
            "index": index,
            "url": page.url,
            "title": page.title(),
            "current": page is current,
        })
    return {"status": "ok", "action": "pages", "count": len(listing), "pages": listing}


def cmd_switch_page(session, index):
    """Switch the active page. Without this, popups are unreachable."""
    if index in (None, ""):
        raise ValueError("Usage: switch-page <index>")
    page = session.switch_page(int(index))
    page.bring_to_front()
    audit_log("switch_page", page.url, f"index={index}")
    return {"status": "ok", "action": "switch-page", "index": int(index), "url": page.url}


def cmd_close_page(session, index=None):
    """Close a page and fall back to the first remaining one."""
    live = session.pages
    target = session.page if index in (None, "") else live[int(index)]
    if len(live) <= 1:
        raise ValueError("Refusing to close the last open page.")
    url = target.url
    target.close()
    session.switch_page(0)
    audit_log("close_page", url)
    return {"status": "ok", "action": "close-page", "closed": url}


def cmd_save_storage(session, path):
    """Persist cookies and origin storage for hermetic reuse."""
    if not path:
        raise ValueError("Usage: save-storage <path>")
    target = Path(path).expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    session.context.storage_state(path=str(target))
    try:
        os.chmod(target, 0o600)
    except Exception:
        pass
    audit_log("save_storage", str(target))
    return {"status": "ok", "action": "save-storage", "path": str(target)}


def cmd_diagnostics(session):
    """Report captured console errors, page errors, and failed requests."""
    signals = session.diagnostics.drain()
    return {
        "status": "ok",
        "action": "diagnostics",
        "saw_page_error": session.diagnostics.saw_page_error,
        **({"signals": signals} if signals else {"signals": {}}),
    }


def cmd_fingerprint(session):
    """Report the verified fingerprint state instead of asserting it."""
    return {
        "status": "ok",
        "action": "fingerprint",
        "stealth_level": session.stealth_level,
        "degraded": session.stealth_degraded,
        "report": session.fingerprint,
    }


# -- Google Docs --------------------------------------------------------------
def cmd_gdoc_read(session, sanitize=False):
    """Read Google Doc content using keyboard shortcuts."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}

    try:
        page.wait_for_selector('.kix-appview-editor', timeout=10000)
    except Exception:
        page.wait_for_load_state('networkidle')

    for selector in ('.kix-appview-editor', '.kix-page'):
        try:
            page.click(selector, timeout=5000)
            break
        except Exception:
            continue

    human_delay(300, 600, fast=session.fast)
    mod = 'Meta' if sys.platform == 'darwin' else 'Control'
    page.keyboard.press(f'{mod}+a')
    human_delay(200, 400, fast=session.fast)
    page.keyboard.press(f'{mod}+c')
    human_delay(300, 600, fast=session.fast)

    text = None
    try:
        text = page.evaluate('''async () => {
            try { return await navigator.clipboard.readText(); }
            catch(e) { return null; }
        }''')
    except Exception:
        pass

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

    page.keyboard.press('End')
    if sanitize and text:
        text = sanitize_phi(text)
    audit_log("gdoc_read", page.url, f"chars={len(text) if text else 0}")
    return {"status": "ok", "text": text or ""}


def cmd_gdoc_type(session, text):
    """Type text at the cursor in a Google Doc."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}
    human_type(page, text, fast=session.fast)
    audit_log("gdoc_type", page.url, f"chars={len(text)}")
    return {"status": "ok", "action": "gdoc_type", "chars": len(text)}


def cmd_gdoc_find(session, search_text):
    """Find text in a Google Doc."""
    page = session.page
    if 'docs.google.com' not in page.url:
        return {"status": "error", "message": "Not on a Google Doc page."}
    mod = 'Meta' if sys.platform == 'darwin' else 'Control'
    page.keyboard.press(f'{mod}+f')
    human_delay(300, 600, fast=session.fast)
    human_type(page, search_text, fast=session.fast)
    human_delay(300, 500, fast=session.fast)
    page.keyboard.press('Enter')
    human_delay(300, 500, fast=session.fast)
    page.keyboard.press('Escape')
    human_delay(200, 400, fast=session.fast)
    audit_log("gdoc_find", page.url, f"query_len={len(search_text)}")
    return {"status": "ok", "action": "gdoc_find"}


def cmd_stealth_test(session):
    """Run an external bot-detection page and report a verdict."""
    if session.local_only:
        raise ValueError(
            "stealth-test navigates to a public detector and cannot run under --local-only."
        )
    page = session.page
    response = page.goto('https://bot.sannysoft.com/', wait_until='networkidle')
    http_status = response.status if response is not None else None
    human_delay(2000, 3000, fast=session.fast)

    parsed = page.evaluate('''() => {
        const rows = Array.from(document.querySelectorAll('table tr'));
        const tests = [];
        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 2) continue;
            const name = cells[0].textContent.trim();
            const cell = cells[1];
            const value = cell.textContent.trim();
            let verdict = 'unknown';
            if (cell.classList.contains('result-failed')) verdict = 'failed';
            else if (cell.classList.contains('result-passed')) verdict = 'passed';
            else if (value) verdict = 'informational';
            tests.push({ name, value, verdict });
        }
        return { rowCount: rows.length, tests };
    }''')

    # The detector table must actually have loaded, otherwise "no failures"
    # means "no data" rather than "clean".
    if parsed['rowCount'] == 0 or not parsed['tests']:
        return {
            "status": "error",
            "action": "stealth-test",
            "http_status": http_status,
            "message": "Detector table did not load; results would be meaningless.",
        }

    failed = [t for t in parsed['tests'] if t['verdict'] == 'failed']
    observed = page.evaluate('''() => ({
        webdriver: navigator.webdriver === undefined ? 'undefined' : String(navigator.webdriver),
        chrome: !!window.chrome,
        plugins: navigator.plugins.length,
        pluginsBrand: Object.prototype.toString.call(navigator.plugins),
        brands: navigator.userAgentData
            ? navigator.userAgentData.brands.map(b => b.brand + '/' + b.version).join(',')
            : 'absent',
    })''')
    headless_leak = 'Headless' in (observed.get('brands') or '')
    audit_log("stealth_test", "bot.sannysoft.com",
              f"failed={len(failed)},headless_leak={headless_leak}")

    return {
        "status": "ok" if not failed and not headless_leak else "failed",
        "action": "stealth-test",
        "http_status": http_status,
        "tests_evaluated": len(parsed['tests']),
        "failed_count": len(failed),
        "failed_tests": [t['name'] for t in failed][:20],
        "headless_identity_leak": headless_leak,
        "observed": observed,
        "message": None if not failed and not headless_leak
        else f"{len(failed)} detector check(s) failed; headless_leak={headless_leak}",
    }


# ---------------------------------------------------------------------------
# Command dispatch
# ---------------------------------------------------------------------------
HELP_COMMANDS = [
    "open <url>", "screenshot [path]", "read-dom [selector]", "read-page",
    "click <selector>", "type <selector> <text>", "scroll [up|down]",
    "press <key>", "wait-for <selector>", "wait <seconds>", "eval <js>",
    "assert-text <selector> <expected>", "assert-visible <selector>",
    "assert-hidden <selector>", "assert-count <selector> <n>",
    "assert-url <substring>", "assert-title <substring>", "assert-eval <js>",
    "assert-no-page-errors",
    "pages", "switch-page <index>", "close-page [index]",
    "save-storage <path>", "diagnostics", "fingerprint",
    "gdoc-read", "gdoc-type <text>", "gdoc-find <text>",
    "stealth-test", "url", "title", "quit",
]


def split_args(arg: str, count: int) -> list[str]:
    """
    Split a command argument into `count` fields.

    Quoted input is parsed with shlex so selectors and values may contain
    spaces ('type "div > .cell" "two words"'). Unquoted input keeps the legacy
    whitespace split so existing callers are unaffected.
    """
    stripped = arg.strip()
    if stripped[:1] in ('"', "'"):
        tokens = shlex.split(stripped)
        if len(tokens) < count:
            raise ValueError(f"Expected {count} arguments, received {len(tokens)}.")
        if len(tokens) > count:
            tokens = tokens[:count - 1] + [' '.join(tokens[count - 1:])]
        return tokens
    parts = stripped.split(maxsplit=count - 1)
    if len(parts) < count:
        raise ValueError(f"Expected {count} arguments, received {len(parts)}.")
    return parts


def dispatch(session, cmd: str, arg: str, sanitize=False, cleanup=False):
    """Execute one command line. Raises on usage errors."""
    if cmd == 'open':
        return cmd_open(session, arg)
    if cmd == 'screenshot':
        return cmd_screenshot(session, arg or None, cleanup=cleanup)
    if cmd in ('read-dom', 'readdom', 'dom'):
        return cmd_read_dom(session, arg or None, sanitize)
    if cmd in ('read-page', 'readpage', 'page'):
        return cmd_read_page(session, sanitize)
    if cmd == 'click':
        return cmd_click(session, arg)
    if cmd == 'type':
        selector, text = split_args(arg, 2)
        return cmd_type_text(session, selector, text)
    if cmd == 'press':
        return cmd_press(session, arg)
    if cmd == 'scroll':
        return cmd_scroll(session, arg or "down")
    if cmd in ('wait-for', 'waitfor'):
        return cmd_wait_for(session, arg)
    if cmd == 'wait':
        seconds = float(arg) if arg else 1
        # Playwright's own wait, not time.sleep: sleeping blocks the sync
        # dispatcher, so events queued during the pause (new pages, console
        # errors, page exceptions) would not be delivered.
        try:
            session.page.wait_for_timeout(seconds * 1000)
        except Exception:
            time.sleep(seconds)
        return {"status": "ok", "action": "wait"}
    if cmd == 'eval':
        return cmd_eval(session, arg, sanitize)
    if cmd == 'assert-text':
        selector, expected = split_args(arg, 2)
        return cmd_assert_text(session, selector, expected)
    if cmd == 'assert-visible':
        return cmd_assert_visible(session, arg, expect_visible=True)
    if cmd == 'assert-hidden':
        return cmd_assert_visible(session, arg, expect_visible=False)
    if cmd == 'assert-count':
        selector, expected = split_args(arg, 2)
        return cmd_assert_count(session, selector, expected)
    if cmd == 'assert-url':
        return cmd_assert_url(session, arg)
    if cmd == 'assert-title':
        return cmd_assert_title(session, arg)
    if cmd == 'assert-eval':
        return cmd_assert_eval(session, arg)
    if cmd == 'assert-no-page-errors':
        return cmd_assert_no_page_errors(session)
    if cmd == 'pages':
        return cmd_pages(session)
    if cmd == 'switch-page':
        return cmd_switch_page(session, arg)
    if cmd == 'close-page':
        return cmd_close_page(session, arg or None)
    if cmd == 'save-storage':
        return cmd_save_storage(session, arg)
    if cmd == 'diagnostics':
        return cmd_diagnostics(session)
    if cmd == 'fingerprint':
        return cmd_fingerprint(session)
    if cmd in ('gdoc-read', 'gdocread'):
        return cmd_gdoc_read(session, sanitize)
    if cmd in ('gdoc-type', 'gdoctype'):
        return cmd_gdoc_type(session, arg)
    if cmd in ('gdoc-find', 'gdocfind'):
        return cmd_gdoc_find(session, arg)
    if cmd in ('stealth-test', 'stealthtest', 'test'):
        return cmd_stealth_test(session)
    if cmd == 'url':
        return {"status": "ok", "action": "url", "url": session.page.url}
    if cmd == 'title':
        return {"status": "ok", "action": "title", "title": session.page.title()}
    return None


def _join_continuations(lines):
    """
    Allow a trailing backslash to continue a command onto the next line so
    multi-line JavaScript and multi-line text are expressible in a
    line-oriented protocol.
    """
    buffer = ""
    for line in lines:
        stripped = line.rstrip('\n')
        if stripped.endswith('\\'):
            buffer += stripped[:-1] + "\n"
            continue
        yield buffer + stripped
        buffer = ""
    if buffer:
        yield buffer


# ---------------------------------------------------------------------------
# REPL mode
# ---------------------------------------------------------------------------
class _IdleTimeoutError(Exception):
    pass


def _alarm_handler(signum, frame):
    raise _IdleTimeoutError()


def _read_input_with_timeout(prompt, timeout_sec):
    """Read input with an idle timeout. Uses SIGALRM on Unix."""
    if hasattr(signal, 'SIGALRM'):
        old_handler = signal.signal(signal.SIGALRM, _alarm_handler)
        signal.alarm(timeout_sec)
        try:
            return input(prompt)
        except _IdleTimeoutError:
            return None
        finally:
            # Always disarm. Leaving the alarm pending while restoring the
            # previous handler (SIG_DFL) let a later SIGALRM terminate the
            # process mid-shutdown and orphan Chromium.
            signal.alarm(0)
            signal.signal(signal.SIGALRM, old_handler)
    return input(prompt)


def run_repl(session, sanitize=False, cleanup=False, fail_fast=False):
    """
    Interactive REPL — keeps the browser open between commands.
    Returns True when every command succeeded.
    """
    print(json.dumps({
        "status": "ok",
        "action": "repl_start",
        "profile": getattr(session, 'profile', 'unknown'),
        "stealth": getattr(session, 'stealth_level', 'unknown'),
        "stealth_lib": "playwright-stealth-v2" if STEALTH_AVAILABLE else "js-only",
        "stealth_degraded": getattr(session, 'stealth_degraded', []),
        "idle_timeout_sec": REPL_IDLE_TIMEOUT,
    }))
    sys.stdout.flush()

    had_error = False
    pending = ""
    while True:
        try:
            line = _read_input_with_timeout("browse> " if not pending else "...> ",
                                           REPL_IDLE_TIMEOUT)
        except (EOFError, KeyboardInterrupt):
            print(json.dumps({"status": "ok", "action": "repl_exit", "reason": "interrupt"}))
            sys.stdout.flush()
            break

        if line is None:
            print(json.dumps({
                "status": "ok",
                "action": "repl_exit",
                "reason": f"idle_timeout_{REPL_IDLE_TIMEOUT}s",
                "message": f"No input for {REPL_IDLE_TIMEOUT}s. Closing browser to prevent zombie process."
            }))
            sys.stdout.flush()
            audit_log("repl_idle_timeout", f"profile={getattr(session, 'profile', '?')}",
                      f"timeout={REPL_IDLE_TIMEOUT}s")
            break

        line = line.rstrip()
        if line.endswith('\\'):
            pending += line[:-1] + "\n"
            continue
        line = (pending + line).strip()
        pending = ""
        if not line:
            continue

        parts = line.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        if cmd in ('quit', 'exit', 'q'):
            print(json.dumps({"status": "ok", "action": "repl_exit", "reason": "user_quit"}))
            sys.stdout.flush()
            break

        result = None
        try:
            if cmd == 'help':
                result = {"status": "ok", "action": "help", "commands": HELP_COMMANDS}
            else:
                result = dispatch(session, cmd, arg, sanitize=sanitize, cleanup=cleanup)
                if result is None:
                    result = {
                        "status": "error", "action": cmd,
                        "message": f"Unknown command: {cmd}. Type 'help'.",
                    }
                else:
                    result = with_diagnostics(session, result)
        except Exception as exc:
            result = {
                "status": "error",
                "action": cmd,
                "error_type": type(exc).__name__,
                "message": str(exc),
            }
            audit_log("repl_error", cmd, f"{type(exc).__name__}: {str(exc)[:150]}")

        if result:
            if result.get("status") != "ok":
                had_error = True
            print(json.dumps(result, indent=2, default=str))
            sys.stdout.flush()
            if had_error and fail_fast:
                print(json.dumps({"status": "ok", "action": "repl_exit", "reason": "fail_fast"}))
                sys.stdout.flush()
                break

    if getattr(session, 'diagnostics', None) and session.diagnostics.saw_page_error:
        had_error = True
    return not had_error


# ---------------------------------------------------------------------------
# Pipe/batch mode
# ---------------------------------------------------------------------------
def _stdin_lines_with_idle_timeout(timeout_sec):
    """
    Yield stdin lines, giving up if the producer holds the pipe open without
    sending anything. Falls back to plain iteration for non-selectable streams.
    """
    stream = sys.stdin
    try:
        fileno = stream.fileno()
    except Exception:
        yield from stream
        return
    while True:
        try:
            ready, _, _ = select.select([fileno], [], [], timeout_sec)
        except Exception:
            yield from stream
            return
        if not ready:
            audit_log("pipe_idle_timeout", "", f"timeout={timeout_sec}s")
            print(json.dumps({
                "status": "error",
                "action": "pipe",
                "message": f"No input for {timeout_sec}s. Closing browser to prevent zombie process.",
            }))
            sys.stdout.flush()
            return
        line = stream.readline()
        if not line:
            return
        yield line


def run_pipe(session, sanitize=False, cleanup=False, fail_fast=False, cleanup_files=None):
    """Read commands from stdin, one per line. Returns True when all succeeded."""
    had_error = False
    for line in _join_continuations(_stdin_lines_with_idle_timeout(PIPE_IDLE_TIMEOUT)):
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        parts = line.split(maxsplit=1)
        cmd = parts[0].lower()
        arg = parts[1] if len(parts) > 1 else ""

        try:
            result = dispatch(session, cmd, arg, sanitize=sanitize, cleanup=cleanup)
            if result is None:
                result = {"status": "error", "action": cmd, "message": f"Unknown command: {cmd}"}
            else:
                result = with_diagnostics(session, result)
        except Exception as exc:
            result = {
                "status": "error",
                "action": cmd,
                "error_type": type(exc).__name__,
                "message": str(exc),
            }

        if result.get("status") != "ok":
            had_error = True
        if cleanup_files is not None and result.get("cleanup_path"):
            cleanup_files.append(result["cleanup_path"])

        print(json.dumps(result, default=str))
        sys.stdout.flush()

        if had_error and fail_fast:
            print(json.dumps({
                "status": "error", "action": "pipe",
                "message": f"Aborting after failed command: {cmd} (--fail-fast).",
            }))
            sys.stdout.flush()
            break

    if session.diagnostics.saw_page_error:
        errors = session.diagnostics.all_page_errors
        print(json.dumps({
            "status": "failed",
            "action": "pipe",
            "message": "Uncaught page exception(s) occurred during this run.",
            "page_errors": errors[:10],
        }))
        sys.stdout.flush()
        had_error = True
    return not had_error


# ---------------------------------------------------------------------------
# Profile maintenance
# ---------------------------------------------------------------------------
def cmd_profiles(prune_older_than=None, apply_changes=False):
    """List profiles by size and age; optionally prune stale ones."""
    if not BROWSER_DATA_DIR.exists():
        return {"status": "ok", "profiles": [], "total_bytes": 0}
    now = time.time()
    entries = []
    total = 0
    for child in sorted(BROWSER_DATA_DIR.iterdir()):
        if not child.is_dir():
            continue
        size = sum(f.stat().st_size for f in child.rglob('*') if f.is_file())
        age_days = (now - child.stat().st_mtime) / 86400
        total += size
        entries.append({"profile": child.name, "bytes": size, "age_days": round(age_days, 1)})

    result = {
        "status": "ok",
        "action": "profiles",
        "count": len(entries),
        "total_bytes": total,
        "total_human": f"{total / (1024 ** 3):.2f} GiB",
        "profiles": sorted(entries, key=lambda e: e['bytes'], reverse=True),
    }
    if prune_older_than is None:
        return result

    stale = [e for e in entries if e['age_days'] > prune_older_than]
    result["stale_count"] = len(stale)
    result["stale_bytes"] = sum(e['bytes'] for e in stale)
    result["stale"] = [e['profile'] for e in stale]
    if not apply_changes:
        result["dry_run"] = True
        result["message"] = (
            f"{len(stale)} profile(s) older than {prune_older_than}d "
            f"({result['stale_bytes'] / (1024 ** 3):.2f} GiB). Re-run with --yes to delete."
        )
        return result

    removed = []
    for entry in stale:
        target = BROWSER_DATA_DIR / entry['profile']
        try:
            shutil.rmtree(target)
            removed.append(entry['profile'])
            audit_log("profile_pruned", f"profile={entry['profile']}", f"bytes={entry['bytes']}")
        except Exception as exc:
            print(f"⚠️  Could not remove {target}: {exc}", file=sys.stderr)
    result["removed"] = removed
    result["dry_run"] = False
    return result


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def build_parser():
    p = argparse.ArgumentParser(
        description='browse.py — local Playwright browser runner for agent-driven testing',
        formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument('--profile', default=DEFAULT_PROFILE, help='Browser profile name')
    p.add_argument('--ephemeral-profile', action='store_true',
                   help='Use a throwaway profile directory removed on exit (hermetic runs)')
    p.add_argument('--storage-state', metavar='PATH',
                   help='Seed cookies/localStorage from a Playwright storage-state JSON file')
    p.add_argument('--headless', action='store_true', help='Headless mode')
    p.add_argument('--cleanup', action='store_true',
                   help='Delete screenshots captured in this run on exit (see --help notes)')
    p.add_argument('--sanitize', action='store_true', help='Mask PHI patterns in text output')
    p.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT, help='Timeout (ms)')
    p.add_argument('--viewport', default='1440x900', help='Viewport WxH')
    p.add_argument('--stealth', choices=['full', 'light', 'none'], default='full',
                   help='Fingerprint level: full (stealth lib + CDP + JS), light (CDP + JS), none')
    p.add_argument('--allow-degraded-stealth', action='store_true',
                   help='Continue when a requested fingerprint layer cannot be applied')
    p.add_argument('--local-only', action='store_true',
                   help='Reject non-loopback navigation, subrequests, sockets, and service workers')
    p.add_argument('--inject', action='append', default=[], metavar='PATH',
                   help='Inject a UTF-8 .js/.mjs file before local page scripts (repeatable; requires --local-only)')
    p.add_argument('--fast', action='store_true',
                   help='Skip human-like delays and per-character typing')
    p.add_argument('--fail-fast', action='store_true',
                   help='Stop a pipe/repl run at the first failed command')
    p.add_argument('--allow-http-error', action='store_true',
                   help='Treat HTTP >= 400 on open as success')
    p.add_argument('--trace', metavar='PATH', help='Write a Playwright trace zip')
    p.add_argument('--video', metavar='DIR', help='Record video into DIR')
    p.add_argument('--har', metavar='PATH', help='Record a HAR archive')
    p.add_argument('--grant', action='append', default=[], metavar='PERMISSION',
                   help='Grant a browser permission (repeatable). Nothing is granted by default.')
    p.add_argument('--geolocation', metavar='LAT,LON',
                   help='Set geolocation coordinates (requires --grant geolocation)')
    p.add_argument('--skip-fv-check', action='store_true', help='Skip FileVault check')

    sub = p.add_subparsers(dest='command')

    sub.add_parser('repl', help='Interactive REPL (browser stays open)')
    sub.add_parser('pipe', help='Read commands from stdin (batch mode)')

    s = sub.add_parser('open', help='Navigate to URL')
    s.add_argument('url')

    s = sub.add_parser('screenshot', help='Take screenshot')
    s.add_argument('--output', '-o')
    s.add_argument('--element', '-e', help='Capture only this element')
    s.add_argument('--no-full-page', action='store_true', help='Capture the viewport only')

    s = sub.add_parser('read-dom', help='Read DOM text')
    s.add_argument('--selector', '-s')

    sub.add_parser('read-page', help='Full page text')

    s = sub.add_parser('click', help='Click element')
    s.add_argument('selector')

    s = sub.add_parser('type', help='Type text')
    s.add_argument('selector')
    s.add_argument('text')

    s = sub.add_parser('press', help='Press a keyboard key or key combination')
    s.add_argument('key')

    s = sub.add_parser('scroll', help='Scroll page')
    s.add_argument('--direction', '-d', choices=['up', 'down'], default='down')
    s.add_argument('--amount', '-a', type=int, default=3)

    s = sub.add_parser('wait-for', help='Wait for element')
    s.add_argument('selector')
    s.add_argument('--wait-timeout', type=int)

    s = sub.add_parser('eval', help='Evaluate JS')
    s.add_argument('js')

    s = sub.add_parser('assert-text', help='Assert element text contains a value')
    s.add_argument('selector')
    s.add_argument('expected')

    s = sub.add_parser('assert-visible', help='Assert element is visible')
    s.add_argument('selector')

    s = sub.add_parser('assert-hidden', help='Assert element is hidden')
    s.add_argument('selector')

    s = sub.add_parser('assert-count', help='Assert selector match count')
    s.add_argument('selector')
    s.add_argument('expected', type=int)

    s = sub.add_parser('assert-url', help='Assert URL contains a substring')
    s.add_argument('expected')

    s = sub.add_parser('assert-title', help='Assert title contains a substring')
    s.add_argument('expected')

    s = sub.add_parser('assert-eval', help='Assert a JS expression is truthy')
    s.add_argument('js')

    sub.add_parser('fingerprint', help='Report the verified fingerprint state')

    sub.add_parser('gdoc-read', help='Read Google Doc')

    s = sub.add_parser('gdoc-type', help='Type in Google Doc')
    s.add_argument('text')

    s = sub.add_parser('gdoc-find', help='Find in Google Doc')
    s.add_argument('text')

    sub.add_parser('stealth-test', help='Run bot detection test')

    s = sub.add_parser('profiles', help='List or prune persistent profiles')
    s.add_argument('--prune-older-than', type=float, metavar='DAYS')
    s.add_argument('--yes', action='store_true', help='Actually delete (default is a dry run)')

    return p


def parse_viewport(value: str) -> tuple[int, int]:
    """Parse WxH, failing loudly. A silent fallback tests the wrong breakpoint."""
    match = re.fullmatch(r'\s*(\d{2,5})\s*[xX]\s*(\d{2,5})\s*', value or '')
    if not match:
        raise ValueError(f"Invalid --viewport {value!r}. Expected WxH, for example 1440x900.")
    return int(match.group(1)), int(match.group(2))


def parse_geolocation(value: str) -> tuple[float, float]:
    parts = (value or '').split(',')
    if len(parts) != 2:
        raise ValueError(f"Invalid --geolocation {value!r}. Expected LAT,LON.")
    return float(parts[0]), float(parts[1])


def main():
    parser = build_parser()
    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    # Maintenance runs without a browser.
    if args.command == 'profiles':
        result = cmd_profiles(args.prune_older_than, args.yes)
        print(json.dumps(result, indent=2, default=str))
        return 0

    if not args.skip_fv_check and not check_filevault():
        return 1

    try:
        viewport = parse_viewport(args.viewport)
    except ValueError as exc:
        parser.error(str(exc))

    geolocation = None
    if args.geolocation:
        try:
            geolocation = parse_geolocation(args.geolocation)
        except ValueError as exc:
            parser.error(str(exc))

    if args.inject and not args.local_only:
        parser.error('--inject requires --local-only')
    if args.ephemeral_profile and args.profile != DEFAULT_PROFILE:
        parser.error('--ephemeral-profile cannot be combined with --profile')
    if args.local_only and args.command == 'open' and not is_local_test_url(args.url):
        parser.error('--local-only permits only loopback HTTP(S), data:, and about: URLs')

    cleanup_files = []
    exit_code = 0

    try:
        session_cm = StealthBrowserSession(
            profile=args.profile,
            headless=args.headless,
            timeout=args.timeout,
            viewport=viewport,
            stealth_level=args.stealth,
            local_only=args.local_only,
            init_script_paths=args.inject,
            fast=args.fast,
            sanitize=args.sanitize,
            allow_degraded_stealth=args.allow_degraded_stealth,
            ephemeral_profile=args.ephemeral_profile,
            storage_state_path=args.storage_state,
            trace_path=args.trace,
            video_dir=args.video,
            har_path=args.har,
            grant_permissions=args.grant,
            geolocation=geolocation,
            allow_http_error=args.allow_http_error,
        )
    except (ValueError, StealthConfigurationError) as exc:
        print(json.dumps({"status": "error", "message": str(exc)}), file=sys.stderr)
        return 1

    try:
        with session_cm as session:
            if args.command == 'repl':
                if not run_repl(session, args.sanitize, args.cleanup, args.fail_fast):
                    exit_code = 1
            elif args.command == 'pipe':
                if not run_pipe(session, args.sanitize, args.cleanup, args.fail_fast, cleanup_files):
                    exit_code = 1
            else:
                result = None
                if args.command == 'open':
                    result = cmd_open(session, args.url)
                elif args.command == 'screenshot':
                    result = cmd_screenshot(
                        session, args.output, args.cleanup,
                        full_page=not args.no_full_page, selector=args.element,
                    )
                    if result.get('cleanup_path'):
                        cleanup_files.append(result['cleanup_path'])
                elif args.command == 'read-dom':
                    result = cmd_read_dom(session, getattr(args, 'selector', None), args.sanitize)
                    print(result['text'])
                    result = None
                elif args.command == 'read-page':
                    result = cmd_read_page(session, args.sanitize)
                    print(f"URL: {result['url']}\nTitle: {result['title']}\n\n{result['text']}")
                    result = None
                elif args.command == 'click':
                    result = cmd_click(session, args.selector)
                elif args.command == 'type':
                    result = cmd_type_text(session, args.selector, args.text)
                elif args.command == 'press':
                    result = cmd_press(session, args.key)
                elif args.command == 'scroll':
                    result = cmd_scroll(session, args.direction, args.amount)
                elif args.command == 'wait-for':
                    result = cmd_wait_for(session, args.selector, getattr(args, 'wait_timeout', None))
                elif args.command == 'eval':
                    result = cmd_eval(session, args.js, args.sanitize)
                elif args.command == 'assert-text':
                    result = cmd_assert_text(session, args.selector, args.expected)
                elif args.command == 'assert-visible':
                    result = cmd_assert_visible(session, args.selector, True)
                elif args.command == 'assert-hidden':
                    result = cmd_assert_visible(session, args.selector, False)
                elif args.command == 'assert-count':
                    result = cmd_assert_count(session, args.selector, args.expected)
                elif args.command == 'assert-url':
                    result = cmd_assert_url(session, args.expected)
                elif args.command == 'assert-title':
                    result = cmd_assert_title(session, args.expected)
                elif args.command == 'assert-eval':
                    result = cmd_assert_eval(session, args.js)
                elif args.command == 'fingerprint':
                    result = cmd_fingerprint(session)
                elif args.command == 'gdoc-read':
                    result = cmd_gdoc_read(session, args.sanitize)
                    print(result['text'])
                    result = None
                elif args.command == 'gdoc-type':
                    result = cmd_gdoc_type(session, args.text)
                elif args.command == 'gdoc-find':
                    result = cmd_gdoc_find(session, args.text)
                elif args.command == 'stealth-test':
                    result = cmd_stealth_test(session)

                if result is not None:
                    result = with_diagnostics(session, result)
                    if result.get('status') != 'ok':
                        exit_code = 1
                    print(json.dumps(result, indent=2, default=str))
                if session.diagnostics.saw_page_error:
                    exit_code = 1
    except StealthConfigurationError as exc:
        print(json.dumps({"status": "error", "error_type": "StealthConfigurationError",
                          "message": str(exc)}), file=sys.stderr)
        return 1
    except ValueError as exc:
        print(json.dumps({"status": "error", "error_type": "ValueError",
                          "message": str(exc)}), file=sys.stderr)
        return 1

    for path in cleanup_files:
        outcome = secure_delete(path)
        print(json.dumps({"status": "ok", "action": "cleanup", **outcome}, default=str))
    return exit_code


if __name__ == '__main__':
    sys.exit(main())
