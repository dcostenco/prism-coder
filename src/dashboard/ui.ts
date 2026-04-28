/**
 * Mind Palace Dashboard — UI Renderer (v2.3.7)
 *
 * Pure CSS + Vanilla JS single-page dashboard.
 * No build step, no Tailwind, no framework — served as a template literal.
 *
 * ═══════════════════════════════════════════════════════════════════
 * DESIGN:
 *   - Dark glassmorphism theme with purple/blue gradients
 *   - Animated neural network background
 *   - Auto-discovers projects on load
 *   - Real-time data from storage API
 *   - Responsive grid layout
 * ═══════════════════════════════════════════════════════════════════
 */

export function renderDashboardHTML(version: string): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <title>Prism MCP — Mind Palace</title>
  <!-- PWA Metadata -->
  <link rel="manifest" href="/manifest.json">
  <meta name="theme-color" content="#0a0e1a">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <!-- Vis.js for Neural Graph (v2.3.0) -->
  <script type="text/javascript" src="https://unpkg.com/vis-network/standalone/umd/vis-network.min.js"></script>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    /* ─── Theme: Dark (Default) ─── */
    :root, [data-theme="dark"] {
      --bg-primary: #0a0e1a;
      --bg-secondary: #111827;
      --bg-glass: rgba(17, 24, 39, 0.6);
      --border-glass: rgba(139, 92, 246, 0.15);
      --border-glow: rgba(139, 92, 246, 0.3);
      --text-primary: #f1f5f9;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-purple: #8b5cf6;
      --accent-blue: #3b82f6;
      --accent-cyan: #06b6d4;
      --accent-green: #10b981;
      --accent-amber: #f59e0b;
      --accent-rose: #f43f5e;
      --gradient-hero: linear-gradient(135deg, #8b5cf6 0%, #3b82f6 50%, #06b6d4 100%);
      --radius: 16px;
      --radius-sm: 10px;
      --font-sans: 'Inter', system-ui, -apple-system, sans-serif;
      --font-mono: 'JetBrains Mono', 'Fira Code', monospace;
    }

    /* ─── Theme: Midnight — deeper blacks, blue-shifted accents ─── */
    [data-theme="midnight"] {
      --bg-primary: #020617;
      --bg-secondary: #0f172a;
      --bg-glass: rgba(2, 6, 23, 0.7);
      --border-glass: rgba(59, 130, 246, 0.15);
      --border-glow: rgba(59, 130, 246, 0.35);
      --text-primary: #e2e8f0;
      --text-secondary: #94a3b8;
      --text-muted: #475569;
      --accent-purple: #818cf8;
      --accent-blue: #60a5fa;
      --accent-cyan: #22d3ee;
      --accent-green: #34d399;
      --accent-amber: #fbbf24;
      --accent-rose: #fb7185;
      --gradient-hero: linear-gradient(135deg, #818cf8 0%, #60a5fa 50%, #22d3ee 100%);
    }

    /* ─── Theme: Purple Haze — warm violet tones ─── */
    [data-theme="purple"] {
      --bg-primary: #0c0515;
      --bg-secondary: #1a0a2e;
      --bg-glass: rgba(26, 10, 46, 0.65);
      --border-glass: rgba(168, 85, 247, 0.2);
      --border-glow: rgba(168, 85, 247, 0.4);
      --text-primary: #f5f3ff;
      --text-secondary: #c4b5fd;
      --text-muted: #7c3aed;
      --accent-purple: #a855f7;
      --accent-blue: #7c3aed;
      --accent-cyan: #c084fc;
      --accent-green: #a78bfa;
      --accent-amber: #e879f9;
      --accent-rose: #f472b6;
      --gradient-hero: linear-gradient(135deg, #a855f7 0%, #7c3aed 50%, #c084fc 100%);
    }

    body {
      background: var(--bg-primary);
      color: var(--text-primary);
      font-family: var(--font-sans);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* ─── Animated Background ─── */
    .bg-grid {
      position: fixed; inset: 0; z-index: 0;
      background-image:
        radial-gradient(circle at 20% 30%, rgba(139,92,246,0.08) 0%, transparent 50%),
        radial-gradient(circle at 80% 70%, rgba(59,130,246,0.06) 0%, transparent 50%),
        radial-gradient(circle at 50% 50%, rgba(6,182,212,0.04) 0%, transparent 60%);
      animation: bgPulse 8s ease-in-out infinite alternate;
    }
    @keyframes bgPulse {
      0% { opacity: 0.6; }
      100% { opacity: 1; }
    }

    .container { position: relative; z-index: 1; max-width: 1280px; margin: 0 auto; padding: 2rem; }

    /* ─── Header ─── */
    header {
      display: flex; justify-content: space-between; align-items: center;
      padding-bottom: 1.5rem; margin-bottom: 2rem;
      border-bottom: 1px solid var(--border-glass);
    }
    .logo {
      font-size: 1.75rem; font-weight: 700;
      background: var(--gradient-hero); -webkit-background-clip: text;
      background-clip: text; -webkit-text-fill-color: transparent;
      display: flex; align-items: center; gap: 0.5rem;
    }
    .logo-icon { -webkit-text-fill-color: initial; font-size: 1.5rem; }
    .version-badge {
      font-size: 0.7rem; font-weight: 500; padding: 0.2rem 0.6rem;
      border-radius: 999px; background: rgba(139,92,246,0.15);
      color: var(--accent-purple); border: 1px solid rgba(139,92,246,0.3);
      -webkit-text-fill-color: initial;
    }

    /* ─── Project Selector ─── */
    .selector {
      display: flex; gap: 0.75rem; align-items: center;
    }
    .selector select, .selector button {
      font-family: var(--font-sans); font-size: 0.875rem;
      border-radius: var(--radius-sm); outline: none;
      transition: all 0.2s ease;
    }
    .selector select {
      background: var(--bg-secondary); color: var(--text-primary);
      border: 1px solid var(--border-glass); padding: 0.6rem 1rem;
      min-width: 220px; cursor: pointer;
    }
    .selector select:hover { border-color: var(--border-glow); }
    .selector button {
      background: var(--gradient-hero); color: white; border: none;
      padding: 0.6rem 1.25rem; font-weight: 600; cursor: pointer;
    }
    .selector button:hover { opacity: 0.9; transform: translateY(-1px); box-shadow: 0 4px 12px rgba(139,92,246,0.3); }
    .selector button:active { transform: translateY(0); }

    /* ─── Glass Cards ─── */
    .card {
      background: var(--bg-glass); backdrop-filter: blur(16px);
      border: 1px solid var(--border-glass); border-radius: var(--radius);
      padding: 1.5rem; transition: border-color 0.3s ease, box-shadow 0.3s ease;
    }
    .card:hover { border-color: var(--border-glow); box-shadow: 0 0 20px rgba(139,92,246,0.05); }
    .card-title {
      font-size: 0.8rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.1em; margin-bottom: 1rem; display: flex;
      align-items: center; gap: 0.5rem;
    }
    .card-title .dot {
      width: 8px; height: 8px; border-radius: 50%; display: inline-block;
    }

    /* ─── Grid Layout ─── */
    .grid { display: grid; gap: 1.5rem; }
    .grid-main { grid-template-columns: 1fr 2fr; }
    @media (max-width: 900px) { .grid-main { grid-template-columns: 1fr; } }

    /* ─── PWA Mobile Overrides (v5.4) ─── */
    @media (max-width: 600px) {
      .container { padding: 1rem; }
      header { flex-direction: column; align-items: flex-start; gap: 1rem; }
      .selector { width: 100%; flex-wrap: wrap; }
      .selector select { flex: 1; min-width: 0; }
      
      /* Swipeable Columns via CSS Scroll Snap */
      .grid-main {
        display: flex;
        overflow-x: auto;
        scroll-snap-type: x mandatory;
        -webkit-overflow-scrolling: touch;
        gap: 0;
        margin: 0 -1rem; /* bleed to edge */
        padding-bottom: 1rem;
        scrollbar-width: none; /* Hide scrollbar Firefox */
      }
      .grid-main::-webkit-scrollbar { display: none; } /* Hide scrollbar Chrome/Safari */
      .grid-main > .grid {
        flex: 0 0 100%;
        scroll-snap-align: start;
        padding: 0 1rem;
      }
    }

    /* ─── State Panel ─── */
    .summary-text { color: var(--text-secondary); font-size: 0.9rem; line-height: 1.7; margin-bottom: 1rem; }
    .todo-list { list-style: none; padding: 0; }
    .todo-list li {
      padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.85rem; color: var(--text-secondary);
      display: flex; align-items: flex-start; gap: 0.5rem;
    }
    .todo-list li::before { content: '→'; color: var(--accent-cyan); font-weight: 600; flex-shrink: 0; }
    .todo-list li:last-child { border-bottom: none; }

    /* ─── Git Metadata ─── */
    .git-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.85rem;
    }
    .git-row:last-child { border-bottom: none; }
    .git-label { color: var(--text-muted); }
    .git-value { font-family: var(--font-mono); color: var(--text-primary); font-size: 0.8rem; }

    /* ─── Timeline Items ─── */
    .timeline { display: flex; flex-direction: column; gap: 0.75rem; max-height: 400px; overflow-y: auto; }
    .timeline::-webkit-scrollbar { width: 4px; }
    .timeline::-webkit-scrollbar-track { background: transparent; }
    .timeline::-webkit-scrollbar-thumb { background: var(--border-glass); border-radius: 2px; }

    .timeline-item {
      padding: 0.875rem 1rem; background: rgba(15,23,42,0.6);
      border-radius: var(--radius-sm); border-left: 3px solid var(--accent-amber);
      font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;
      transition: background 0.2s ease;
    }
    .timeline-item:hover { background: rgba(15,23,42,0.9); }
    .timeline-item.history { border-left-color: var(--accent-purple); }
    .timeline-item .meta {
      font-size: 0.7rem; font-family: var(--font-mono);
      color: var(--text-muted); margin-bottom: 0.25rem;
      display: flex; justify-content: space-between;
    }
    .timeline-item .badge {
      display: inline-block; padding: 0.1rem 0.4rem; border-radius: 4px;
      font-size: 0.65rem; font-weight: 600; text-transform: uppercase;
    }
    .badge-purple { background: rgba(139,92,246,0.2); color: var(--accent-purple); }
    .badge-amber { background: rgba(245,158,11,0.2); color: var(--accent-amber); }
    .badge-green { background: rgba(16,185,129,0.2); color: var(--accent-green); }

    .briefing-text {
      font-size: 0.9rem; color: var(--text-secondary); line-height: 1.8;
      white-space: pre-wrap;
    }

    /* ─── Visual Memory ─── */
    .visual-list { list-style: none; padding: 0; }
    .visual-list li {
      padding: 0.5rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.85rem; color: var(--text-secondary);
      display: flex; align-items: flex-start; gap: 0.5rem;
    }
    .visual-list li:last-child { border-bottom: none; }
    .visual-id {
      font-family: var(--font-mono); font-size: 0.75rem;
      color: var(--accent-rose); font-weight: 500;
    }
    .visual-date {
      font-size: 0.7rem; color: var(--text-muted); margin-left: auto;
      font-family: var(--font-mono); white-space: nowrap;
    }

    /* ─── Empty / Loading States ─── */
    .empty {
      text-align: center; padding: 3rem 1rem; color: var(--text-muted);
      font-size: 0.9rem;
    }
    .empty .emoji { font-size: 2.5rem; margin-bottom: 0.75rem; }
    .loading { display: none; text-align: center; padding: 2rem; color: var(--accent-purple); }
    .spinner {
      display: inline-block; width: 24px; height: 24px;
      border: 3px solid rgba(139,92,246,0.2); border-top-color: var(--accent-purple);
      border-radius: 50%; animation: spin 0.8s linear infinite;
      margin-right: 0.5rem; vertical-align: middle;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    #content { display: none; }

    /* ─── Fade in animation ─── */
    @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
    .fade-in { animation: fadeIn 0.4s ease-out forwards; }

    /* ─── Brain Health Indicator (v2.2.0) ─── */
    .health-status {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.75rem 1rem; border-radius: var(--radius-sm);
      background: rgba(15,23,42,0.6); margin-bottom: 1rem;
    }
    .health-dot {
      width: 12px; height: 12px; border-radius: 50%;
      flex-shrink: 0; position: relative;
    }
    .health-dot::after {
      content: ''; position: absolute; inset: -3px;
      border-radius: 50%; animation: healthPulse 2s ease-in-out infinite;
    }
    .health-dot.healthy { background: var(--accent-green); }
    .health-dot.healthy::after { border: 2px solid rgba(16,185,129,0.3); }
    .health-dot.degraded { background: var(--accent-amber); }
    .health-dot.degraded::after { border: 2px solid rgba(245,158,11,0.3); }
    .health-dot.unhealthy { background: var(--accent-rose); }
    .health-dot.unhealthy::after { border: 2px solid rgba(244,63,94,0.3); }
    .health-dot.unknown { background: var(--text-muted); }
    .health-dot.unknown::after { border: 2px solid rgba(100,116,139,0.3); }
    @keyframes healthPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
    .health-label { font-size: 0.8rem; font-weight: 500; }
    .health-summary { font-size: 0.75rem; color: var(--text-muted); }
    .health-issues { font-size: 0.8rem; color: var(--text-secondary); margin-top: 0.5rem; }
    .health-issues .issue-row {
      padding: 0.3rem 0; display: flex; gap: 0.5rem; align-items: flex-start;
    }
    .cleanup-btn {
      margin-left: auto; background: rgba(244,63,94,0.12); border: 1px solid rgba(244,63,94,0.3);
      color: var(--accent-rose); cursor: pointer; font-size: 0.75rem; font-weight: 600;
      padding: 0.2rem 0.65rem; border-radius: 6px; transition: all 0.2s;
    }
    .cleanup-btn:hover { background: rgba(244,63,94,0.25); border-color: var(--accent-rose); }
    .cleanup-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    /* ─── Health repair progress bar ─── */
    .health-progress-wrap {
      display: none; margin-top: 0.75rem;
      background: rgba(15,23,42,0.7); border-radius: 8px;
      padding: 0.65rem 0.85rem;
      border: 1px solid rgba(139,92,246,0.25);
    }
    .health-progress-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 0.45rem;
    }
    .health-progress-stage {
      font-size: 0.72rem; color: #a78bfa; font-weight: 500;
      transition: color 0.3s;
    }
    .health-progress-pct {
      font-size: 0.72rem; color: var(--text-muted); font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .health-progress-track {
      height: 6px; border-radius: 3px;
      background: rgba(139,92,246,0.15);
      overflow: hidden;
    }
    .health-progress-bar {
      height: 100%; width: 0%; border-radius: 3px;
      background: linear-gradient(90deg, #7c3aed, #a78bfa, #7c3aed);
      background-size: 200% 100%;
      animation: healthBarShimmer 1.8s linear infinite;
      transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes healthBarShimmer {
      0% { background-position: 200% 0; }
      100% { background-position: -200% 0; }
    }
    .health-progress-bar.done {
      animation: none;
      background: var(--accent-green);
      transition: width 0.25s ease-out, background 0.3s;
    }
    .toast-fixed {
      position: fixed; bottom: 1.5rem; right: 1.5rem; z-index: 200;
      padding: 0.65rem 1.2rem; border-radius: 10px; font-size: 0.85rem; font-weight: 500;
      backdrop-filter: blur(10px); border: 1px solid var(--border-glow);
      background: var(--bg-secondary); color: var(--text-primary);
      opacity: 0; transition: opacity 0.3s; pointer-events: none;
    }
    .toast-fixed.show { opacity: 1; }

    /* ─── Neural Graph (v2.3.0) ─── */
    #network-container {
      width: 100%; height: 300px;
      border-radius: var(--radius);
      background: rgba(0,0,0,0.2);
      border: 1px solid var(--border-glass);
    }
    .refresh-btn {
      margin-left: auto; background: none; border: none;
      color: var(--text-muted); cursor: pointer; font-size: 0.85rem;
      transition: color 0.2s;
    }
    .refresh-btn:hover { color: var(--accent-purple); }

    /* ─── Settings Modal (v3.0) ─── */
    .settings-btn {
      background: none; border: 1px solid var(--border-glass);
      color: var(--text-secondary); cursor: pointer; font-size: 1.1rem;
      padding: 0.4rem 0.7rem; border-radius: var(--radius-sm);
      transition: all 0.2s;
    }
    .settings-btn:hover { border-color: var(--border-glow); color: var(--accent-purple); }
    .identity-chip {
      display: none; align-items: center; gap: 0.4rem;
      padding: 0.35rem 0.75rem; border-radius: 999px;
      background: rgba(139,92,246,0.12); border: 1px solid rgba(139,92,246,0.25);
      color: var(--text-secondary); font-size: 0.8rem; font-weight: 500;
      cursor: pointer; transition: all 0.2s;
    }
    .identity-chip:hover { border-color: var(--accent-purple); color: var(--accent-purple); background: rgba(139,92,246,0.2); }
    .identity-chip .role-icon { font-size: 0.9rem; }
    .identity-chip .identity-label { max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Settings modal tab bar */
    .settings-tabs { display: flex; gap: 0; border-bottom: 1px solid var(--border-glass); margin: 0 -1.5rem 1.2rem; padding: 0 1.5rem; }
    .s-tab { padding: 0.55rem 1.1rem; font-size: 0.85rem; font-weight: 500; color: var(--text-secondary); cursor: pointer;
      border-bottom: 2px solid transparent; transition: all 0.2s; background: none; border-top: none; border-left: none; border-right: none; }
    .s-tab.active { color: var(--accent-purple); border-bottom-color: var(--accent-purple); }
    .s-tab:hover:not(.active) { color: var(--text-primary); }
    .s-tab-panel { display: none; } .s-tab-panel.active { display: block; }
    /* Skills editor */
    .skill-role-row { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 1rem; }
    .skill-role-row label { font-size: 0.82rem; color: var(--text-secondary); }
    .skill-role-select { padding: 0.3rem 0.6rem; background: var(--bg-hover); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); }
    .skill-textarea { width: 100%; min-height: 220px; background: var(--bg-hover); color: var(--text-primary);
      border: 1px solid var(--border-color); border-radius: var(--radius-sm); padding: 0.75rem;
      font-size: 0.82rem; font-family: var(--font-mono); line-height: 1.5; resize: vertical;
      box-sizing: border-box; transition: border-color 0.2s; }
    .skill-textarea:focus { outline: none; border-color: var(--accent-purple); }
    .skill-char-count { font-size: 0.74rem; color: var(--text-muted); text-align: right; margin-top: 0.3rem; }
    .skill-actions { display: flex; gap: 0.6rem; margin-top: 0.85rem; align-items: center; }
    .skill-save-btn { background: var(--accent-purple); color: #fff; border: none; border-radius: var(--radius-sm);
      padding: 0.45rem 1rem; font-size: 0.82rem; font-weight: 600; cursor: pointer; transition: opacity 0.2s; }
    .skill-save-btn:hover { opacity: 0.85; }
    .skill-upload-btn { background: none; border: 1px solid var(--border-glass); color: var(--text-secondary);
      border-radius: var(--radius-sm); padding: 0.45rem 0.85rem; font-size: 0.82rem; cursor: pointer; transition: all 0.2s; }
    .skill-upload-btn:hover { border-color: var(--accent-purple); color: var(--accent-purple); }
    .skill-clear-btn { background: none; border: none; color: var(--text-muted); font-size: 0.8rem; cursor: pointer;
      margin-left: auto; transition: color 0.2s; }
    .skill-clear-btn:hover { color: #ef4444; }
    .skill-hint { font-size: 0.78rem; color: var(--text-muted); margin-top: 0.6rem; line-height: 1.5; }
    .modal-overlay {
      display: none; position: fixed; inset: 0; z-index: 100;
      background: rgba(0,0,0,0.6); backdrop-filter: blur(4px);
      justify-content: center; align-items: center;
    }
    .modal-overlay.active { display: flex; }
    .modal {
      background: var(--bg-secondary); border: 1px solid var(--border-glow);
      border-radius: var(--radius); padding: 2rem; width: 480px; max-width: 90vw;
      max-height: 85vh; overflow-y: auto; position: relative;
    }
    .modal h2 { font-size: 1.1rem; margin-bottom: 1.5rem; display: flex; align-items: center; gap: 0.5rem; }
    .modal-close {
      position: absolute; top: 1rem; right: 1rem; background: none;
      border: none; color: var(--text-muted); cursor: pointer; font-size: 1.25rem;
    }
    .modal-close:hover { color: var(--text-primary); }
    .setting-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 0.75rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);
    }
    .setting-row:last-child { border-bottom: none; }
    .setting-label { font-size: 0.85rem; color: var(--text-secondary); }
    .setting-desc { font-size: 0.7rem; color: var(--text-muted); margin-top: 0.2rem; }
    .toggle {
      position: relative; width: 44px; height: 24px;
      background: rgba(100,116,139,0.3); border-radius: 12px;
      cursor: pointer; transition: background 0.3s; flex-shrink: 0;
    }
    .toggle.active { background: var(--accent-purple); }
    .toggle::after {
      content: ''; position: absolute; top: 2px; left: 2px;
      width: 20px; height: 20px; border-radius: 50%;
      background: white; transition: transform 0.3s;
    }
    .toggle.active::after { transform: translateX(20px); }
    .setting-select {
      background: var(--bg-primary); border: 1px solid var(--border-glass);
      color: var(--text-primary); padding: 0.4rem 0.6rem;
      border-radius: 6px; font-size: 0.8rem; font-family: var(--font-sans);
    }
    .setting-section {
      font-size: 0.7rem; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.1em; color: var(--accent-purple); margin: 1rem 0 0.5rem;
    }
    .setting-saved {
      font-size: 0.75rem; color: var(--accent-green); opacity: 0;
      transition: opacity 0.3s; margin-left: 0.5rem;
    }
    .setting-saved.show { opacity: 1; }
    .boot-badge {
      font-size: 0.6rem; padding: 0.15rem 0.5rem; border-radius: 4px;
      background: rgba(245,158,11,0.15); color: var(--accent-amber);
      font-weight: 600; text-transform: uppercase;
    }

    /* ─── Hivemind Radar (v3.0) ─── */
    .team-list { list-style: none; padding: 0; }
    .team-item {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.6rem 0; border-bottom: 1px solid rgba(255,255,255,0.05);
      font-size: 0.85rem;
    }
    .team-item:last-child { border-bottom: none; }
    .team-role { font-weight: 600; color: var(--text-primary); min-width: 60px; }
    .team-task { color: var(--text-secondary); flex: 1; }
    .team-heartbeat { font-size: 0.7rem; color: var(--text-muted); font-family: var(--font-mono); }
    .pulse-dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--accent-green);
      flex-shrink: 0; animation: pulseDot 2s ease-in-out infinite;
    }
    .pulse-dot.looping {
      animation: spinDot 1s linear infinite;
      background: #a855f7 !important;
      border-radius: 2px;
    }
    @keyframes pulseDot { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }
    @keyframes spinDot { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
    .team-status { font-size: 0.8rem; flex-shrink: 0; }

    /* ─── Memory Analytics (v3.1) ─── */
    .sparkline {
      display: flex; align-items: flex-end; gap: 3px;
      height: 48px; margin: 0.75rem 0 0.25rem;
    }
    .spark-bar {
      flex: 1; background: rgba(139,92,246,0.35);
      border-radius: 3px 3px 0 0; min-height: 3px;
      transition: background 0.2s;
    }
    .spark-bar:hover { background: var(--accent-purple); }
    .analytics-stats {
      display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem;
      margin-top: 0.75rem;
    }
    .astat {
      background: rgba(15,23,42,0.5); border-radius: var(--radius-sm);
      padding: 0.6rem 0.75rem; display: flex; flex-direction: column; gap: 0.15rem;
    }
    .astat-val { font-size: 1.1rem; font-weight: 700; color: var(--accent-purple); font-family: var(--font-mono); }
    .astat-label { font-size: 0.7rem; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.05em; }

    /* ─── Lifecycle Controls (v3.1) ─── */
    .lc-row { display: flex; gap: 0.5rem; margin-bottom: 0.5rem; align-items: center; }
    .lc-btn {
      flex: 1; padding: 0.5rem 0.6rem; font-size: 0.8rem; font-weight: 600;
      border-radius: var(--radius-sm); border: none; cursor: pointer;
      transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 0.4rem;
    }
    .lc-btn.compact { background: rgba(139,92,246,0.15); color: var(--accent-purple); border: 1px solid rgba(139,92,246,0.3); }
    .lc-btn.compact:hover { background: rgba(139,92,246,0.3); }
    .lc-btn.export { background: rgba(16,185,129,0.12); color: var(--accent-green); border: 1px solid rgba(16,185,129,0.3); }
    .lc-btn.export:hover { background: rgba(16,185,129,0.25); }
    .lc-btn.export-vault { background: rgba(139,92,246,0.12); color: #a78bfa; border: 1px solid rgba(139,92,246,0.3); }
    .lc-btn.export-vault:hover { background: rgba(139,92,246,0.25); }
    .lc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .ttl-row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.5rem; }
    .ttl-input {
      width: 70px; background: var(--bg-secondary); border: 1px solid var(--border-glass);
      color: var(--text-primary); border-radius: 6px; padding: 0.3rem 0.5rem;
      font-size: 0.82rem; font-family: var(--font-mono); text-align: center;
    }
    .ttl-label { font-size: 0.8rem; color: var(--text-secondary); }
    .ttl-save-btn {
      margin-left: auto; padding: 0.3rem 0.75rem; font-size: 0.78rem; font-weight: 600;
      background: rgba(245,158,11,0.15); color: var(--accent-amber);
      border: 1px solid rgba(245,158,11,0.3); border-radius: 6px; cursor: pointer; transition: all 0.2s;
    }
    .ttl-save-btn:hover { background: rgba(245,158,11,0.3); }
    .node-editor-panel {
      background: var(--bg-card);
      border: 1px solid var(--border-glow);
      border-radius: 8px;
      padding: 1rem;
      margin-top: 1rem;
      display: none;
    }

    /* ─── VM Lab Panel (v14.0) ─── */
    .vm-gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 1rem; }
    .vm-card {
      background: rgba(15,23,42,0.6); border: 1px solid var(--border-glass);
      border-radius: var(--radius-sm); padding: 1rem; cursor: pointer;
      transition: all 0.25s ease; position: relative; overflow: hidden;
    }
    .vm-card:hover { border-color: var(--accent-purple); transform: translateY(-2px); box-shadow: 0 8px 24px rgba(139,92,246,0.15); }
    .vm-card .vm-icon { font-size: 2rem; margin-bottom: 0.5rem; }
    .vm-card .vm-name { font-size: 0.9rem; font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem; }
    .vm-card .vm-specs { font-size: 0.72rem; color: var(--text-muted); font-family: var(--font-mono); }
    .vm-card .vm-tier {
      position: absolute; top: 0.5rem; right: 0.5rem;
      font-size: 0.6rem; padding: 0.1rem 0.4rem; border-radius: 4px;
      font-weight: 600; text-transform: uppercase;
    }
    .vm-tier.free { background: rgba(16,185,129,0.2); color: var(--accent-green); }
    .vm-tier.standard { background: rgba(59,130,246,0.2); color: var(--accent-blue); }
    .vm-tier.advanced { background: rgba(139,92,246,0.2); color: var(--accent-purple); }
    .vm-tier.enterprise { background: rgba(245,158,11,0.2); color: var(--accent-amber); }
    .vm-status-list { margin-top: 1.25rem; }
    .vm-status-row {
      display: flex; align-items: center; gap: 0.75rem;
      padding: 0.5rem 0.75rem; background: rgba(15,23,42,0.5);
      border-radius: var(--radius-sm); margin-bottom: 0.5rem;
      font-size: 0.82rem;
    }
    .vm-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
    .vm-status-dot.running { background: var(--accent-green); animation: pulseDot 2s ease-in-out infinite; }
    .vm-status-dot.stopped { background: var(--text-muted); }
    .vm-status-dot.paused { background: var(--accent-amber); }

    /* ─── Marketplace Panel (v14.0) ─── */
    .mp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1rem; margin-top: 1rem; }
    .mp-card {
      background: rgba(15,23,42,0.6); border: 1px solid var(--border-glass);
      border-radius: var(--radius-sm); padding: 1.25rem;
      transition: all 0.25s ease;
    }
    .mp-card:hover { border-color: var(--accent-cyan); box-shadow: 0 6px 20px rgba(6,182,212,0.1); }
    .mp-card .mp-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 0.75rem; }
    .mp-card .mp-name { font-weight: 600; font-size: 0.95rem; }
    .mp-card .mp-author { font-size: 0.72rem; color: var(--text-muted); margin-top: 0.15rem; }
    .mp-card .mp-desc { font-size: 0.8rem; color: var(--text-secondary); line-height: 1.5; margin-bottom: 0.75rem; }
    .mp-price-badge {
      font-size: 0.7rem; font-weight: 600; padding: 0.15rem 0.5rem;
      border-radius: 4px; flex-shrink: 0;
    }
    .mp-price-badge.free { background: rgba(16,185,129,0.2); color: var(--accent-green); }
    .mp-price-badge.paid { background: rgba(245,158,11,0.2); color: var(--accent-amber); }
    .mp-install-btn {
      width: 100%; padding: 0.45rem; font-size: 0.8rem; font-weight: 600;
      border-radius: var(--radius-sm); border: 1px solid var(--border-glass);
      background: rgba(139,92,246,0.1); color: var(--accent-purple);
      cursor: pointer; transition: all 0.2s;
    }
    .mp-install-btn:hover { background: rgba(139,92,246,0.25); border-color: var(--accent-purple); }
    .mp-filters {
      display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem;
    }
    .mp-filter-chip {
      padding: 0.3rem 0.75rem; font-size: 0.78rem; border-radius: 999px;
      border: 1px solid var(--border-glass); background: none;
      color: var(--text-secondary); cursor: pointer; transition: all 0.2s;
    }
    .mp-filter-chip.active, .mp-filter-chip:hover {
      background: rgba(139,92,246,0.15); border-color: var(--accent-purple); color: var(--accent-purple);
    }

    /* ─── Compliance Panel (v14.0) ─── */
    .compliance-layers {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .compliance-layer {
      background: rgba(15,23,42,0.6); border: 1px solid var(--border-glass);
      border-radius: var(--radius-sm); padding: 0.85rem; text-align: center;
    }
    .compliance-layer .cl-icon { font-size: 1.5rem; margin-bottom: 0.35rem; }
    .compliance-layer .cl-name { font-size: 0.78rem; font-weight: 600; margin-bottom: 0.25rem; }
    .compliance-layer .cl-status {
      font-size: 0.68rem; font-weight: 600; text-transform: uppercase;
      padding: 0.1rem 0.5rem; border-radius: 4px; display: inline-block;
    }
    .cl-status.active { background: rgba(16,185,129,0.2); color: var(--accent-green); }
    .cl-status.warning { background: rgba(245,158,11,0.2); color: var(--accent-amber); }
    .cl-status.error { background: rgba(244,63,94,0.2); color: var(--accent-rose); }
    .country-badges {
      display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem;
    }
    .country-badge {
      font-size: 0.72rem; padding: 0.2rem 0.6rem; border-radius: 6px;
      font-weight: 600; font-family: var(--font-mono);
    }
    .country-badge.embargoed { background: rgba(244,63,94,0.15); color: var(--accent-rose); border: 1px solid rgba(244,63,94,0.3); }
    .country-badge.restricted { background: rgba(245,158,11,0.12); color: var(--accent-amber); border: 1px solid rgba(245,158,11,0.25); }
    .audit-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    .audit-table th {
      text-align: left; padding: 0.5rem 0.75rem;
      font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.05em;
      color: var(--text-muted); border-bottom: 1px solid var(--border-glass);
    }
    .audit-table td {
      padding: 0.5rem 0.75rem; color: var(--text-secondary);
      border-bottom: 1px solid rgba(255,255,255,0.03);
    }
    .audit-severity {
      font-size: 0.65rem; font-weight: 600; padding: 0.1rem 0.4rem;
      border-radius: 3px; text-transform: uppercase;
    }
    .audit-severity.high { background: rgba(244,63,94,0.2); color: var(--accent-rose); }
    .audit-severity.medium { background: rgba(245,158,11,0.2); color: var(--accent-amber); }
    .audit-severity.low { background: rgba(16,185,129,0.2); color: var(--accent-green); }
  </style>
</head>
<body>
  <div class="bg-grid"></div>
  <div class="container">
    <header>
      <div class="logo">
        <span class="logo-icon">🧠</span>
        Prism Mind Palace
        <span class="version-badge">v${version}</span>
      </div>
      <div class="selector">
        <span class="identity-chip" id="identityChip" onclick="openSettings()" title="Agent Identity — click to change"></span>
        <select id="projectSelect">
          <option value="">Loading projects...</option>
        </select>
        <button onclick="loadProject()">Inspect</button>
        <button class="settings-btn" onclick="openSettings()" title="Settings">⚙️</button>
      </div>
    </header>

    <div class="main-tabs" style="display:flex; gap: 1rem; border-bottom: 1px solid var(--border-glass); margin-bottom: 1.5rem; padding-bottom: 0;">
      <button class="s-tab active" id="mtab-project" onclick="switchMainTab('project')" style="font-size: 1rem;">📁 Project View</button>
      <button class="s-tab" id="mtab-search" onclick="switchMainTab('search')" style="font-size: 1rem;">🔍 Vector Search</button>
      <button class="s-tab" id="mtab-factory" onclick="switchMainTab('factory')" style="font-size: 1rem;">🏭 Factory</button>
      <button class="s-tab" id="mtab-vm" onclick="switchMainTab('vm')" style="font-size: 1rem;">🖥️ VM Lab</button>
      <button class="s-tab" id="mtab-marketplace" onclick="switchMainTab('marketplace')" style="font-size: 1rem;">🛒 Marketplace</button>
      <button class="s-tab" id="mtab-compliance" onclick="switchMainTab('compliance')" style="font-size: 1rem;">🛡️ Compliance</button>
    </div>

    <div id="welcome" class="empty">
      <div class="emoji">🔮</div>
      <p>Select a project to inspect its neural state.</p>
    </div>

    <div id="loading" class="loading">
      <span class="spinner"></span> Neural link establishing...
    </div>

    <div id="content" class="grid grid-main fade-in">
      <!-- Left Column -->
      <div class="grid" style="align-content: start;">
        <!-- Current State -->
        <div class="card">
          <div class="card-title"><span class="dot" style="background:var(--accent-blue)"></span> Current State <span id="versionBadge" class="badge badge-purple" style="margin-left:auto"></span></div>
          <div class="summary-text" id="summary"></div>
          <div class="card-title" style="margin-top:0.5rem"><span class="dot" style="background:var(--accent-cyan)"></span> Pending TODOs</div>
          <ul class="todo-list" id="todos"></ul>
        </div>

        <!-- Intent Health (Feature A) -->
        <div class="card" id="intentHealthCard" style="display: none;">
          <div class="card-title" style="display: flex; justify-content: space-between; align-items: center;">
            <div><span class="dot" style="background:var(--accent-purple)"></span> Intent Health</div>
            <span style="font-size: 11px; color: var(--text-muted); cursor: help; border-bottom: 1px dotted var(--text-muted); letter-spacing: normal; text-transform: none;" title="Intent debt limits how AI agents can evolve the system (Storey / Fowler)">What is this?</span>
          </div>
          <div id="intentHealthCardContent"></div>
        </div>

        <!-- Git Metadata -->
        <div class="card">
          <div class="card-title"><span class="dot" style="background:var(--accent-green)"></span> Git Metadata</div>
          <div class="git-row"><span class="git-label">Branch</span><span class="git-value" id="gitBranch">—</span></div>
          <div class="git-row"><span class="git-label">Commit</span><span class="git-value" id="gitSha">—</span></div>
          <div class="git-row"><span class="git-label">Key Context</span><span class="git-value" id="keyContext" style="font-family:var(--font-sans);max-width:200px;text-align:right">—</span></div>
        </div>

        <!-- Brain Health (v2.2.0) -->
        <div class="card" id="healthCard" style="display:none">
          <div class="card-title">
            <span class="dot" style="background:var(--accent-green)"></span> Brain Health 🩺
            <button class="cleanup-btn" id="cleanupBtn" onclick="cleanupIssues()" style="display:none">🧹 Fix Issues</button>
          </div>
          <div class="health-status">
            <div class="health-dot unknown" id="healthDot"></div>
            <div>
              <div class="health-label" id="healthLabel">Scanning...</div>
              <div class="health-summary" id="healthSummary"></div>
            </div>
          </div>
          <div class="health-issues" id="healthIssues"></div>
          <!-- Repair progress bar (v6.1.4) -->
          <div class="health-progress-wrap" id="healthProgressWrap">
            <div class="health-progress-header">
              <span class="health-progress-stage" id="healthProgressStage">Initializing…</span>
              <span class="health-progress-pct" id="healthProgressPct">0%</span>
            </div>
            <div class="health-progress-track">
              <div class="health-progress-bar" id="healthProgressBar"></div>
            </div>
          </div>
        </div>

        <!-- Memory Analytics (v3.1) -->
        <div class="card" id="analyticsCard" style="display:none">
          <div class="card-title">
            <span class="dot" style="background:var(--accent-purple)"></span>
            Memory Analytics 📊
          </div>
          <div class="sparkline" id="sparkline" title="Sessions per day (last 14 days)"></div>
          <div style="font-size:0.68rem;color:var(--text-muted);text-align:right">Sessions / day (14d)</div>
          <div class="analytics-stats">
            <div class="astat"><div class="astat-val" id="astat-entries">—</div><div class="astat-label">Active sessions</div></div>
            <div class="astat"><div class="astat-val" id="astat-rollups">—</div><div class="astat-label">Rollups</div></div>
            <div class="astat"><div class="astat-val" id="astat-savings">—</div><div class="astat-label">Entries saved</div></div>
            <div class="astat"><div class="astat-val" id="astat-avglen">—</div><div class="astat-label">Avg summary chars</div></div>
          </div>
        </div>

        <!-- Lifecycle Controls (v3.1) -->
        <div class="card" id="lifecycleCard" style="display:none">
          <div class="card-title"><span class="dot" style="background:var(--accent-amber)"></span> Lifecycle Controls ⚙️</div>
          <div class="lc-row">
            <button class="lc-btn compact" id="compactBtn" onclick="compactNow()">
              🗜️ Compact Now
            </button>
            <button class="lc-btn export" id="exportBtn" onclick="exportPKM()">
              📦 Export ZIP
            </button>
            <button class="lc-btn export-vault" id="exportVaultBtn" onclick="exportVault()" title="Export as Obsidian/Logseq-compatible vault with Wikilinks and keyword index">
              🏛️ Export Vault
            </button>
          </div>
          <!-- Export progress bar (v6.1.4) -->
          <div class="health-progress-wrap" id="exportProgressWrap">
            <div class="health-progress-header">
              <span class="health-progress-stage" id="exportProgressStage">Building archive…</span>
              <span class="health-progress-pct" id="exportProgressPct">0%</span>
            </div>
            <div class="health-progress-track">
              <div class="health-progress-bar" id="exportProgressBar"></div>
            </div>
          </div>
          <div class="ttl-row">
            <span class="ttl-label">Auto-expire after</span>
            <input type="number" class="ttl-input" id="ttlInput" min="0" max="3650" placeholder="0" title="Days. 0 = disabled">
            <span class="ttl-label">days</span>
            <button class="ttl-save-btn" onclick="saveTTL()">Save TTL</button>
          </div>
          <div style="font-size:0.7rem;color:var(--text-muted);margin-top:0.4rem">0 = disabled. Min 7 days. Rollups are never expired.</div>
        </div>

        <!-- Universal History Import (v5.2) -->
        <div class="card" id="importCard" style="display:none">
          <div class="card-title"><span class="dot" style="background:var(--accent-cyan)"></span> Import History 📥</div>
          <div style="margin-bottom:0.75rem">
            <label style="font-size:0.78rem;color:var(--text-muted);display:block;margin-bottom:0.3rem">Source File</label>
            <div style="display:flex;gap:0.4rem;align-items:center">
              <input type="text" id="importPath" class="ttl-input" style="flex:1;text-align:left;font-size:0.82rem;padding:0.45rem 0.65rem" placeholder="/path/to/conversations.jsonl">
              <input type="file" id="importFileInput" accept=".jsonl,.json,.ndjson" style="display:none">
              <button class="lc-btn compact" onclick="document.getElementById('importFileInput').click()" style="flex:none;padding:0.45rem 0.75rem;font-size:0.82rem;white-space:nowrap" title="Choose a file from your computer">
                📂 Browse
              </button>
              <button class="lc-btn" onclick="clearImportFile()" id="importClearBtn" style="flex:none;padding:0.45rem 0.55rem;font-size:0.82rem;display:none;background:rgba(244,63,94,0.15);border-color:rgba(244,63,94,0.3);color:var(--accent-rose)" title="Clear selection">
                ✕
              </button>
            </div>
            <div id="importFileInfo" style="display:none;margin-top:0.35rem;font-size:0.72rem;color:var(--accent-cyan)"></div>
          </div>
          <div style="display:flex;gap:0.5rem;margin-bottom:0.75rem;flex-wrap:wrap">
            <div style="flex:1;min-width:120px">
              <label style="font-size:0.78rem;color:var(--text-muted);display:block;margin-bottom:0.3rem">Format</label>
              <select id="importFormat" class="ttl-input" style="width:100%;text-align:left;font-size:0.82rem;padding:0.35rem 0.5rem;cursor:pointer">
                <option value="">Auto-detect</option>
                <option value="claude">Claude Code (.jsonl)</option>
                <option value="gemini">Gemini (.json)</option>
                <option value="openai">OpenAI (.json)</option>
              </select>
            </div>
            <div style="flex:1;min-width:120px">
              <label style="font-size:0.78rem;color:var(--text-muted);display:block;margin-bottom:0.3rem">Target Project</label>
              <input type="text" id="importProject" class="ttl-input" style="width:100%;text-align:left;font-size:0.82rem;padding:0.45rem 0.65rem" placeholder="(auto from file)">
            </div>
          </div>
          <div style="display:flex;gap:0.5rem;align-items:center">
            <button class="lc-btn compact" id="importBtn" onclick="runImport(false)" style="flex:1">
              📥 Import
            </button>
            <button class="lc-btn export" id="importDryBtn" onclick="runImport(true)" style="flex:1" title="Validate without writing to storage">
              🧪 Dry Run
            </button>
          </div>
          <div id="importResult" style="display:none;margin-top:0.75rem;padding:0.65rem 0.85rem;border-radius:var(--radius-sm);font-size:0.82rem;line-height:1.5"></div>
          <!-- Import progress bar (v6.1.4) -->
          <div class="health-progress-wrap" id="importProgressWrap">
            <div class="health-progress-header">
              <span class="health-progress-stage" id="importProgressStage">Reading file…</span>
              <span class="health-progress-pct" id="importProgressPct">0%</span>
            </div>
            <div class="health-progress-track">
              <div class="health-progress-bar" id="importProgressBar"></div>
            </div>
          </div>
          <div style="font-size:0.68rem;color:var(--text-muted);margin-top:0.5rem">
            Click <strong>Browse</strong> to pick a file, or type a server-side path.<br>
            Supports Claude Code (.jsonl), Gemini (.json), and OpenAI (.json).
          </div>
        </div>

        <div class="card" id="briefingCard" style="display:none">
          <div class="card-title"><span class="dot" style="background:var(--accent-amber)"></span> Morning Briefing 🌅</div>
          <div class="briefing-text" id="briefingText"></div>
        </div>

        <!-- Visual Memory -->
        <div class="card" id="visualCard" style="display:none">
          <div class="card-title"><span class="dot" style="background:var(--accent-rose)"></span> Visual Memory 🖼️</div>
          <ul class="visual-list" id="visualList"></ul>
        </div>
      </div>

      <!-- Right Column -->
      <div class="grid" style="align-content: start;">

        <!-- Neural Graph (v2.3.0 / v5.1) -->
        <div class="card">
          <div class="card-title">
            <span class="dot" style="background:var(--accent-blue)"></span>
            Neural Graph 🕸️
            <button onclick="loadGraph()" class="refresh-btn">↻</button>
          </div>

          <!-- v5.1 Graph Filters -->
          <div style="display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; align-items:center;">
            <select id="graphProjectFilter" class="input-modern" style="min-width:120px; font-size:0.75rem; padding:0.3rem 0.5rem" onchange="loadGraph()">
              <option value="">All Projects</option>
            </select>
            <select id="graphDaysFilter" class="input-modern" style="font-size:0.75rem; padding:0.3rem 0.5rem" onchange="loadGraph()">
              <option value="">All Time</option>
              <option value="7">Last 7 Days</option>
              <option value="30">Last 30 Days</option>
              <option value="90">Last 90 Days</option>
            </select>
            <select id="graphImportanceFilter" class="input-modern" style="font-size:0.75rem; padding:0.3rem 0.5rem" onchange="loadGraph()">
              <option value="">Any Importance</option>
              <option value="5">Importance &gt;= 5</option>
              <option value="7">Graduated (&gt;= 7)</option>
            </select>
            <button id="decayToggle" class="input-modern" style="font-size:0.75rem; padding:0.3rem 0.65rem; cursor:pointer; border:1px solid rgba(139,92,246,0.3); background:transparent; color:var(--text-secondary); border-radius:6px; transition:all 0.2s; white-space:nowrap" onclick="toggleDecayView()" title="Color nodes by temporal freshness (Ebbinghaus decay)">
              🗓️ Decay View
            </button>
          </div>

          <div id="network-container">Loading nodes...</div>
          
          <!-- Graph Maintenance Actions -->
          <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-glass); display: flex; gap: 0.5rem; flex-wrap: wrap;">
            <button onclick="triggerEdgeSynthesis()" class="input-modern" style="font-size:0.75rem; padding:0.3rem 0.65rem; cursor:pointer; border:1px solid var(--accent-purple); background:transparent; color:var(--text-primary); border-radius:6px; transition:all 0.2s;">
              ⚡ Synthesize Edges
            </button>
            <span id="synthesisStatus" style="font-size: 0.75rem; color: var(--text-muted); align-self: center;"></span>
          </div>
          <!-- v5.1 Node Editor Panel -->
          <div id="nodeEditorPanel" class="node-editor-panel">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.8rem;">
              <h4 id="nodeEditorTitle" style="margin:0; font-size:0.9rem; color:var(--text-primary);">Node Name</h4>
              <span id="nodeEditorGroup" class="badge">category</span>
            </div>
            
            <label style="display:block; font-size:0.75rem; color:var(--text-muted); margin-bottom:0.3rem">Rename (Or leave empty to delete)</label>
            <div style="display:flex; gap:0.5rem; margin-bottom:0.6rem;">
              <input type="text" id="nodeEditorInput" class="input-modern" style="flex:1; font-size:0.8rem; padding:0.3rem 0.6rem" placeholder="New keyword name...">
              <button onclick="submitNodeEdit()" class="btn-modern" style="padding:0.3rem 0.8rem; font-size:0.8rem">Apply</button>
              <button onclick="document.getElementById('nodeEditorPanel').style.display='none'" class="btn-modern" style="background:transparent; border-color:var(--border-subtle); padding:0.3rem 0.8rem; font-size:0.8rem">Cancel</button>
            </div>
            
            <label style="display:block; font-size:0.75rem; color:var(--text-muted); margin-bottom:0.3rem">Or merge into existing:</label>
            <select id="nodeMergeSelect" class="input-modern" style="width:100%; font-size:0.8rem; padding:0.3rem 0.5rem" onchange="if(this.value) document.getElementById('nodeEditorInput').value = this.value">
              <option value="">-- Select node --</option>
            </select>
            
            <hr style="border:none; border-top:1px solid var(--border-subtle); margin:1rem 0;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">Active Recall</span>
              <button id="testMeBtn" onclick="triggerTestMe()" class="btn-modern" style="padding:0.3rem 0.6rem; font-size:0.75rem; background:var(--accent-teal); border-color:var(--accent-teal);" title="Generate 3 quiz questions using AI">📝 Test Me</button>
            </div>
            <div id="testMeContainer" style="margin-top:0.8rem; display:flex; flex-direction:column; gap:0.5rem;"></div>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-top:0.8rem;">
              <span style="font-size:0.75rem; color:var(--text-muted); font-weight:600;">Cognitive Route (v6.5)</span>
              <button id="cognitiveRouteBtn" onclick="triggerCognitiveRoute()" class="btn-modern" style="padding:0.3rem 0.6rem; font-size:0.75rem; background:var(--accent-blue); border-color:var(--accent-blue);" title="Resolve concept route and explain why it surfaced">🧭 Route</button>
            </div>
            <div id="cognitiveRouteContainer" style="margin-top:0.6rem; display:flex; flex-direction:column; gap:0.4rem;"></div>

          </div>
        </div>

        <!-- Time Travel -->
        <div class="card">
          <div class="card-title"><span class="dot" style="background:var(--accent-purple)"></span> Time Travel History 🕰️</div>
          <div class="timeline" id="historyTimeline"></div>
        </div>

        <!-- Ledger -->
        <div class="card">
          <div class="card-title"><span class="dot" style="background:var(--accent-amber)"></span> Session Ledger</div>
          <div class="timeline" id="ledgerTimeline"></div>
        </div>
        </div>

        <!-- Hivemind Radar (v3.0) -->
        <div class="card" id="hivemindCard" style="display:none">
          <div class="card-title">
            <span class="dot" style="background:var(--accent-cyan)"></span>
            Hivemind Radar 🐝
            <button onclick="loadTeam()" class="refresh-btn">↻</button>
          </div>
          <ul class="team-list" id="teamList">
            <li style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem">
              No active agents. Set PRISM_ENABLE_HIVEMIND=true to enable.
            </li>
          </ul>
        </div>

        <!-- Background Scheduler Status (v5.4) -->
        <div class="card" id="schedulerCard">
          <div class="card-title" style="display:flex;align-items:center;">
            <span class="dot" style="background:var(--accent-amber, #f59e0b)"></span>
            Background Scheduler ⏰
            <div style="flex:1"></div>
            <button id="scholarBtn" onclick="triggerWebScholar()" class="lc-btn compact" style="margin-right:0.5rem">🧠 Scholar (Run)</button>
            <button onclick="loadSchedulerStatus()" class="refresh-btn">↻</button>
          </div>
          <div id="schedulerContent" style="font-size:0.8rem;color:var(--text-muted)">
            Loading scheduler status...
          </div>
          <div id="densityStatContainer" style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-glass); font-size: 0.85em; color: var(--text-muted); display:none">
          </div>
        </div>
      </div>

      <!-- Graph Health Metrics (v6.0 Observability) -->
      <div class="card" style="margin-top:1rem">
        <div class="card-title" style="display:flex;align-items:center;gap:0.5rem">
          <span class="dot" style="background:var(--accent-blue)"></span>
          Graph Health 📊
          <div style="flex:1"></div>
          <span id="graphHealthWarnings" style="display:inline-flex;gap:0.3rem"></span>
          <button onclick="loadGraphMetrics()" class="refresh-btn">↻</button>
        </div>
        <div id="graphMetricsContent" style="font-size:0.8rem;color:var(--text-muted)">
          Loading graph metrics...
        </div>
      </div>
    </div>

    <!-- Search View (v6.0) -->
    <div id="search-content" class="fade-in" style="display:none; margin: 0 auto; max-width: 900px; padding: 0 1rem;">
      <div class="card">
        <div class="card-title"><span class="dot" style="background:var(--accent-purple)"></span> Semantic Vector Search 🔍</div>
        <div style="margin-bottom: 1.5rem; display:flex; gap:1rem; align-items:center;">
          <input type="text" id="searchInput" class="input-modern" style="flex:1; padding: 0.8rem 1rem; font-size: 1rem;" placeholder="Search past work, bugs, architecture decisions...">
          <label style="font-size: 0.85rem; color: var(--text-secondary); display:flex; align-items:center; gap:0.4rem; cursor:pointer;" title="Biases results towards the currently scoped project">
            <input type="checkbox" id="searchContextBoost" checked>
            Context Boost
          </label>
        </div>
        <div id="searchResults" class="timeline" style="margin-top: 1rem;">
          <div style="color:var(--text-muted); font-size:0.9rem; padding: 2rem; text-align:center;">
            Enter a query to search the neural ledger via embeddings...
          </div>
        </div>
      </div>
    </div>

    <!-- Dark Factory View (v7.3) -->
    <div id="factory-content" class="fade-in" style="display:none; margin: 0 auto; max-width: 1000px; padding: 0 1rem;">
      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;">
          <span class="dot" style="background:var(--accent-amber)"></span>
          Dark Factory — Autonomous Pipelines 🏭
          <div style="flex:1"></div>
          <button onclick="loadPipelines()" class="refresh-btn">↻</button>
        </div>
        <div style="display:flex;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap;align-items:center;">
          <select id="factoryStatusFilter" class="input-modern" style="font-size:0.75rem;padding:0.3rem 0.5rem" onchange="loadPipelines()">
            <option value="">All Statuses</option>
            <option value="PENDING">⏸ Pending</option>
            <option value="RUNNING">⏳ Running</option>
            <option value="COMPLETED">✅ Completed</option>
            <option value="FAILED">❌ Failed</option>
            <option value="ABORTED">🛑 Aborted</option>
          </select>
          <span id="factoryCount" style="font-size:0.75rem;color:var(--text-muted);margin-left:auto"></span>
        </div>
        <div id="factoryList" style="font-size:0.85rem;color:var(--text-muted)">Loading pipelines...</div>
      </div>
    </div>

    <!-- VM Lab Panel (v14.0) -->
    <div id="vm-content" class="fade-in" style="display:none; margin: 0 auto; max-width: 1100px; padding: 0 1rem;">
      <div class="card">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-blue)"></span>
          Device Template Gallery 🖥️
          <span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted)">14 templates</span>
        </div>
        <div class="vm-gallery">
          <div class="vm-card"><span class="vm-tier free">FREE</span><div class="vm-icon">🐧</div><div class="vm-name">Ubuntu 24.04 LTS</div><div class="vm-specs">4 cores · 8 GB · 64 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier free">FREE</span><div class="vm-icon">🐧</div><div class="vm-name">Debian 12 Minimal</div><div class="vm-specs">2 cores · 4 GB · 32 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier standard">STD</span><div class="vm-icon">🪣</div><div class="vm-name">Windows 11 Dev</div><div class="vm-specs">4 cores · 16 GB · 128 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier standard">STD</span><div class="vm-icon">🪣</div><div class="vm-name">Windows Server 2022</div><div class="vm-specs">8 cores · 32 GB · 256 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier advanced">ADV</span><div class="vm-icon">📱</div><div class="vm-name">iOS 18 Simulator</div><div class="vm-specs">4 cores · 8 GB · 64 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier advanced">ADV</span><div class="vm-icon">📱</div><div class="vm-name">iPadOS 18</div><div class="vm-specs">4 cores · 8 GB · 64 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier advanced">ADV</span><div class="vm-icon">⌚</div><div class="vm-name">watchOS 11</div><div class="vm-specs">2 cores · 2 GB · 16 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier standard">STD</span><div class="vm-icon">🤖</div><div class="vm-name">Android 15</div><div class="vm-specs">4 cores · 8 GB · 64 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier standard">STD</span><div class="vm-icon">⌚</div><div class="vm-name">Wear OS 5</div><div class="vm-specs">2 cores · 2 GB · 16 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier advanced">ADV</span><div class="vm-icon">🌎</div><div class="vm-name">macOS Sequoia</div><div class="vm-specs">8 cores · 16 GB · 256 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier enterprise">ENT</span><div class="vm-icon">🥽</div><div class="vm-name">visionOS 2</div><div class="vm-specs">8 cores · 16 GB · 128 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier enterprise">ENT</span><div class="vm-icon">🥽</div><div class="vm-name">Meta Quest 3</div><div class="vm-specs">8 cores · 12 GB · 128 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier free">FREE</span><div class="vm-icon">🐧</div><div class="vm-name">Alpine Linux</div><div class="vm-specs">1 core · 1 GB · 8 GB SSD</div></div>
          <div class="vm-card"><span class="vm-tier standard">STD</span><div class="vm-icon">🐧</div><div class="vm-name">Fedora 41</div><div class="vm-specs">4 cores · 8 GB · 64 GB SSD</div></div>
        </div>
      </div>

      <div class="card" style="margin-top:1.25rem">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-green)"></span>
          Active VMs
          <span style="margin-left:auto;font-size:0.72rem;color:var(--text-muted)">0 running</span>
        </div>
        <div class="vm-status-list">
          <div style="text-align:center;padding:2rem;color:var(--text-muted);font-size:0.85rem">
            <div style="font-size:2rem;margin-bottom:0.5rem">💤</div>
            No active VMs. Click a template above to create one.
          </div>
        </div>
      </div>
    </div>

    <!-- Marketplace Panel (v14.0) -->
    <div id="marketplace-content" class="fade-in" style="display:none; margin: 0 auto; max-width: 1100px; padding: 0 1rem;">
      <div class="card">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-cyan)"></span>
          Component Marketplace 🛒
          <button style="margin-left:auto;background:var(--gradient-hero);color:white;border:none;padding:0.35rem 0.85rem;border-radius:var(--radius-sm);font-size:0.78rem;font-weight:600;cursor:pointer">+ Publish Component</button>
        </div>

        <div style="display:flex;gap:0.75rem;margin-bottom:1rem;align-items:center">
          <input type="text" class="input-modern" style="flex:1;padding:0.6rem 1rem;font-size:0.9rem" placeholder="Search components, shaders, UI kits...">
        </div>

        <div class="mp-filters">
          <button class="mp-filter-chip active">All</button>
          <button class="mp-filter-chip">🎨 UI</button>
          <button class="mp-filter-chip">⚙️ Logic</button>
          <button class="mp-filter-chip">🎧 Audio</button>
          <button class="mp-filter-chip">✨ Shader</button>
          <button class="mp-filter-chip">📄 Template</button>
          <button class="mp-filter-chip">🎮 Game</button>
          <button class="mp-filter-chip">🤖 AI/ML</button>
        </div>

        <div class="mp-grid">
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">🎨 Glassmorphism UI Kit</div><div class="mp-author">by @studioflow</div></div>
              <span class="mp-price-badge free">FREE</span>
            </div>
            <div class="mp-desc">Premium glass-effect components with dark/light mode support. 24 components included.</div>
            <button class="mp-install-btn">⬇ Install</button>
          </div>
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">✨ PBR Shader Pack</div><div class="mp-author">by @renderlab</div></div>
              <span class="mp-price-badge paid">$14.99</span>
            </div>
            <div class="mp-desc">Physically-based rendering shaders for Metal, Vulkan, and WebGPU. Includes toon, cel, and water effects.</div>
            <button class="mp-install-btn">🛒 Purchase</button>
          </div>
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">🎮 Netcode Toolkit</div><div class="mp-author">by @multiplayerlabs</div></div>
              <span class="mp-price-badge paid">$29.99</span>
            </div>
            <div class="mp-desc">Client-side prediction, server reconciliation, and lag compensation for multiplayer games.</div>
            <button class="mp-install-btn">🛒 Purchase</button>
          </div>
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">🤖 Edge AI Runtime</div><div class="mp-author">by @inferenceio</div></div>
              <span class="mp-price-badge free">FREE</span>
            </div>
            <div class="mp-desc">On-device ML inference with CoreML, ONNX, and TFLite. Includes pose estimation and object detection models.</div>
            <button class="mp-install-btn">⬇ Install</button>
          </div>
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">🎧 Spatial Audio Engine</div><div class="mp-author">by @soundscapevr</div></div>
              <span class="mp-price-badge paid">$19.99</span>
            </div>
            <div class="mp-desc">HRTF-based 3D audio for VR/AR. Supports ambisonics, reverb zones, and occlusion.</div>
            <button class="mp-install-btn">🛒 Purchase</button>
          </div>
          <div class="mp-card">
            <div class="mp-header">
              <div><div class="mp-name">📄 SaaS Starter Kit</div><div class="mp-author">by @launchfast</div></div>
              <span class="mp-price-badge free">FREE</span>
            </div>
            <div class="mp-desc">Full-stack SaaS boilerplate with auth, billing, dashboard, and API. Next.js + Supabase.</div>
            <button class="mp-install-btn">⬇ Install</button>
          </div>
        </div>

        <div style="margin-top:1.25rem;padding:0.85rem;border-radius:var(--radius-sm);background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);font-size:0.78rem;color:var(--text-secondary)">
          💰 <strong>Revenue Sharing:</strong> Earn 70% of sales on paid components. Payouts via Synalux every 30 days.
        </div>
      </div>
    </div>

    <!-- Compliance Panel (v14.0) -->
    <div id="compliance-content" class="fade-in" style="display:none; margin: 0 auto; max-width: 1100px; padding: 0 1rem;">
      <div class="card">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-green)"></span>
          Enforcement Pipeline — 6 Layers 🛡️
        </div>
        <div class="compliance-layers">
          <div class="compliance-layer">
            <div class="cl-icon">📋</div>
            <div class="cl-name">Registration Gate</div>
            <div class="cl-status active">Active</div>
          </div>
          <div class="compliance-layer">
            <div class="cl-icon">🌐</div>
            <div class="cl-name">Geofence Gate</div>
            <div class="cl-status active">Active</div>
          </div>
          <div class="compliance-layer">
            <div class="cl-icon">🧠</div>
            <div class="cl-name">Use-Case AI</div>
            <div class="cl-status active">Active</div>
          </div>
          <div class="compliance-layer">
            <div class="cl-icon">📊</div>
            <div class="cl-name">Runtime Monitor</div>
            <div class="cl-status active">Active</div>
          </div>
          <div class="compliance-layer">
            <div class="cl-icon">🚨</div>
            <div class="cl-name">Kill Switch</div>
            <div class="cl-status active">Armed</div>
          </div>
          <div class="compliance-layer">
            <div class="cl-icon">🔗</div>
            <div class="cl-name">Audit Trail</div>
            <div class="cl-status active">Hash-Chain</div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:1.25rem">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-rose)"></span>
          Embargoed Countries — Hard-Blocked
        </div>
        <div class="country-badges">
          <span class="country-badge embargoed">⛔ BY — Belarus</span>
          <span class="country-badge embargoed">⛔ CU — Cuba</span>
          <span class="country-badge embargoed">⛔ IR — Iran</span>
          <span class="country-badge embargoed">⛔ KP — DPRK</span>
          <span class="country-badge embargoed">⛔ SY — Syria</span>
        </div>

        <div class="card-title" style="margin-top:1rem">
          <span class="dot" style="background:var(--accent-amber)"></span>
          Restricted — Civilian Only
        </div>
        <div class="country-badges">
          <span class="country-badge restricted">🟡 RU — Russia</span>
          <span class="country-badge restricted">🟡 CN — China</span>
          <span class="country-badge restricted">🟡 VE</span>
          <span class="country-badge restricted">🟡 MM</span>
          <span class="country-badge restricted">🟡 SD</span>
          <span class="country-badge restricted">🟡 SS</span>
          <span class="country-badge restricted">🟡 LY</span>
          <span class="country-badge restricted">🟡 SO</span>
          <span class="country-badge restricted">🟡 YE</span>
          <span class="country-badge restricted">🟡 ZW</span>
          <span class="country-badge restricted">🟡 CD</span>
          <span class="country-badge restricted">🟡 CF</span>
          <span class="country-badge restricted">🟡 IQ</span>
          <span class="country-badge restricted">🟡 LB</span>
        </div>
      </div>

      <div class="card" style="margin-top:1.25rem">
        <div class="card-title">
          <span class="dot" style="background:var(--accent-purple)"></span>
          Recent Audit Events 📜
        </div>
        <table class="audit-table">
          <thead>
            <tr><th>Time</th><th>Event</th><th>Severity</th><th>Details</th></tr>
          </thead>
          <tbody>
            <tr>
              <td style="font-family:var(--font-mono);font-size:0.72rem">2 min ago</td>
              <td>Registration screened</td>
              <td><span class="audit-severity low">Low</span></td>
              <td style="color:var(--text-muted)">KYC passed — US-based individual</td>
            </tr>
            <tr>
              <td style="font-family:var(--font-mono);font-size:0.72rem">18 min ago</td>
              <td>Use-case classified</td>
              <td><span class="audit-severity low">Low</span></td>
              <td style="color:var(--text-muted)">Project "pet-tracker" — consumer app (2% risk)</td>
            </tr>
            <tr>
              <td style="font-family:var(--font-mono);font-size:0.72rem">1 hr ago</td>
              <td>Geofence mismatch</td>
              <td><span class="audit-severity medium">Medium</span></td>
              <td style="color:var(--text-muted)">IP: DE, Billing: FR — flagged for human review</td>
            </tr>
            <tr>
              <td style="font-family:var(--font-mono);font-size:0.72rem">4 hr ago</td>
              <td>VPN detected</td>
              <td><span class="audit-severity medium">Medium</span></td>
              <td style="color:var(--text-muted)">NordVPN exit node — billing triangulation passed</td>
            </tr>
            <tr>
              <td style="font-family:var(--font-mono);font-size:0.72rem">1 day ago</td>
              <td>Sanctions check failed</td>
              <td><span class="audit-severity high">High</span></td>
              <td style="color:var(--text-muted)">OFAC SDN match — registration blocked</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="margin-top:1.25rem;padding:0.85rem;border-radius:var(--radius-sm);background:rgba(16,185,129,0.08);border:1px solid rgba(16,185,129,0.2);font-size:0.78rem;color:var(--text-secondary)">
        ✅ <strong>All 6 enforcement layers are active.</strong> Ethics enforcement is NOT tier-gated — applies equally to Free, Standard, Advanced, and Enterprise.
        <a href="/ethics" style="color:var(--accent-purple);margin-left:0.5rem">View full policy →</a>
      </div>
    </div>

    <!-- Settings Modal (v3.0) -->
    <div class="modal-overlay" id="settingsModal">
      <div class="modal">
        <button class="modal-close" onclick="closeSettings()">✕</button>
        <h2>⚙️ Settings</h2>

        <!-- Tab bar -->
        <div class="settings-tabs">
          <button class="s-tab active" id="stab-settings" onclick="switchSettingsTab('settings')">⚙️ Settings</button>
          <button class="s-tab" id="stab-skills" onclick="switchSettingsTab('skills')">📜 Skills</button>
          <button class="s-tab" id="stab-providers" onclick="switchSettingsTab('providers')">🤖 AI Providers</button>
          <button class="s-tab" id="stab-observability" onclick="switchSettingsTab('observability')">🔭 Observability</button>
        </div>

        <!-- Settings panel (existing content) -->
        <div class="s-tab-panel active" id="spanel-settings">

        <div class="setting-section">Runtime Settings</div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Auto-Capture HTML</div>
            <div class="setting-desc">Capture local dev server UI on handoff save</div>
          </div>
          <div class="toggle" id="toggle-auto-capture" onclick="toggleSetting('auto_capture', this)"></div>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Dashboard Theme</div>
            <div class="setting-desc">Visual theme for Mind Palace</div>
          </div>
          <select class="setting-select" id="select-theme" onchange="saveSetting('dashboard_theme', this.value)">
            <option value="dark">Dark (Default)</option>
            <option value="midnight">Midnight</option>
            <option value="purple">Purple Haze</option>
          </select>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Context Depth</div>
            <div class="setting-desc">Default level for session_load_context</div>
          </div>
          <select class="setting-select" id="select-context-depth" onchange="saveSetting('default_context_depth', this.value)">
            <option value="standard">Standard (~200 tokens)</option>
            <option value="quick">Quick (~50 tokens)</option>
            <option value="deep">Deep (~1000+ tokens)</option>
          </select>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Token Budget</div>
            <div class="setting-desc">Max tokens for session_load_context (0 = unlimited)</div>
          </div>
          <input type="number" id="input-max-tokens"
            placeholder="0"
            min="0" max="100000" step="500"
            style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 90px; text-align: right;"
            onchange="saveSetting('max_tokens', this.value)"
            oninput="clearTimeout(this._t); var _s=this; this._t=setTimeout(function(){saveSetting('max_tokens',_s.value)},800)" />
        </div>

        <div class="setting-section">Boot Settings <span class="boot-badge">Restart Required</span></div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Hivemind Mode</div>
            <div class="setting-desc">Multi-agent coordination (PRISM_ENABLE_HIVEMIND)</div>
          </div>
          <div class="toggle" id="toggle-hivemind" onclick="toggleBootSetting('hivemind_enabled', this)"></div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Task Router</div>
            <div class="setting-desc">Route tasks to local Claw agent (PRISM_TASK_ROUTER_ENABLED)</div>
          </div>
          <div class="toggle" id="toggle-task-router" onclick="toggleBootSetting('task_router_enabled', this)"></div>
        </div>
        <div class="setting-row">
          <div>
            <div class="setting-label">Storage Backend</div>
            <div class="setting-desc">Auto prefers Synalux Cloud when credentials exist</div>
          </div>
          <select id="storageBackendSelect" onchange="window.saveBootSetting('PRISM_STORAGE', this.value)" style="padding: 0.2rem 0.4rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); cursor: pointer;">
            <option value="auto">Auto (Cloud Preferred)</option>
            <option value="local">SQLite</option>
            <option value="supabase">Supabase</option>
          </select>
        </div>

        <div class="setting-row" style="align-items:flex-start">
          <div>
            <div class="setting-label">Auto-Load Projects</div>
            <div class="setting-desc">Select projects to auto-push context on startup</div>
          </div>
          <div id="autoload-checkboxes" style="display:flex;flex-direction:column;gap:4px;font-size:0.85rem;font-family:var(--font-mono);max-height:120px;overflow-y:auto;">
            <span style="color:var(--text-muted);font-size:0.8rem">Loading…</span>
          </div>
        </div>

        <div class="setting-row" style="align-items:flex-start">
          <div>
            <div class="setting-label">Project Repo Paths</div>
            <div class="setting-desc">Map each project to its repo directory for save validation</div>
          </div>
          <div id="repopath-inputs" style="display:flex;flex-direction:column;gap:6px;font-size:0.85rem;max-height:160px;overflow-y:auto;">
            <span style="color:var(--text-muted);font-size:0.8rem">Loading…</span>
          </div>
        </div>

        <div class="setting-section">Agent Identity</div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Default Role</div>
            <div class="setting-desc">Used when no role is passed to memory/Hivemind tools</div>
          </div>
          <select class="setting-select" id="select-default-role" onchange="saveSetting('default_role', this.value)">
            <option value="global">global (shared)</option>
            <option value="dev">dev</option>
            <option value="qa">qa</option>
            <option value="pm">pm</option>
            <option value="lead">lead</option>
            <option value="security">security</option>
            <option value="ux">ux</option>
          </select>
        </div>

        <div class="setting-row">
          <div>
            <div class="setting-label">Agent Name</div>
            <div class="setting-desc">Display name shown in Hivemind Radar (e.g. Dmitri, Dev Alex)</div>
          </div>
          <input type="text" id="input-agent-name"
            placeholder="e.g. Dmitri"
            style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 130px;"
            onchange="saveSetting('agent_name', this.value)"
            oninput="clearTimeout(this._t); var self=this; this._t=setTimeout(function(){saveSetting('agent_name',self.value)},800)" />
        </div>

        <span class="setting-saved" id="savedToast">Saved ✓</span>
        </div><!-- /spanel-settings -->

        <!-- Skills panel -->
        <div class="s-tab-panel" id="spanel-skills">
          <div class="skill-role-row">
            <label>Role</label>
            <select class="skill-role-select" id="skillRoleSelect" onchange="loadSkillForRole(this.value)">
              <option value="global">🌐 global</option>
              <option value="dev">🛠️ dev</option>
              <option value="qa">🔍 qa</option>
              <option value="pm">📋 pm</option>
              <option value="lead">🏗️ lead</option>
              <option value="security">🔒 security</option>
              <option value="ux">🎨 ux</option>
            </select>
          </div>
          <textarea class="skill-textarea" id="skillTextarea"
            placeholder="Paste rules, conventions, or prompts for this role...
Example:\n## Dev Rules\n- Always write tests first\n- Use TypeScript strict mode\n- Log errors to console.error"
            oninput="document.getElementById('skillCharCount').textContent = this.value.length + ' chars'">
          </textarea>
          <div class="skill-char-count" id="skillCharCount">0 chars</div>
          <div class="skill-actions">
            <button class="skill-save-btn" onclick="saveCurrentSkill()">💾 Save</button>
            <label class="skill-upload-btn" title="Upload a .md or .txt file">
              📎 Upload file
              <input type="file" accept=".md,.txt,.markdown" style="display:none"
                onchange="handleSkillUpload(this)">
            </label>
            <button class="skill-clear-btn" onclick="clearCurrentSkill()">🗑️ Clear</button>
          </div>
          <div class="skill-hint">
            Skills are auto-injected into <code>session_load_context</code> responses for this role.<br>
            Use Markdown. Changes take effect immediately — no restart needed.
          </div>
        </div><!-- /spanel-skills -->

        <!-- AI Providers panel (v4.4) -->
        <div class="s-tab-panel" id="spanel-providers">

          <div class="setting-section">Text Provider <span class="boot-badge">Restart Required</span></div>

          <!-- ── Text Provider ──────────────────────────────── -->
          <div class="setting-row">
            <div>
              <div class="setting-label">Text Provider</div>
              <div class="setting-desc">LLM used for compaction, briefing, security scan &amp; fact merging</div>
            </div>
            <select id="select-text-provider"
              style="padding: 0.2rem 0.4rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); cursor: pointer;"
              onchange="onTextProviderChange(this.value)">
              <option value="gemini">🔵 Gemini (Google)</option>
              <option value="openai">🟢 OpenAI / Ollama</option>
              <option value="anthropic">🟣 Anthropic (Claude)</option>
            </select>
          </div>

          <!-- Gemini text fields -->
          <div id="provider-fields-gemini">
            <div class="setting-row">
              <div>
                <div class="setting-label">Google API Key</div>
                <div class="setting-desc">GOOGLE_API_KEY — required for Gemini text &amp; embeddings</div>
              </div>
              <input type="password" id="input-google-api-key"
                placeholder="AIza…"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 180px;"
                onchange="saveBootSetting('GOOGLE_API_KEY', this.value)"
                oninput="clearTimeout(this._pt); var self=this; this._pt=setTimeout(function(){saveBootSetting('GOOGLE_API_KEY',self.value)},800)" />
            </div>
          </div>

          <!-- OpenAI / Ollama text fields -->
          <div id="provider-fields-openai" style="display:none">
            <div class="setting-row">
              <div>
                <div class="setting-label">API Key</div>
                <div class="setting-desc">Leave blank for Ollama / LM Studio (local endpoints)</div>
              </div>
              <input type="password" id="input-openai-api-key"
                placeholder="sk-… (blank for Ollama)"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 180px;"
                onchange="saveBootSetting('openai_api_key', this.value)"
                oninput="clearTimeout(this._pt); var self=this; this._pt=setTimeout(function(){saveBootSetting('openai_api_key',self.value)},800)" />
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Base URL</div>
                <div class="setting-desc">Ollama: http://localhost:11434/v1 · LM Studio: http://localhost:1234/v1</div>
              </div>
              <input type="text" id="input-openai-base-url"
                placeholder="https://api.openai.com/v1"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 220px;"
                onchange="saveBootSetting('openai_base_url', this.value)"
                oninput="clearTimeout(this._pu); var self=this; this._pu=setTimeout(function(){saveBootSetting('openai_base_url',self.value)},800)" />
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Chat Model</div>
                <div class="setting-desc">Used for compaction, briefing, security scan</div>
              </div>
              <input type="text" id="input-openai-model"
                placeholder="gpt-4o-mini"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 160px;"
                onchange="saveBootSetting('openai_model', this.value)"
                oninput="clearTimeout(this._pm); var self=this; this._pm=setTimeout(function(){saveBootSetting('openai_model',self.value)},800)" />
            </div>
          </div>

          <!-- Anthropic / Claude text fields -->
          <div id="provider-fields-anthropic" style="display:none">
            <div class="setting-row">
              <div>
                <div class="setting-label">Anthropic API Key</div>
                <div class="setting-desc">Required. Get yours at console.anthropic.com</div>
              </div>
              <input type="password" id="input-anthropic-api-key"
                placeholder="sk-ant-…"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 200px;"
                onchange="saveBootSetting('anthropic_api_key', this.value)"
                oninput="clearTimeout(this._pa); var self=this; this._pa=setTimeout(function(){saveBootSetting('anthropic_api_key',self.value)},800)" />
            </div>
            <div class="setting-row">
              <div>
                <div class="setting-label">Claude Model</div>
                <div class="setting-desc">claude-3-5-sonnet for quality · claude-3-haiku for speed &amp; cost</div>
              </div>
              <input type="text" id="input-anthropic-model"
                placeholder="claude-3-5-sonnet-20241022"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 220px;"
                onchange="saveBootSetting('anthropic_model', this.value)"
                oninput="clearTimeout(this._pam); var self=this; this._pam=setTimeout(function(){saveBootSetting('anthropic_model',self.value)},800)" />
            </div>
          </div>

          <!-- ── Embedding Provider (always visible) ─────────── -->
          <div class="setting-section" style="margin-top:1.2rem">Embedding Provider <span class="boot-badge">Restart Required</span></div>

          <div class="setting-row">
            <div>
              <div class="setting-label">Embedding Provider</div>
              <div class="setting-desc">Source for vector embeddings used by semantic memory search</div>
            </div>
            <select id="select-embedding-provider"
              style="padding: 0.2rem 0.4rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); cursor: pointer;"
              onchange="onEmbeddingProviderChange(this.value)">
              <option value="auto">🔄 Auto (same as Text Provider)</option>
              <option value="gemini">🔵 Gemini</option>
              <option value="openai">🟢 OpenAI / Ollama</option>
            </select>
          </div>

          <!-- Anthropic + auto warning: shown when text=anthropic AND embed=auto -->
          <div id="anthropic-embed-warning" style="display:none;margin-top:0.5rem;padding:0.5rem 0.75rem;background:rgba(251,146,60,0.1);border:1px solid rgba(251,146,60,0.3);border-radius:6px;font-size:0.78rem;color:#fb923c;line-height:1.5">
            ⚠️ <strong>Anthropic has no native embedding API.</strong>
            Auto mode will route embeddings to <strong>Gemini</strong>.
            Set Embedding Provider to <strong>OpenAI / Ollama</strong> to use a local model (e.g. <code>nomic-embed-text</code>).
          </div>

          <!-- OpenAI embedding model field (shown when embedding_provider = openai) -->
          <div id="embed-fields-openai" style="display:none">
            <div class="setting-row">
              <div>
                <div class="setting-label">Embedding Model</div>
                <div class="setting-desc">Must output 768 dims. Ollama: nomic-embed-text · OpenAI: text-embedding-3-small</div>
              </div>
              <input type="text" id="input-openai-embedding-model"
                placeholder="text-embedding-3-small"
                style="padding: 0.2rem 0.5rem; background: var(--bg-hover); color: var(--text-primary); border: 1px solid var(--border-color); border-radius: 4px; font-size: 0.85rem; font-family: var(--font-mono); width: 210px;"
                onchange="saveBootSetting('openai_embedding_model', this.value)"
                oninput="clearTimeout(this._pe); var self=this; this._pe=setTimeout(function(){saveBootSetting('openai_embedding_model',self.value)},800)" />
            </div>
          </div>

          <div style="margin-top:1rem;padding:0.6rem 0.8rem;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.2);border-radius:6px;font-size:0.78rem;color:var(--text-secondary);line-height:1.5">
            💡 <strong>Cost-optimized setup:</strong> Text Provider → <code>Anthropic</code>, Embedding Provider → <code>OpenAI / Ollama</code>.<br>
            Use Claude 3.5 Sonnet for reasoning &amp; <code>nomic-embed-text</code> (free, local) for embeddings.
          </div>

          <span class="setting-saved" id="savedToastProviders">Saved ✓</span>
        </div><!-- /spanel-providers -->

        <!-- ─── Observability panel (v4.6.0 — OTel) ───────────────────────── -->
        <div class="s-tab-panel" id="spanel-observability">

          <div class="setting-section">OpenTelemetry (OTel)</div>

          <div class="setting-row" style="align-items: flex-start; margin-bottom: 1rem;">
            <div class="setting-desc" style="margin: 0;">
              Export distributed traces to
              <a href="https://www.jaegertracing.io" target="_blank" rel="noopener" style="color: var(--accent);">Jaeger</a>,
              <a href="https://grafana.com/oss/tempo/" target="_blank" rel="noopener" style="color: var(--accent);">Grafana Tempo</a>, or
              <a href="https://zipkin.io" target="_blank" rel="noopener" style="color: var(--accent);">Zipkin</a>.
              Provides a full latency waterfall for every MCP tool call, LLM provider hop, and background worker task.
              <br><br>
              <code style="font-size: 0.8rem; background: var(--bg-hover); padding: 2px 6px; border-radius: 4px;">
                docker run -d -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one
              </code>
              &nbsp;→ open <a href="http://localhost:16686" target="_blank" rel="noopener" style="color: var(--accent);">localhost:16686</a>
            </div>
          </div>

          <!-- Enable toggle -->
          <div class="setting-row">
            <div>
              <div class="setting-label">Enable OpenTelemetry</div>
              <div class="setting-desc">Activates the W3C tracing pipeline. <strong>Requires server restart.</strong></div>
            </div>
            <label class="toggle-switch">
              <input type="checkbox" id="input-otel-enabled"
                onchange="saveBootSetting('otel_enabled', this.checked ? 'true' : 'false')">
              <span class="slider"></span>
            </label>
          </div>

          <!-- OTLP endpoint -->
          <div class="setting-row">
            <div style="flex: 0 0 auto; min-width: 160px;">
              <div class="setting-label">OTLP HTTP Endpoint</div>
              <div class="setting-desc">Where spans are exported.</div>
            </div>
            <input type="text" id="input-otel-endpoint"
              class="setting-input"
              placeholder="http://localhost:4318/v1/traces"
              style="flex: 1;"
              onchange="saveBootSetting('otel_endpoint', this.value)"
              oninput="clearTimeout(this._pt); var self=this; this._pt=setTimeout(function(){saveBootSetting('otel_endpoint',self.value)},800)" />
          </div>

          <!-- Service name -->
          <div class="setting-row">
            <div style="flex: 0 0 auto; min-width: 160px;">
              <div class="setting-label">Service Name</div>
              <div class="setting-desc">Label shown in the trace UI.</div>
            </div>
            <input type="text" id="input-otel-service"
              class="setting-input"
              placeholder="prism-mcp-server"
              style="flex: 1;"
              onchange="saveBootSetting('otel_service_name', this.value)"
              oninput="clearTimeout(this._ps); var self=this; this._ps=setTimeout(function(){saveBootSetting('otel_service_name',self.value)},800)" />
          </div>

          <!-- Expected trace waterfall diagram -->
          <div class="setting-row" style="flex-direction: column; align-items: flex-start; margin-top: 0.5rem;">
            <div class="setting-label" style="margin-bottom: 0.5rem;">Expected Trace Waterfall</div>
            <pre style="font-size: 0.78rem; background: var(--bg-hover); padding: 0.8rem 1rem; border-radius: 6px; color: var(--text-secondary); line-height: 1.6; width: 100%; box-sizing: border-box; overflow-x: auto;">mcp.call_tool  [e.g. session_save_image, ~50 ms]
  └─ worker.vlm_caption          [~2–5 s, outlives parent ✓]
       └─ llm.generate_image_description  [~1–4 s]
       └─ llm.generate_embedding          [~200 ms]</pre>
          </div>

          <span class="setting-saved" id="savedToastOtel">Saved ✓</span>
        </div><!-- /spanel-observability -->


      </div>
    </div>
  </div>

  <!-- Fixed toast for cleanup feedback -->
  <div class="toast-fixed" id="fixedToast"></div>

  <script>
// ═══════════════════════════════════════════════════════════════════
// COMPATIBILITY RULE: This entire <script> block MUST use ES5 only.
//   - Use 'var' (NEVER 'const' or 'let')
//   - Use 'function(){}' (NEVER '=>' arrow functions)
//   - NO optional chaining '?.'
//   - NO template literals (backticks) — use string concatenation
//   - NO destructuring, spread, or other ES6+ syntax
// This HTML is served as a raw template literal; mixing ES6 in the
// inline script causes SyntaxError in some browser/context combos.
// ═══════════════════════════════════════════════════════════════════
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
// ─── TABS & SEARCH (v6.0) ───
// Fix 1: track whether a project has been successfully loaded
var projectLoaded = false;
function switchMainTab(tabId) {
    var tabs = ['project', 'search', 'factory', 'vm', 'marketplace', 'compliance'];
    tabs.forEach(function(t) {
        var btn = document.getElementById('mtab-' + t);
        if (btn) btn.classList.toggle('active', tabId === t);
    });
    // Fix 2: restore correct visibility when switching back to project tab;
    // setting display='' would let CSS display:none win, hiding loaded content.
    // Also hide welcome div when on non-project tabs so it doesn't bleed through.
    if (tabId === 'project') {
        document.getElementById('welcome').style.display = projectLoaded ? 'none' : '';
        document.getElementById('content').style.display = projectLoaded ? 'grid' : 'none';
    } else {
        document.getElementById('welcome').style.display = 'none';
        document.getElementById('content').style.display = 'none';
    }
    document.getElementById('search-content').style.display = tabId === 'search' ? 'block' : 'none';
    document.getElementById('factory-content').style.display = tabId === 'factory' ? 'block' : 'none';
    document.getElementById('vm-content').style.display = tabId === 'vm' ? 'block' : 'none';
    document.getElementById('marketplace-content').style.display = tabId === 'marketplace' ? 'block' : 'none';
    document.getElementById('compliance-content').style.display = tabId === 'compliance' ? 'block' : 'none';
    if (tabId === 'search') {
        document.getElementById('searchInput').focus();
    }
    if (tabId === 'factory') {
        loadPipelines();
    }
}
// ─── DARK FACTORY (v7.3) ───
var factoryPollTimer = null;
function loadPipelines() {
    var statusFilter = document.getElementById('factoryStatusFilter').value;
    var url = '/api/pipelines';
    if (statusFilter)
        url += '?status=' + encodeURIComponent(statusFilter);
    fetch(url)
        .then(function (r) { return r.json(); })
        .then(function (data) {
        var list = document.getElementById('factoryList');
        var count = document.getElementById('factoryCount');
        var pipelines = data.pipelines || [];
        count.textContent = pipelines.length + ' pipeline' + (pipelines.length !== 1 ? 's' : '');
        if (pipelines.length === 0) {
            list.innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted)"><div style="font-size:2rem;margin-bottom:0.5rem">🏭</div>No pipelines found. Use <code>session_start_pipeline</code> to create one.</div>';
            return;
        }
        var html = '<div style="display:flex;flex-direction:column;gap:0.5rem">';
        for (var i = 0; i < pipelines.length; i++) {
            var p = pipelines[i];
            var emoji = p.status === 'COMPLETED' ? '✅' : p.status === 'FAILED' ? '❌' : p.status === 'ABORTED' ? '🛑' : p.status === 'RUNNING' ? '⏳' : p.status === 'PENDING' ? '⏸' : '📋';
            var statusColor = p.status === 'COMPLETED' ? 'var(--accent-green)' : p.status === 'FAILED' ? 'var(--accent-rose)' : p.status === 'ABORTED' ? 'var(--accent-amber)' : p.status === 'RUNNING' ? 'var(--accent-purple)' : p.status === 'PENDING' ? 'var(--accent-blue, #3b82f6)' : 'var(--text-muted)';
            var isActive = p.status === 'RUNNING' || p.status === 'PENDING';
            var objective = (p.parsedSpec && p.parsedSpec.objective) ? p.parsedSpec.objective : '(unknown)';
            if (objective.length > 120)
                objective = objective.slice(0, 120) + '…';
            var maxIter = (p.parsedSpec && p.parsedSpec.maxIterations) ? p.parsedSpec.maxIterations : '?';
            html += '<div style="padding:0.75rem 1rem;background:rgba(15,23,42,0.6);border-radius:8px;border-left:3px solid ' + statusColor + ';">';
            html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.35rem">';
            html += '<span style="font-weight:600;color:var(--text-primary)">' + emoji + ' ' + p.status + '</span>';
            html += '<span style="font-size:0.7rem;font-family:var(--font-mono);color:var(--text-muted)">' + p.id.slice(0, 8) + '…</span>';
            html += '</div>';
            html += '<div style="font-size:0.82rem;color:var(--text-secondary);margin-bottom:0.35rem">' + escapeHtml(objective) + '</div>';
            html += '<div style="display:flex;gap:1rem;font-size:0.72rem;color:var(--text-muted);flex-wrap:wrap">';
            html += '<span>📁 ' + escapeHtml(p.project || '?') + '</span>';
            html += '<span>🔄 ' + p.iteration + ' / ' + maxIter + '</span>';
            html += '<span>📍 ' + escapeHtml(p.current_step || '?') + '</span>';
            html += '<span>🕐 ' + new Date(p.updated_at).toLocaleString() + '</span>';
            html += '</div>';
            if (p.error) {
                html += '<div style="font-size:0.72rem;color:var(--accent-rose);margin-top:0.35rem;padding:0.3rem 0.5rem;background:rgba(244,63,94,0.08);border-radius:4px">⚠ ' + escapeHtml(p.error.slice(0, 200)) + '</div>';
            }
            if (isActive) {
                html += '<div style="margin-top:0.5rem"><button onclick="abortPipeline(this.dataset.id)" data-id="' + p.id + '" class="cleanup-btn" style="font-size:0.72rem">🛑 Abort Pipeline</button></div>';
            }
            html += '</div>';
        }
        html += '</div>';
        list.innerHTML = html;
        // Auto-poll if any pipeline is running
        var hasActive = pipelines.some(function (p) { return p.status === 'RUNNING' || p.status === 'PENDING'; });
        clearInterval(factoryPollTimer);
        if (hasActive) {
            factoryPollTimer = setInterval(function () {
                if (document.getElementById('factory-content').style.display !== 'none')
                    loadPipelines();
                else
                    clearInterval(factoryPollTimer);
            }, 10000);
        }
    })
        .catch(function (err) {
        document.getElementById('factoryList').innerHTML = '<div style="color:var(--accent-rose);padding:1rem">Failed to load pipelines: ' + escapeHtml(err.message) + '</div>';
    });
}
function abortPipeline(id) {
    if (!confirm('Abort pipeline ' + id.slice(0, 8) + '…?'))
        return;
    fetch('/api/pipelines/' + id + '/abort', { method: 'POST' })
        .then(function (r) { return r.json(); })
        .then(function (data) {
        if (data.ok) {
            showToast('Pipeline aborted');
            loadPipelines();
        }
        else {
            showToast('Failed: ' + (data.error || 'Unknown error'));
        }
    })
        .catch(function (err) { showToast('Abort failed: ' + err.message); });
}
var searchTimeout = null;
var searchAbortController = null;
function performSearch() {
    return __awaiter(this, void 0, void 0, function () {
        function highlight(text) {
            var escaped = escapeHtml(text || '');
            if (termRegex) {
                escaped = escaped.replace(termRegex, '<mark style="background: rgba(168, 85, 247, 0.4); color: inherit; padding: 0 0.1rem; border-radius: 2px;">$1</mark>');
            }
            return escaped;
        }
        var input, boost, resultsDiv, query, project, url, res, data, queryTerms, termRegex, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    input = document.getElementById('searchInput');
                    boost = document.getElementById('searchContextBoost');
                    resultsDiv = document.getElementById('searchResults');
                    query = input.value.trim();
                    if (!query) {
                        if (searchAbortController)
                            searchAbortController.abort();
                        resultsDiv.innerHTML = '<div style="color:var(--text-muted); font-size:0.9rem; padding: 2rem; text-align:center;">Enter a query to search the neural ledger via embeddings...</div>';
                        return [2 /*return*/];
                    }
                    resultsDiv.innerHTML = '<div class="loading" style="padding:2rem;"><span class="spinner"></span> Searching neural memory via embeddings...</div>';
                    project = document.getElementById('projectSelect').value;
                    url = '/api/search?q=' + encodeURIComponent(query);
                    if (project)
                        url += '&project=' + encodeURIComponent(project);
                    if (boost.checked)
                        url += '&boost=true';
                    if (searchAbortController)
                        searchAbortController.abort();
                    searchAbortController = new AbortController();
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch(url, { signal: searchAbortController.signal })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    if (data.error)
                        throw new Error(data.error);
                    if (!data.results || data.results.length === 0) {
                        resultsDiv.innerHTML = '<div style="color:var(--text-muted); padding: 2rem; text-align:center;">No matching memories found for this query.</div>';
                        return [2 /*return*/];
                    }
                    queryTerms = query.split(/\\s+/).filter(function (w) { return w.length > 2; });
                    termRegex = queryTerms.length > 0
                        ? new RegExp('(' + queryTerms.map(function (w) { return w.replace(/[.*+?^$()|[\\]\\\\{}]/g, '\\\\$&'); }).join('|') + ')', 'gi')
                        : null;
                    resultsDiv.innerHTML = data.results.map(function (r) {
                        var isGraduated = r.importance >= 7;
                        var opacity = isGraduated ? 1 : 0.8;
                        var borderStyle = isGraduated ? 'border-left: 3px solid var(--accent-purple); padding-left: 0.8rem;' : '';
                        var decisionsHtml = '';
                        if (r.decisions && r.decisions.length > 0) {
                            decisionsHtml = '<ul class="tag-list" style="margin-top:0.75rem;">' +
                                r.decisions.map(function (d) { return '<li class="tag">💡 ' + highlight(d) + '</li>'; }).join('') +
                                '</ul>';
                        }
                        return '<div class="entry" style="opacity: ' + opacity + '; ' + borderStyle + '">' +
                            '<div class="entry-meta" style="justify-content:space-between; margin-bottom:0.5rem;">' +
                            '<span>📁 ' + escapeHtml(r.project) + ' • 🕒 ' + new Date(r.session_date || r.created_at || Date.now()).toLocaleDateString() + '</span>' +
                            '<div style="display:flex; gap:0.5rem; font-size:0.75rem;">' +
                            '<span class="badge" title="Similarity Score (Semantic Match)" style="background:rgba(6,182,212,0.1); color:var(--accent-cyan); border:1px solid rgba(6,182,212,0.3);">' +
                            '🎯 ' + (r.similarity * 100).toFixed(1) + '%' +
                            '</span>' +
                            '<span class="badge badge-purple" title="Ebbinghaus Importance (Recency/Reinforcement)">' +
                            '⭐ ' + (r.importance || 0).toFixed(1) +
                            '</span>' +
                            '</div>' +
                            '</div>' +
                            '<div class="entry-summary" style="font-size:0.9rem; line-height: 1.5;">' + highlight(r.summary) + '</div>' +
                            decisionsHtml +
                            '</div>';
                    }).join('');
                    return [3 /*break*/, 5];
                case 4:
                    err_1 = _a.sent();
                    if (err_1.name === 'AbortError')
                        return [2 /*return*/]; // Ignore aborted fetches
                    resultsDiv.innerHTML = '<div style="padding:1rem; color:var(--accent-rose);">❌ Failed to search memory: ' + escapeHtml(err_1.message) + '</div>';
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
var _searchInput = document.getElementById('searchInput');
if (_searchInput)
    _searchInput.addEventListener('input', function () {
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(performSearch, 300);
    });
var _searchBoost = document.getElementById('searchContextBoost');
if (_searchBoost)
    _searchBoost.addEventListener('change', performSearch);
// Role icon map
var ROLE_ICONS = { dev: '🛠️', qa: '🔍', pm: '📋', lead: '🏗️', security: '🔒', ux: '🎨', global: '🌐', cmo: '📢' };
// Load and render the identity chip from settings
function loadIdentityChip() {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, s, role, name, chip, icon, label, e_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/settings')];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    s = data.settings || {};
                    role = s.default_role || '';
                    name = s.agent_name || '';
                    chip = document.getElementById('identityChip');
                    if (!chip)
                        return [2 /*return*/];
                    if (role && role !== 'global' || name) {
                        icon = ROLE_ICONS[role] || '🤖';
                        label = name ? (role && role !== 'global' ? role + ' · ' + name : name) : role;
                        chip.innerHTML = '<span class="role-icon">' + icon + '</span><span class="identity-label">' + escapeHtml(label) + '</span>';
                        chip.style.display = 'flex';
                    }
                    else {
                        chip.style.display = 'none';
                    }
                    return [3 /*break*/, 4];
                case 3:
                    e_1 = _a.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// Auto-load project list on page load
(function () {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, select, gp, e_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/projects')];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    select = document.getElementById('projectSelect');
                    if (data.projects && data.projects.length > 0) {
                        select.innerHTML = '<option value="">— Select a project —</option>' +
                            data.projects.map(function (p) { return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>'; }).join('');
                        
                        // v7.5.0: Background fetch intent health to add global traffic-light dots
                        // Fetch sequentially to prevent SQLite WAL saturation with N concurrent loadContext calls
                        var pIndex = 0;
                        function fetchNextHealth() {
                            if (pIndex >= data.projects.length) return;
                            var p = data.projects[pIndex++];
                            fetch('/api/intent-health?project=' + encodeURIComponent(p))
                                .then(function (res) { return res.json(); })
                                .then(function (hData) {
                                    if (hData && typeof hData.score === 'number') {
                                        var icon = hData.score >= 80 ? "🟢" : (hData.score >= 50 ? "🟡" : "🔴");
                                        var opt = null;
                                        for (var oi = 0; oi < select.options.length; oi++) {
                                            if (select.options[oi].value === p) { opt = select.options[oi]; break; }
                                        }
                                        if (opt) opt.textContent = icon + " " + p;
                                    }
                                    fetchNextHealth();
                                }).catch(function () { fetchNextHealth(); });
                        }
                        if (data.projects && data.projects.length > 0) {
                            fetchNextHealth();
                        }

                        gp = document.getElementById('graphProjectFilter');
                        if (gp) {
                            gp.innerHTML = '<option value="">All Projects</option>' +
                                data.projects.map(function (p) { return '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '</option>'; }).join('');
                        }
                        // Restore last selected project from localStorage
                        var lastProject = localStorage.getItem('prism_last_project');
                        if (lastProject && data.projects.indexOf(lastProject) !== -1) {
                            select.value = lastProject;
                            loadProject();
                        }
                    }
                    else {
                        select.innerHTML = '<option value="">No projects found</option>';
                    }
                    return [3 /*break*/, 4];
                case 3:
                    e_2 = _a.sent();
                    document.getElementById('projectSelect').innerHTML = '<option value="">Error loading projects</option>';
                    return [3 /*break*/, 4];
                case 4:
                    // Load identity chip once settings are available
                    loadIdentityChip();
                    return [2 /*return*/];
            }
        });
    });
})();
function loadProject() {
    return __awaiter(this, void 0, void 0, function () {
        var project, res, data, ctx, todos, todoList, meta, briefingCard, visualCard, visuals, historyEl, ledgerEl, healthRes, healthData, healthCard, healthDot, healthLabel, healthSummary, healthIssues, statusMap, t, issues, cleanupBtn, sevIcons, he_1, e_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project) {
                        var hc = document.getElementById('intentHealthCard');
                        if (hc) hc.style.display = 'none';
                        var welcomeEl = document.getElementById('welcome');
                        var contentEl = document.getElementById('content');
                        if (contentEl) contentEl.style.display = 'none';
                        if (welcomeEl) welcomeEl.style.display = 'flex';
                        return [2 /*return*/];
                    }
                    // Persist last selected project
                    try { localStorage.setItem('prism_last_project', project); } catch(e) {}
                    document.getElementById('welcome').style.display = 'none';
                    document.getElementById('content').style.display = 'none';
                    document.getElementById('loading').style.display = 'block';
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 9, 10, 11]);
                    return [4 /*yield*/, fetch('/api/project?name=' + encodeURIComponent(project))];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    ctx = data.context || {};
                    document.getElementById('versionBadge').textContent = 'v' + (ctx.version || '?');
                    document.getElementById('summary').textContent = ctx.last_summary || ctx.summary || 'No summary available.';
                    todos = ctx.pending_todo || ctx.active_context || [];
                    todoList = document.getElementById('todos');
                    if (Array.isArray(todos) && todos.length > 0) {
                        todoList.innerHTML = todos.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('');
                    }
                    else {
                        todoList.innerHTML = '<li style="color:var(--text-muted)">No pending TODOs</li>';
                    }
                    meta = ctx.metadata || {};
                    document.getElementById('gitBranch').textContent = meta.git_branch || ctx.active_branch || '—';
                    document.getElementById('gitSha').textContent = meta.last_commit_sha ? meta.last_commit_sha.substring(0, 12) : '—';
                    document.getElementById('keyContext').textContent = ctx.key_context || '—';
                    briefingCard = document.getElementById('briefingCard');
                    if (meta.morning_briefing) {
                        document.getElementById('briefingText').textContent = meta.morning_briefing;
                        briefingCard.style.display = 'block';
                    }
                    else {
                        briefingCard.style.display = 'none';
                    }
                    visualCard = document.getElementById('visualCard');
                    visuals = meta.visual_memory || [];
                    if (visuals.length > 0) {
                        document.getElementById('visualList').innerHTML = visuals.map(function (v) {
                            var dateStr = v.timestamp ? v.timestamp.split('T')[0] : '';
                            return '<li><span class="visual-id">[' + escapeHtml(v.id) + ']</span> ' +
                                escapeHtml(v.description) +
                                '<span class="visual-date">' + dateStr + '</span></li>';
                        }).join('');
                        visualCard.style.display = 'block';
                    }
                    else {
                        visualCard.style.display = 'none';
                    }
                    historyEl = document.getElementById('historyTimeline');
                    if (data.history && data.history.length > 0) {
                        historyEl.innerHTML = data.history.map(function (h) {
                            var snap = h.snapshot || {};
                            var summary = snap.last_summary || snap.summary || 'Snapshot';
                            return '<div class="timeline-item history">' +
                                '<div class="meta"><span class="badge badge-purple">v' + escapeHtml(h.version) + '</span>' +
                                '<span>' + formatDate(h.created_at) + '</span></div>' +
                                escapeHtml(summary) + '</div>';
                        }).join('');
                    }
                    else {
                        historyEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem;text-align:center">No time travel history yet.</div>';
                    }
                    ledgerEl = document.getElementById('ledgerTimeline');
                    if (data.ledger && data.ledger.length > 0) {
                        ledgerEl.innerHTML = data.ledger.map(function (l) {
                            var summary = l.summary || l.content || 'Entry';
                            var decisions = l.decisions;
                            var extra = '';
                            if (decisions && decisions.length > 0) {
                                try {
                                    var parsed = typeof decisions === 'string' ? JSON.parse(decisions) : decisions;
                                    if (Array.isArray(parsed) && parsed.length > 0) {
                                        extra = '<div style="margin-top:0.3rem;font-size:0.75rem;color:var(--accent-cyan)">Decisions: ' + parsed.map(function(d) { return escapeHtml(d); }).join(', ') + '</div>';
                                    }
                                }
                                catch (e) { }
                            }
                            return '<div class="timeline-item">' +
                                '<div class="meta"><span class="badge badge-amber">session</span>' +
                                '<span>' + formatDate(l.created_at) + '</span></div>' +
                                escapeHtml(summary) + extra + '</div>';
                        }).join('');
                    }
                    else {
                        ledgerEl.innerHTML = '<div style="color:var(--text-muted);font-size:0.85rem;padding:1rem;text-align:center">No ledger entries yet.</div>';
                    }
                    _a.label = 4;
                case 4:
                    _a.trys.push([4, 7, , 8]);
                    return [4 /*yield*/, fetch('/api/health')];
                case 5:
                    healthRes = _a.sent();
                    return [4 /*yield*/, healthRes.json()];
                case 6:
                    healthData = _a.sent();
                    healthCard = document.getElementById('healthCard');
                    healthDot = document.getElementById('healthDot');
                    healthLabel = document.getElementById('healthLabel');
                    healthSummary = document.getElementById('healthSummary');
                    healthIssues = document.getElementById('healthIssues');
                    // Set the dot color based on status
                    healthDot.className = 'health-dot ' + (healthData.status || 'unknown');
                    statusMap = { healthy: '✅ Healthy', degraded: '⚠️ Degraded', unhealthy: '🔴 Unhealthy' };
                    healthLabel.textContent = statusMap[healthData.status] || '❓ Unknown';
                    t = healthData.totals || {};
                    healthSummary.textContent = (t.activeEntries || 0) + ' entries · ' +
                        (t.handoffs || 0) + ' handoffs · ' +
                        (t.rollups || 0) + ' rollups' +
                        (t.crdtMerges ? ' · 🔄 ' + t.crdtMerges + ' merges' : '');
                    issues = healthData.issues || [];
                    cleanupBtn = document.getElementById('cleanupBtn');
                    if (issues.length > 0) {
                        sevIcons = { error: '🔴', warning: '🟡', info: '🔵' };
                        healthIssues.innerHTML = issues.map(function (i) {
                            return '<div class="issue-row">' +
                                '<span>' + (sevIcons[i.severity] || '❓') + '</span>' +
                                '<span>' + escapeHtml(i.message) + '</span>' +
                                '</div>';
                        }).join('');
                        if (cleanupBtn)
                            cleanupBtn.style.display = 'inline-block';
                    }
                    else {
                        healthIssues.innerHTML = '<div style="color:var(--accent-green);font-size:0.8rem">🎉 No issues found</div>';
                        if (cleanupBtn)
                            cleanupBtn.style.display = 'none';
                    }
                    healthCard.style.display = 'block';
                    return [3 /*break*/, 8];
                case 7:
                    he_1 = _a.sent();
                    // Health check not available — silently skip
                    console.warn('Health check unavailable:', he_1);
                    return [3 /*break*/, 8];
                case 8:
                    document.getElementById('content').className = 'grid grid-main fade-in';
                    document.getElementById('content').style.display = 'grid';
                    projectLoaded = true; // Fix 3: mark project as loaded for tab-switch restore
                    
                    // Feature A: Run Intent Health Fetch
                    fetchIntentHealth(project);
                    
                    // v3.1: Analytics + Lifecycle Controls + Import
                    document.getElementById('analyticsCard').style.display = 'block';
                    document.getElementById('lifecycleCard').style.display = 'block';
                    document.getElementById('importCard').style.display = 'block';
                    loadAnalytics(project);
                    loadRetention(project);
                    loadTeam(); // v3.0: auto-load Hivemind team
                    return [3 /*break*/, 11];
                case 9:
                    e_3 = _a.sent();
                    alert('Failed to load project data: ' + e_3.message);
                    return [3 /*break*/, 11];
                case 10:
                    document.getElementById('loading').style.display = 'none';
                    return [7 /*endfinally*/];
                case 11: return [2 /*return*/];
            }
        });
    });
}
// ─── v3.1: Memory Analytics ───────────────────────────────────────────────
function loadAnalytics(project) {
    return __awaiter(this, void 0, void 0, function () {
        var res, d, sparkEl, days, maxCount, e_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/analytics?project=' + encodeURIComponent(project))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    d = _a.sent();
                    document.getElementById('astat-entries').textContent = (d.totalEntries || 0);
                    document.getElementById('astat-rollups').textContent = (d.totalRollups || 0);
                    document.getElementById('astat-savings').textContent = (d.rollupSavings || 0);
                    document.getElementById('astat-avglen').textContent = Math.round(d.avgSummaryLength || 0);
                    sparkEl = document.getElementById('sparkline');
                    days = d.sessionsByDay || [];
                    if (days.length === 0) {
                        // Pad with 14 zero days
                        days = Array.from({ length: 14 }, function (_, i) {
                            var dt = new Date();
                            dt.setDate(dt.getDate() - (13 - i));
                            return { date: dt.toISOString().slice(0, 10), count: 0 };
                        });
                    }
                    maxCount = Math.max.apply(null, days.map(function (x) { return x.count || 0; })) || 1;
                    sparkEl.innerHTML = days.slice(-14).map(function (d) {
                        var pct = Math.max(4, Math.round(((d.count || 0) / maxCount) * 100));
                        return '<div class="spark-bar" style="height:' + pct + '%" title="' + d.date + ': ' + d.count + '"></div>';
                    }).join('');
                    return [3 /*break*/, 4];
                case 3:
                    e_4 = _a.sent();
                    console.warn('Analytics load failed:', e_4);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ─── v3.1: TTL Retention ───────────────────────────────────────────────
function loadRetention(project) {
    return __awaiter(this, void 0, void 0, function () {
        var res, d, inp, e_5;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/retention?project=' + encodeURIComponent(project))];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    d = _a.sent();
                    inp = document.getElementById('ttlInput');
                    if (inp)
                        inp.value = d.ttl_days || 0;
                    return [3 /*break*/, 4];
                case 3:
                    e_5 = _a.sent();
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function saveTTL() {
    return __awaiter(this, void 0, void 0, function () {
        var project, days, res, d, e_6;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project)
                        return [2 /*return*/];
                    days = parseInt(document.getElementById('ttlInput').value, 10) || 0;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch('/api/retention', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project: project, ttl_days: days })
                        })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    d = _a.sent();
                    if (d.ok) {
                        showToast(days > 0 ? '✓ TTL saved: ' + days + 'd (expired ' + (d.expired || 0) + ')' : '✓ TTL disabled');
                    }
                    else {
                        showToast('❌ ' + (d.error || 'Save failed'), true);
                    }
                    return [3 /*break*/, 5];
                case 4:
                    e_6 = _a.sent();
                    showToast('❌ Cannot save TTL', true);
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// ─── v3.1: Compact Now ───────────────────────────────────────────────
function compactNow() {
    return __awaiter(this, void 0, void 0, function () {
        var project, btn, res, d, e_7;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project)
                        return [2 /*return*/];
                    btn = document.getElementById('compactBtn');
                    btn.disabled = true;
                    btn.textContent = '🗜️ Compacting...';
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/compact', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project: project })
                        })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    d = _a.sent();
                    if (d.ok) {
                        showToast('✓ Compaction done');
                        loadAnalytics(project); // refresh stats
                    }
                    else {
                        showToast('❌ Compaction failed', true);
                    }
                    return [3 /*break*/, 6];
                case 4:
                    e_7 = _a.sent();
                    showToast('❌ ' + e_7.message, true);
                    return [3 /*break*/, 6];
                case 5:
                    btn.disabled = false;
                    btn.textContent = '🗜️ Compact Now';
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// ─── v3.1: PKM Export (Obsidian / Logseq ZIP) ───────────────────────
// ── Shared export progress helpers ─────────────────────────────────
// Export uses fetch+blob so we can show a building bar during ZIP generation.
// Estimated time ~5-15s for most projects (fflate in-memory); staged accordingly.
function startExportProgress(isVault) {
    var wrap = document.getElementById('exportProgressWrap');
    var bar = document.getElementById('exportProgressBar');
    var pct = document.getElementById('exportProgressPct');
    var stage = document.getElementById('exportProgressStage');
    if (wrap)
        wrap.style.display = 'block';
    var stages = isVault
        ? [
            { pct: 10, label: 'Fetching ledger entries…', ms: 500 },
            { pct: 30, label: 'Rendering Markdown files…', ms: 2000 },
            { pct: 55, label: 'Building Wikilink index…', ms: 4000 },
            { pct: 75, label: 'Compressing vault ZIP…', ms: 7000 },
            { pct: 88, label: 'Finalizing archive…', ms: 11000 },
        ]
        : [
            { pct: 15, label: 'Fetching project data…', ms: 500 },
            { pct: 50, label: 'Building archive…', ms: 2000 },
            { pct: 80, label: 'Compressing ZIP…', ms: 5000 },
            { pct: 92, label: 'Finalizing…', ms: 9000 },
        ];
    var timers = stages.map(function (s) {
        return setTimeout(function () {
            if (bar)
                bar.style.width = s.pct + '%';
            if (pct)
                pct.textContent = s.pct + '%';
            if (stage)
                stage.textContent = s.label;
        }, s.ms);
    });
    return timers;
}
function finishExportProgress(timers, ok) {
    timers.forEach(function (t) { clearTimeout(t); });
    var bar = document.getElementById('exportProgressBar');
    var pct = document.getElementById('exportProgressPct');
    var stage = document.getElementById('exportProgressStage');
    var wrap = document.getElementById('exportProgressWrap');
    if (bar)
        bar.classList.add('done');
    if (bar)
        bar.style.width = '100%';
    if (pct)
        pct.textContent = '100%';
    if (stage)
        stage.textContent = ok ? '✅ Ready — downloading…' : '❌ Export failed';
    setTimeout(function () {
        if (wrap)
            wrap.style.display = 'none';
        if (bar) {
            bar.classList.remove('done');
            bar.style.width = '0%';
        }
        if (pct)
            pct.textContent = '0%';
        if (stage)
            stage.textContent = 'Building archive…';
    }, 2200);
}
// ── v3.1: PKM Export (ZIP) ────────────────────────────────────────
function exportPKM() {
    return __awaiter(this, void 0, void 0, function () {
        var project, btn, timers, res, blob, url, a, e_8;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project)
                        return [2 /*return*/];
                    btn = document.getElementById('exportBtn');
                    btn.disabled = true;
                    btn.textContent = '📦 Building…';
                    timers = startExportProgress(false);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/export?project=' + encodeURIComponent(project))];
                case 2:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error('Server error ' + res.status);
                    return [4 /*yield*/, res.blob()];
                case 3:
                    blob = _a.sent();
                    finishExportProgress(timers, true);
                    url = URL.createObjectURL(blob);
                    a = document.createElement('a');
                    a.href = url;
                    a.download = 'prism-vault-' + project + '.zip';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
                    showToast('↓ Download started');
                    return [3 /*break*/, 6];
                case 4:
                    e_8 = _a.sent();
                    finishExportProgress(timers, false);
                    showToast('❌ Export failed', true);
                    return [3 /*break*/, 6];
                case 5:
                    btn.disabled = false;
                    btn.textContent = '📦 Export ZIP';
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// ── v6.1: Vault Export (Prism-Port) ────────────────────────────
function exportVault() {
    return __awaiter(this, void 0, void 0, function () {
        var project, btn, timers, res, blob, url, a, e_9;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project)
                        return [2 /*return*/];
                    btn = document.getElementById('exportVaultBtn');
                    btn.disabled = true;
                    btn.textContent = '🏛️ Building…';
                    timers = startExportProgress(true);
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/export/vault?project=' + encodeURIComponent(project))];
                case 2:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error('Server error ' + res.status);
                    return [4 /*yield*/, res.blob()];
                case 3:
                    blob = _a.sent();
                    finishExportProgress(timers, true);
                    url = URL.createObjectURL(blob);
                    a = document.createElement('a');
                    a.href = url;
                    a.download = 'prism-vault-' + project + '.zip';
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    setTimeout(function () { URL.revokeObjectURL(url); }, 10000);
                    showToast('↓ Vault download started — open in Obsidian or Logseq');
                    return [3 /*break*/, 6];
                case 4:
                    e_9 = _a.sent();
                    finishExportProgress(timers, false);
                    showToast('❌ Vault export failed', true);
                    return [3 /*break*/, 6];
                case 5:
                    btn.disabled = false;
                    btn.textContent = '🏛️ Export Vault';
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// ─── v5.2: Universal History Import ───────────────────────────────
// Track the picked file for upload mode
var _importPickedFile = null;
document.getElementById('importFileInput').addEventListener('change', function (e) {
    var file = e.target.files[0];
    if (!file)
        return;
    _importPickedFile = file;
    var pathInput = document.getElementById('importPath');
    pathInput.value = file.name;
    document.getElementById('importClearBtn').style.display = 'inline-flex';
    var infoEl = document.getElementById('importFileInfo');
    var sizeKB = (file.size / 1024).toFixed(1);
    var sizeMB = (file.size / (1024 * 1024)).toFixed(1);
    infoEl.textContent = '📄 ' + file.name + ' (' + (file.size > 1048576 ? sizeMB + ' MB' : sizeKB + ' KB') + ')';
    infoEl.style.display = 'block';
    // Auto-detect format from extension
    var fmt = document.getElementById('importFormat');
    if (file.name.endsWith('.jsonl') || file.name.endsWith('.ndjson')) {
        fmt.value = 'claude';
    }
    else if (file.name.toLowerCase().includes('gemini')) {
        fmt.value = 'gemini';
    }
    else if (file.name.toLowerCase().includes('openai') || file.name.toLowerCase().includes('chatgpt')) {
        fmt.value = 'openai';
    }
    else {
        fmt.value = '';
    }
});
function clearImportFile() {
    _importPickedFile = null;
    document.getElementById('importPath').value = '';
    document.getElementById('importFileInput').value = '';
    document.getElementById('importClearBtn').style.display = 'none';
    document.getElementById('importFileInfo').style.display = 'none';
    document.getElementById('importResult').style.display = 'none';
    document.getElementById('importFormat').value = '';
}
function runImport(dryRun) {
    return __awaiter(this, void 0, void 0, function () {
        function setImportProgress(pct, label) {
            if (progBar)
                progBar.style.width = pct + '%';
            if (progPct)
                progPct.textContent = pct + '%';
            if (progStage)
                progStage.textContent = label;
        }
        function finishImportProgress(ok, label) {
            timers.forEach(function (t) { clearTimeout(t); });
            if (progBar)
                progBar.classList.add('done');
            setImportProgress(100, ok ? '✅ ' + (label || 'Done') : '❌ ' + (label || 'Failed'));
            setTimeout(function () {
                if (progWrap)
                    progWrap.style.display = 'none';
                if (progBar) {
                    progBar.classList.remove('done');
                    progBar.style.width = '0%';
                }
                if (progPct)
                    progPct.textContent = '0%';
                if (progStage)
                    progStage.textContent = 'Reading file…';
            }, 2500);
        }
        var filePath, format, project, importBtn, dryBtn, resultEl, progWrap, progBar, progPct, progStage, activeBtn, origText, fileSize, estMs, importStages, timers, endpoint, body, headers, content, res, d, e_10;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    filePath = document.getElementById('importPath').value.trim();
                    if (!filePath && !_importPickedFile) {
                        showToast('❌ Pick a file or enter a path', true);
                        return [2 /*return*/];
                    }
                    format = document.getElementById('importFormat').value || undefined;
                    project = document.getElementById('importProject').value.trim() || undefined;
                    importBtn = document.getElementById('importBtn');
                    dryBtn = document.getElementById('importDryBtn');
                    resultEl = document.getElementById('importResult');
                    progWrap = document.getElementById('importProgressWrap');
                    progBar = document.getElementById('importProgressBar');
                    progPct = document.getElementById('importProgressPct');
                    progStage = document.getElementById('importProgressStage');
                    importBtn.disabled = true;
                    dryBtn.disabled = true;
                    activeBtn = dryRun ? dryBtn : importBtn;
                    origText = activeBtn.innerHTML;
                    activeBtn.innerHTML = dryRun ? '🔄 Validating…' : '🔄 Importing…';
                    // Hide old result, show progress bar
                    resultEl.style.display = 'none';
                    if (progWrap)
                        progWrap.style.display = 'block';
                    fileSize = _importPickedFile ? _importPickedFile.size : 0;
                    estMs = fileSize > 5 * 1024 * 1024 ? 90000
                        : fileSize > 500 * 1024 ? 30000
                            : 10000;
                    importStages = dryRun
                        ? [
                            { pct: 20, label: 'Parsing file structure…', ms: Math.round(estMs * 0.1) },
                            { pct: 55, label: 'Validating conversation turns…', ms: Math.round(estMs * 0.35) },
                            { pct: 80, label: 'Checking for duplicates…', ms: Math.round(estMs * 0.65) },
                            { pct: 92, label: 'Generating preview…', ms: Math.round(estMs * 0.85) },
                        ]
                        : [
                            { pct: 10, label: 'Reading file…', ms: Math.round(estMs * 0.05) },
                            { pct: 25, label: 'Parsing conversation turns…', ms: Math.round(estMs * 0.15) },
                            { pct: 45, label: 'Deduplicating entries…', ms: Math.round(estMs * 0.35) },
                            { pct: 65, label: 'Writing to ledger…', ms: Math.round(estMs * 0.55) },
                            { pct: 82, label: 'Indexing keywords (FTS5)…', ms: Math.round(estMs * 0.72) },
                            { pct: 91, label: 'Generating embeddings…', ms: Math.round(estMs * 0.85) },
                        ];
                    timers = importStages.map(function (s) {
                        return setTimeout(function () { setImportProgress(s.pct, s.label); }, s.ms);
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 7, 8, 9]);
                    if (!_importPickedFile) return [3 /*break*/, 3];
                    return [4 /*yield*/, _importPickedFile.text()];
                case 2:
                    content = _a.sent();
                    endpoint = '/api/import-upload';
                    headers = { 'Content-Type': 'application/json' };
                    body = JSON.stringify({
                        filename: _importPickedFile.name,
                        content: content,
                        format: format,
                        project: project,
                        dryRun: dryRun
                    });
                    return [3 /*break*/, 4];
                case 3:
                    endpoint = '/api/import';
                    headers = { 'Content-Type': 'application/json' };
                    body = JSON.stringify({ path: filePath, format: format, project: project, dryRun: dryRun });
                    _a.label = 4;
                case 4: return [4 /*yield*/, fetch(endpoint, { method: 'POST', headers: headers, body: body })];
                case 5:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 6:
                    d = _a.sent();
                    if (res.ok && d.ok) {
                        finishImportProgress(true, dryRun ? 'Validation complete' : 'Import complete');
                        resultEl.style.display = 'block';
                        resultEl.style.background = 'rgba(16,185,129,0.1)';
                        resultEl.style.border = '1px solid rgba(16,185,129,0.25)';
                        resultEl.style.color = 'var(--accent-green)';
                        resultEl.innerHTML = '✅ ' + escapeHtml(d.message) +
                            '<div style="margin-top:0.4rem;font-size:0.75rem;color:var(--text-muted)">' +
                            'Conversations: ' + (d.conversationCount || 0) + ' · Turns: ' + (d.successCount || 0) +
                            (d.skipCount ? ' · Skipped: ' + d.skipCount : '') +
                            (d.failCount ? ' · Failed: ' + d.failCount : '') + '</div>';
                        if (!dryRun) {
                            showToast('✓ Import complete');
                            loadProject();
                        }
                    }
                    else {
                        finishImportProgress(false, d.error || 'Import failed');
                        resultEl.style.display = 'block';
                        resultEl.style.background = 'rgba(244,63,94,0.1)';
                        resultEl.style.border = '1px solid rgba(244,63,94,0.25)';
                        resultEl.style.color = 'var(--accent-rose)';
                        resultEl.innerHTML = '❌ ' + escapeHtml(d.error || 'Import failed');
                    }
                    return [3 /*break*/, 9];
                case 7:
                    e_10 = _a.sent();
                    finishImportProgress(false, e_10.message);
                    resultEl.style.display = 'block';
                    resultEl.style.background = 'rgba(244,63,94,0.1)';
                    resultEl.style.border = '1px solid rgba(244,63,94,0.25)';
                    resultEl.style.color = 'var(--accent-rose)';
                    resultEl.innerHTML = '❌ ' + escapeHtml(e_10.message);
                    return [3 /*break*/, 9];
                case 8:
                    importBtn.disabled = false;
                    dryBtn.disabled = false;
                    activeBtn.innerHTML = origText;
                    return [7 /*endfinally*/];
                case 9: return [2 /*return*/];
            }
        });
    });
}
function showToast(msg, isErr) {
    var el = document.getElementById('fixedToast');
    if (!el)
        return;
    el.textContent = msg;
    el.style.borderColor = isErr ? 'rgba(244,63,94,0.4)' : 'var(--border-glow)';
    el.style.color = isErr ? 'var(--accent-rose)' : 'var(--text-primary)';
    el.classList.add('show');
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove('show'); }, 3000);
}
function escapeHtml(str) {
    if (!str)
        return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function formatDate(isoStr) {
    if (!isoStr)
        return '';
    try {
        var d = new Date(isoStr);
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
            d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    }
    catch (e) {
        return isoStr;
    }
}
// Allow Enter key in select to trigger load
document.getElementById('projectSelect').addEventListener('change', loadProject);
// ─── v6.2: Decay View State ───
var _decayViewActive = false;
function toggleDecayView() {
    _decayViewActive = !_decayViewActive;
    var btn = document.getElementById('decayToggle');
    if (btn) {
        btn.style.background = _decayViewActive ? 'rgba(139,92,246,0.25)' : 'transparent';
        btn.style.color = _decayViewActive ? 'var(--accent-purple)' : 'var(--text-secondary)';
        btn.style.borderColor = _decayViewActive ? 'var(--accent-purple)' : 'rgba(139,92,246,0.3)';
    }
    loadGraph();
}
/**
 * Compute decay color for a node.
 * Fresh (0 days) → bright green (#10b981)
 * Stale (30+ days) → dim gray (#334155)
 * Graduated nodes (importance >= 7) stay vibrant purple regardless of age.
 */
function getDecayColor(daysSince, decayedImportance, group, baseImportance) {
    // Graduated nodes: always vibrant (check BASE importance, not decayed)
    if (baseImportance !== null && baseImportance !== undefined && baseImportance >= 7) {
        return { bg: '#8b5cf6', border: '#7c3aed', fontColor: '#f1f5f9' };
    }
    // Clamp days to 0-60 range for interpolation
    var d = Math.min(60, Math.max(0, daysSince || 0));
    var t = d / 60; // 0 = fresh, 1 = stale
    // Interpolate: green → amber → gray
    var r, g, b;
    if (t < 0.5) {
        // green (#10b981) → amber (#f59e0b)
        var tt = t * 2;
        r = Math.round(16 + (245 - 16) * tt);
        g = Math.round(185 + (158 - 185) * tt);
        b = Math.round(129 + (11 - 129) * tt);
    }
    else {
        // amber (#f59e0b) → gray (#334155)
        var tt = (t - 0.5) * 2;
        r = Math.round(245 + (51 - 245) * tt);
        g = Math.round(158 + (65 - 158) * tt);
        b = Math.round(11 + (85 - 11) * tt);
    }
    var hex = '#' + [r, g, b].map(function (c) { return c.toString(16).padStart(2, '0'); }).join('');
    var fontBrightness = (t < 0.7) ? '#0f172a' : '#94a3b8';
    return { bg: hex, border: hex, fontColor: fontBrightness };
}
// ─── Neural Graph (v2.3.0 / v5.1 / v6.2 Decay Heatmap) ───
function loadGraph() {
    return __awaiter(this, void 0, void 0, function () {
        var container, proj, days, imp, qs, url, res, data, dens, graduatedNodes, denPercentage, dens, MAX_NODES, priority, kept, options, network, allNodes, allEdges, isFiltered, graphTitle, statsSpan, projectCount, kwCount, e_11;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    container = document.getElementById('network-container');
                    if (!container)
                        return [2 /*return*/];
                    proj = document.getElementById('graphProjectFilter') ? document.getElementById('graphProjectFilter').value : '';
                    days = document.getElementById('graphDaysFilter') ? document.getElementById('graphDaysFilter').value : '';
                    imp = document.getElementById('graphImportanceFilter') ? document.getElementById('graphImportanceFilter').value : '';
                    qs = [];
                    if (proj)
                        qs.push('project=' + encodeURIComponent(proj));
                    if (days)
                        qs.push('days=' + encodeURIComponent(days));
                    if (imp)
                        qs.push('min_importance=' + encodeURIComponent(imp));
                    url = '/api/graph' + (qs.length ? '?' + qs.join('&') : '');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch(url)];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    // Empty state — no ledger entries yet
                    if (data.nodes.length === 0) {
                        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted);font-size:0.85rem">No knowledge associations found yet.</div>';
                        dens = document.getElementById('densityStatContainer');
                        if (dens)
                            dens.style.display = 'none';
                        return [2 /*return*/];
                    }
                    graduatedNodes = data.nodes.filter(function (n) { return (n.value || 0) >= 7; }).length;
                    denPercentage = Math.round((graduatedNodes / data.nodes.length) * 100);
                    dens = document.getElementById('densityStatContainer');
                    if (dens) {
                        dens.style.display = 'block';
                        dens.innerHTML = '<strong>Memory Density:</strong> ' + denPercentage + '% <span title="Ratio of Highly-Reinforced (Graduated) knowledge vs raw concepts" style="cursor:help">🧠</span> (' + graduatedNodes + ' / ' + data.nodes.length + ' ideas graduated)';
                    }
                    MAX_NODES = 200;
                    if (data.nodes.length > MAX_NODES) {
                        priority = { project: 0, category: 1, keyword: 2 };
                        data.nodes.sort(function (a, b) { return (priority[a.group] || 9) - (priority[b.group] || 9); });
                        kept = new Set(data.nodes.slice(0, MAX_NODES).map(function (n) { return n.id; }));
                        data.nodes = data.nodes.slice(0, MAX_NODES);
                        data.edges = data.edges.filter(function (e) { return kept.has(e.from) && kept.has(e.to); });
                    }
                    // ── v6.2: Apply decay heatmap coloring when toggle is active ──
                    if (_decayViewActive) {
                        data.nodes.forEach(function (n) {
                            var dc = getDecayColor(n.days_since_access, n.decayed_importance, n.group, n.base_importance);
                            n.color = { background: dc.bg, border: dc.border };
                            n.font = { color: dc.fontColor, face: 'Inter', size: n.group === 'project' ? 14 : (n.group === 'category' ? 12 : 10) };
                            // Add decay tooltip
                            var daysText = (n.days_since_access !== null && n.days_since_access !== undefined)
                                ? n.days_since_access + 'd ago'
                                : 'unknown';
                            var decayText = (n.decayed_importance !== null && n.decayed_importance !== undefined)
                                ? ' · importance: ' + n.decayed_importance
                                : '';
                            n.title = n.label + ' (' + daysText + decayText + ')';
                        });
                    }
                    options = {
                        nodes: {
                            shape: 'dot',
                            borderWidth: 0,
                            font: { color: '#94a3b8', face: 'Inter', size: 12 }
                        },
                        edges: {
                            width: 1,
                            color: { color: 'rgba(139,92,246,0.15)', highlight: '#8b5cf6' },
                            smooth: { type: 'continuous' }
                        },
                        groups: {
                            project: {
                                color: { background: '#8b5cf6', border: '#7c3aed' },
                                size: 20,
                                font: { size: 14, color: '#f1f5f9', face: 'Inter' }
                            },
                            category: {
                                color: { background: '#06b6d4', border: '#0891b2' },
                                size: 10,
                                shape: 'diamond'
                            },
                            keyword: {
                                color: { background: '#1e293b', border: '#334155' },
                                size: 6,
                                font: { size: 10, color: '#64748b' }
                            }
                        },
                        physics: {
                            stabilization: { iterations: 50 },
                            barnesHut: {
                                gravitationalConstant: -3000,
                                springConstant: 0.04,
                                springLength: 80
                            }
                        },
                        interaction: { hover: true, tooltipDelay: 200 }
                    };
                    network = new vis.Network(container, data, options);
                    allNodes = data.nodes;
                    allEdges = data.edges;
                    isFiltered = false;
                    network.on('click', function (params) {
                        if (params.nodes.length === 0) {
                            // Click on empty space — reset the graph if filtered
                            if (isFiltered) {
                                network.setData({ nodes: allNodes, edges: allEdges });
                                isFiltered = false;
                            }
                            var panel = document.getElementById('nodeEditorPanel');
                            if (panel)
                                panel.style.display = 'none';
                            return;
                        }
                        var clickedId = params.nodes[0];
                        // Display Node Editor Panel for keywords and categories
                        var nodeData = allNodes.find(function (n) { return n.id === clickedId; });
                        if (nodeData && (nodeData.group === 'keyword' || nodeData.group === 'category')) {
                            document.getElementById('nodeEditorTitle').textContent = nodeData.label;
                            document.getElementById('nodeEditorGroup').textContent = nodeData.group;
                            var input = document.getElementById('nodeEditorInput');
                            input.value = nodeData.label;
                            input.dataset.oldId = clickedId;
                            input.dataset.group = nodeData.group;
                            // Populate merge dropdown
                            var mergeSelect = document.getElementById('nodeMergeSelect');
                            if (mergeSelect) {
                                var sameGroupNodes = allNodes.filter(function (n) { return n.group === nodeData.group && n.id !== clickedId; });
                                sameGroupNodes.sort(function (a, b) { return a.label.localeCompare(b.label); });
                                mergeSelect.innerHTML = '<option value="">-- Select node to merge into --</option>' +
                                    sameGroupNodes.map(function (n) { return '<option value="' + escapeHtml(n.label) + '">' + escapeHtml(n.label) + '</option>'; }).join('');
                                mergeSelect.value = "";
                            }
                            var tmBtn = document.getElementById('testMeBtn');
                            var tmCont = document.getElementById('testMeContainer');
                            if (tmCont)
                                tmCont.innerHTML = '';
                            if (tmBtn) {
                                tmBtn.disabled = false;
                                tmBtn.textContent = '📝 Test Me';
                                tmBtn.style.opacity = '1';
                            }
                            document.getElementById('nodeEditorPanel').style.display = 'block';
                        }
                        else {
                            var panel = document.getElementById('nodeEditorPanel');
                            if (panel)
                                panel.style.display = 'none';
                        }
                        // Find all connected edges and nodes
                        var connectedEdges = allEdges.filter(function (e) {
                            return e.from === clickedId || e.to === clickedId;
                        });
                        var connectedNodeIds = new Set([clickedId]);
                        connectedEdges.forEach(function (e) {
                            connectedNodeIds.add(e.from);
                            connectedNodeIds.add(e.to);
                        });
                        var connectedNodes = allNodes.filter(function (n) {
                            return connectedNodeIds.has(n.id);
                        });
                        // Show only the clicked node and its neighbors
                        network.setData({ nodes: connectedNodes, edges: connectedEdges });
                        isFiltered = true;
                    });
                    // Double-click to reset
                    network.on('doubleClick', function () {
                        network.setData({ nodes: allNodes, edges: allEdges });
                        isFiltered = false;
                    });
                    graphTitle = container.parentElement.querySelector('.card-title');
                    if (graphTitle) {
                        statsSpan = graphTitle.querySelector('.graph-stats');
                        if (!statsSpan) {
                            statsSpan = document.createElement('span');
                            statsSpan.className = 'graph-stats';
                            statsSpan.style.cssText = 'margin-left:auto;font-size:0.7rem;color:var(--text-muted);font-family:var(--font-mono);font-weight:400;text-transform:none;letter-spacing:0';
                            graphTitle.appendChild(statsSpan);
                        }
                        projectCount = allNodes.filter(function (n) { return n.group === 'project'; }).length;
                        kwCount = allNodes.filter(function (n) { return n.group === 'keyword'; }).length;
                        statsSpan.textContent = projectCount + ' projects · ' + kwCount + ' keywords · ' + allEdges.length + ' edges';
                    }
                    return [3 /*break*/, 5];
                case 4:
                    e_11 = _a.sent();
                    console.error('Graph error', e_11);
                    container.innerHTML = '<div style="padding:1rem;color:var(--accent-rose)">Graph failed to load</div>';
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function submitNodeEdit() {
    return __awaiter(this, void 0, void 0, function () {
        var input, btn, newId, oldId, group, res, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    input = document.getElementById('nodeEditorInput');
                    btn = input.nextElementSibling;
                    newId = input.value.trim();
                    oldId = input.dataset.oldId;
                    group = input.dataset.group;
                    if (!oldId || !group)
                        return [2 /*return*/];
                    btn.disabled = true;
                    btn.textContent = '...';
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, fetch('/api/graph/node', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ oldId: oldId, newId: newId, group: group })
                        })];
                case 2:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error('Failed to update node');
                    showToast(newId ? 'Node renamed successfully' : 'Node deleted successfully');
                    document.getElementById('nodeEditorPanel').style.display = 'none';
                    // Refresh graph and lists
                    loadGraph();
                    if (document.getElementById('projectSelect').value) {
                        loadSessionList(); // refresh active project view too if one is loaded
                    }
                    return [3 /*break*/, 5];
                case 3:
                    err_2 = _a.sent();
                    showToast(err_2.message || 'Error updating node', true);
                    return [3 /*break*/, 5];
                case 4:
                    btn.disabled = false;
                    btn.textContent = 'Apply';
                    return [7 /*endfinally*/];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function triggerEdgeSynthesis() {
    return __awaiter(this, void 0, void 0, function () {
        var gpf, ps, project, btn, status, res, data, e_12;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    gpf = document.getElementById('graphProjectFilter');
                    ps = document.getElementById('projectSelect');
                    project = (gpf ? gpf.value : '') || (ps ? ps.value : '');
                    if (!project) {
                        alert("Please select an active project first.");
                        return [2 /*return*/];
                    }
                    btn = document.querySelector('button[onclick="triggerEdgeSynthesis()"]');
                    status = document.getElementById('synthesisStatus');
                    if (btn) {
                        btn.disabled = true;
                        btn.style.opacity = '0.5';
                    }
                    if (status)
                        status.textContent = 'running...';
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/graph/synthesize', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ project: project, randomize_selection: true, max_entries: 50 })
                        })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    if (res.ok && data.success) {
                        if (status)
                            status.textContent = '✅ Created ' + data.newLinks + ' links (Scanned: ' + data.entriesScanned + ')';
                        setTimeout(loadGraph, 1000); // Reload graph to show new edges
                        loadGraphMetrics(); // Refresh health metrics
                    }
                    else {
                        showToast('❌ Edge Synthesis Error: ' + (data.error || 'Failed'), true);
                        if (status)
                            status.textContent = '❌ Failed';
                    }
                    return [3 /*break*/, 6];
                case 4:
                    e_12 = _a.sent();
                    showToast('❌ Edge Synthesis Error: ' + e_12.message, true);
                    if (status)
                        status.textContent = '❌ Error';
                    return [3 /*break*/, 6];
                case 5:
                    if (btn) {
                        btn.disabled = false;
                        btn.style.opacity = '1';
                    }
                    setTimeout(function () {
                        if (status)
                            status.textContent = '';
                    }, 5000);
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function triggerCognitiveRoute() {
    return __awaiter(this, void 0, void 0, function () {
        var input, state, _gpf, _ps, project, container, btn, url, res, data, txt, err_3;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    input = document.getElementById('nodeEditorInput');
                    state = input && input.dataset && input.dataset.oldId ? input.dataset.oldId : '';
                    _gpf = document.getElementById('graphProjectFilter');
                    _ps = document.getElementById('projectSelect');
                    project = (_gpf ? _gpf.value : '') || (_ps ? _ps.value : '');
                    container = document.getElementById('cognitiveRouteContainer');
                    btn = document.getElementById('cognitiveRouteBtn');
                    if (!project || !state) {
                        if (container) {
                            container.innerHTML = '<div style="font-size:0.75rem;color:var(--accent-rose);">Select a project and click a graph node first.</div>';
                        }
                        return [2 /*return*/];
                    }
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = '...';
                    }
                    if (container) {
                        container.innerHTML = '<div style="font-size:0.75rem;color:var(--text-muted);text-align:center;padding:0.6rem 0;">Resolving cognitive route...</div>';
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    url = '/api/graph/cognitive-route' +
                        '?project=' + encodeURIComponent(project) +
                        '&state=' + encodeURIComponent('State:' + state) +
                        '&role=' + encodeURIComponent('Role:dev') +
                        '&action=' + encodeURIComponent('Action:inspect') +
                        '&explain=true';
                    return [4 /*yield*/, fetch(url)];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    if (!res.ok || data.isError) {
                        if (container) {
                            container.innerHTML = '<div style="font-size:0.75rem;color:var(--accent-rose);">' + escapeHtml(data.error || data.text || 'Cognitive route failed') + '</div>';
                        }
                        return [2 /*return*/];
                    }
                    if (container) {
                        txt = data.text || '';
                        container.innerHTML = '<pre style="margin:0;white-space:pre-wrap;font-size:0.72rem;line-height:1.45;background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:6px;padding:0.6rem;color:var(--text-secondary);">' + escapeHtml(txt) + '</pre>';
                    }
                    return [3 /*break*/, 6];
                case 4:
                    err_3 = _a.sent();
                    if (container) {
                        container.innerHTML = '<div style="font-size:0.75rem;color:var(--accent-rose);">' + escapeHtml(err_3.message || 'Route error') + '</div>';
                    }
                    return [3 /*break*/, 6];
                case 5:
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🧭 Route';
                    }
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
function triggerTestMe() {
    return __awaiter(this, void 0, void 0, function () {
        var input, oldId, _gpf, _ps, project, btn, container, res, data, err_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    input = document.getElementById('nodeEditorInput');
                    oldId = input.dataset.oldId;
                    _gpf = document.getElementById('graphProjectFilter');
                    _ps = document.getElementById('projectSelect');
                    project = (_gpf ? _gpf.value : '') || (_ps ? _ps.value : '');
                    if (!oldId || !project)
                        return [2 /*return*/];
                    btn = document.getElementById('testMeBtn');
                    container = document.getElementById('testMeContainer');
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = '...';
                    }
                    if (container) {
                        container.innerHTML = '<div style="font-size:0.75rem; color:var(--text-muted); text-align:center; padding:1rem 0;">Generating questions...</div>';
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/graph/test-me?id=' + encodeURIComponent(oldId) + '&project=' + encodeURIComponent(project))];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    if (data.reason === 'no_api_key') {
                        if (btn) {
                            btn.disabled = true;
                            btn.title = 'Requires AI key to generate quizzes';
                            btn.style.opacity = '0.5';
                        }
                        if (container)
                            container.innerHTML = '';
                        return [2 /*return*/];
                    }
                    else if (data.reason === 'generation_failed' || !data.questions || data.questions.length === 0) {
                        showToast('Failed to generate quizzes. Try again.', true);
                        if (container)
                            container.innerHTML = '';
                        if (btn) {
                            btn.disabled = false;
                            btn.textContent = '📝 Test Me';
                        }
                        return [2 /*return*/];
                    }
                    if (container) {
                        container.innerHTML = '';
                        data.questions.forEach(function (qa) {
                            var card = document.createElement('div');
                            card.style.background = 'var(--bg-secondary)';
                            card.style.border = '1px solid var(--border-subtle)';
                            card.style.borderRadius = '6px';
                            card.style.padding = '0.6rem';
                            card.innerHTML =
                                '<div style="font-size:0.8rem; font-weight:600; color:var(--text-primary); margin-bottom:0.4rem;">' + escapeHtml(qa.q) + '</div>' +
                                    '<div class="testme-ans" style="display:none; font-size:0.75rem; color:var(--text-secondary); margin-top:0.4rem; padding-top:0.4rem; border-top:1px dashed var(--border-subtle);">' +
                                    escapeHtml(qa.a) +
                                    '</div>' +
                                    '<button onclick="this.previousElementSibling.style.display=&apos;block&apos;; this.style.display=&apos;none&apos;" style="background:transparent; border:none; color:var(--accent-purple); font-size:0.7rem; cursor:pointer; padding:0; margin-top:0.3rem;">Show Answer</button>';
                            container.appendChild(card);
                        });
                    }
                    return [3 /*break*/, 6];
                case 4:
                    err_4 = _a.sent();
                    showToast('Error generating quiz', true);
                    if (container)
                        container.innerHTML = '';
                    return [3 /*break*/, 6];
                case 5:
                    if (btn && !(btn.title && btn.title.includes('Requires AI key'))) {
                        btn.textContent = '📝 Test Me';
                        btn.disabled = false;
                    }
                    loadGraphMetrics(); // Refresh health metrics
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// Initialize the graph on page load
loadGraph();
// ─── Settings Modal (v3.0) ───
function openSettings() {
    document.getElementById('settingsModal').classList.add('active');
    loadSettings();
}
function closeSettings() {
    document.getElementById('settingsModal').classList.remove('active');
}
// Close on overlay click
document.getElementById('settingsModal').addEventListener('click', function (e) {
    if (e.target === this)
        closeSettings();
});
// ─── Skills Tab JS ───────────────────────────────────────────
var _skillsCache = {}; // role → content cache
function switchSettingsTab(tab) {
    ['settings', 'skills', 'providers', 'observability'].forEach(function (t) {
        document.getElementById('stab-' + t).classList.toggle('active', t === tab);
        document.getElementById('spanel-' + t).classList.toggle('active', t === tab);
    });
    if (tab === 'skills') {
        var role = document.getElementById('skillRoleSelect').value;
        loadSkillForRole(role);
    }
    if (tab === 'providers') {
        loadAiProviderSettings();
    }
    if (tab === 'observability') {
        loadOtelSettings();
    }
}
function loadSkillForRole(role) {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, content, ta, e_13;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/skills')];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    _skillsCache = data.skills || {};
                    content = _skillsCache[role] || '';
                    ta = document.getElementById('skillTextarea');
                    ta.value = content;
                    document.getElementById('skillCharCount').textContent = content.length + ' chars';
                    return [3 /*break*/, 4];
                case 3:
                    e_13 = _a.sent();
                    console.warn('Skills load failed:', e_13);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function saveCurrentSkill() {
    return __awaiter(this, void 0, void 0, function () {
        var role, content, e_14;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    role = document.getElementById('skillRoleSelect').value;
                    content = document.getElementById('skillTextarea').value;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/skills', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ role: role, content: content })
                        })];
                case 2:
                    _a.sent();
                    _skillsCache[role] = content;
                    showFixedToast('✅ Skill saved for ' + role, true);
                    return [3 /*break*/, 4];
                case 3:
                    e_14 = _a.sent();
                    showFixedToast('❌ Save failed', false);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function clearCurrentSkill() {
    return __awaiter(this, void 0, void 0, function () {
        var role, e_15;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    role = document.getElementById('skillRoleSelect').value;
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/skills/' + role, { method: 'DELETE' })];
                case 2:
                    _a.sent();
                    document.getElementById('skillTextarea').value = '';
                    document.getElementById('skillCharCount').textContent = '0 chars';
                    _skillsCache[role] = '';
                    showFixedToast('🗑️ Skill cleared for ' + role, true);
                    return [3 /*break*/, 4];
                case 3:
                    e_15 = _a.sent();
                    showFixedToast('❌ Clear failed', false);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function handleSkillUpload(input) {
    var file = input.files[0];
    if (!file)
        return;
    var reader = new FileReader();
    reader.onload = function (e) {
        return __awaiter(this, void 0, void 0, function () {
            var content, ta;
            return __generator(this, function (_a) {
                switch (_a.label) {
                    case 0:
                        content = e.target.result;
                        ta = document.getElementById('skillTextarea');
                        ta.value = content;
                        document.getElementById('skillCharCount').textContent = content.length + ' chars';
                        // Auto-save after upload
                        return [4 /*yield*/, saveCurrentSkill()];
                    case 1:
                        // Auto-save after upload
                        _a.sent();
                        return [2 /*return*/];
                }
            });
        });
    };
    reader.readAsText(file);
    input.value = ''; // reset so same file can be re-uploaded
}
// ─── AI Providers Settings (v4.4) ────────────────────────────────────
// text_provider  → governs generateText()  (gemini | openai | anthropic)
// embedding_provider → governs generateEmbedding() (auto | gemini | openai)
// Called when the TEXT provider dropdown changes.
function onTextProviderChange(value) {
    document.getElementById('provider-fields-gemini').style.display = value === 'gemini' ? '' : 'none';
    document.getElementById('provider-fields-openai').style.display = value === 'openai' ? '' : 'none';
    document.getElementById('provider-fields-anthropic').style.display = value === 'anthropic' ? '' : 'none';
    // Refresh the Anthropic warning — its visibility depends on both dropdowns
    refreshAnthropicWarning(value, document.getElementById('select-embedding-provider').value);
    saveBootSetting('text_provider', value);
}
// Called when the EMBEDDING provider dropdown changes.
function onEmbeddingProviderChange(value) {
    var textVal = document.getElementById('select-text-provider').value;
    // Show the OpenAI embedding model field only when embedding=openai
    document.getElementById('embed-fields-openai').style.display = value === 'openai' ? '' : 'none';
    refreshAnthropicWarning(textVal, value);
    saveBootSetting('embedding_provider', value);
}
// Shows/hides the Anthropic+auto warning.
// Warning appears when: text=anthropic AND embedding=auto (auto-bridges to Gemini).
function refreshAnthropicWarning(textVal, embedVal) {
    var show = textVal === 'anthropic' && embedVal === 'auto';
    document.getElementById('anthropic-embed-warning').style.display = show ? '' : 'none';
}
// Load all AI provider settings from the API and populate fields.
// Called lazily when the tab is first activated (not on every modal open).
function loadAiProviderSettings() {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, s, textProvider, textSel, embedProvider, embedSel, gKey, aKey, aMod, oKey, oUrl, oMod, oEmb, e_16;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/settings')];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    s = data.settings || {};
                    textProvider = s.text_provider || 'gemini';
                    textSel = document.getElementById('select-text-provider');
                    if (textSel)
                        textSel.value = textProvider;
                    document.getElementById('provider-fields-gemini').style.display = textProvider === 'gemini' ? '' : 'none';
                    document.getElementById('provider-fields-openai').style.display = textProvider === 'openai' ? '' : 'none';
                    document.getElementById('provider-fields-anthropic').style.display = textProvider === 'anthropic' ? '' : 'none';
                    embedProvider = s.embedding_provider || 'auto';
                    embedSel = document.getElementById('select-embedding-provider');
                    if (embedSel)
                        embedSel.value = embedProvider;
                    document.getElementById('embed-fields-openai').style.display = embedProvider === 'openai' ? '' : 'none';
                    refreshAnthropicWarning(textProvider, embedProvider);
                    gKey = document.getElementById('input-google-api-key');
                    if (gKey)
                        gKey.placeholder = s.GOOGLE_API_KEY ? '(key saved — paste to update)' : 'AIza…';
                    aKey = document.getElementById('input-anthropic-api-key');
                    if (aKey)
                        aKey.placeholder = s.anthropic_api_key ? '(key saved — paste to update)' : 'sk-ant-…';
                    aMod = document.getElementById('input-anthropic-model');
                    if (aMod && s.anthropic_model)
                        aMod.value = s.anthropic_model;
                    oKey = document.getElementById('input-openai-api-key');
                    if (oKey)
                        oKey.placeholder = s.openai_api_key ? '(key saved — paste to update)' : 'sk-… (blank for Ollama)';
                    oUrl = document.getElementById('input-openai-base-url');
                    if (oUrl && s.openai_base_url)
                        oUrl.value = s.openai_base_url;
                    oMod = document.getElementById('input-openai-model');
                    if (oMod && s.openai_model)
                        oMod.value = s.openai_model;
                    oEmb = document.getElementById('input-openai-embedding-model');
                    if (oEmb && s.openai_embedding_model)
                        oEmb.value = s.openai_embedding_model;
                    return [3 /*break*/, 4];
                case 3:
                    e_16 = _a.sent();
                    console.warn('AI provider settings load failed:', e_16);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ─── Auto-Load Checkboxes (v4.1) ─────────────────────────────────
function loadAutoloadCheckboxes() {
    return __awaiter(this, void 0, void 0, function () {
        var container, projRes, projData, projects, settRes, settData, saved, selected, e_17;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    container = document.getElementById('autoload-checkboxes');
                    if (!container)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    return [4 /*yield*/, fetch('/api/projects')];
                case 2:
                    projRes = _a.sent();
                    return [4 /*yield*/, projRes.json()];
                case 3:
                    projData = _a.sent();
                    projects = projData.projects || [];
                    return [4 /*yield*/, fetch('/api/settings')];
                case 4:
                    settRes = _a.sent();
                    return [4 /*yield*/, settRes.json()];
                case 5:
                    settData = _a.sent();
                    saved = (settData.settings || {}).autoload_projects || '';
                    selected = saved.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
                    if (projects.length === 0) {
                        container.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem">No projects found</span>';
                        return [2 /*return*/];
                    }
                    container.innerHTML = projects.map(function (p) {
                        var checked = selected.indexOf(p) !== -1 ? ' checked' : '';
                        return '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary)">' +
                            '<input type="checkbox" value="' + escapeHtml(p) + '"' + checked +
                            ' onchange="onAutoloadToggle()"' +
                            ' style="accent-color:var(--accent-purple);cursor:pointer" />' +
                            escapeHtml(p) + '</label>';
                    }).join('');
                    return [3 /*break*/, 7];
                case 6:
                    e_17 = _a.sent();
                    container.innerHTML = '<span style="color:var(--accent-rose);font-size:0.8rem">Failed to load</span>';
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    });
}
function onAutoloadToggle() {
    var container = document.getElementById('autoload-checkboxes');
    if (!container)
        return;
    var boxes = container.querySelectorAll('input[type=checkbox]');
    var selected = [];
    for (var i = 0; i < boxes.length; i++) {
        if (boxes[i].checked)
            selected.push(boxes[i].value);
    }
    saveBootSetting('autoload_projects', selected.join(','));
}
// ─── Project Repo Paths (v4.2) ─────────────────────────────────
function loadRepoPathInputs() {
    return __awaiter(this, void 0, void 0, function () {
        var container, projRes, projData, projects, settRes, settData, settings, e_18;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    container = document.getElementById('repopath-inputs');
                    if (!container)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 6, , 7]);
                    return [4 /*yield*/, fetch('/api/projects')];
                case 2:
                    projRes = _a.sent();
                    return [4 /*yield*/, projRes.json()];
                case 3:
                    projData = _a.sent();
                    projects = projData.projects || [];
                    return [4 /*yield*/, fetch('/api/settings')];
                case 4:
                    settRes = _a.sent();
                    return [4 /*yield*/, settRes.json()];
                case 5:
                    settData = _a.sent();
                    settings = settData.settings || {};
                    if (projects.length === 0) {
                        container.innerHTML = '<span style="color:var(--text-muted);font-size:0.8rem">No projects found</span>';
                        return [2 /*return*/];
                    }
                    container.innerHTML = projects.map(function (p) {
                        var savedPath = settings['repo_path:' + p] || '';
                        return '<div style="display:flex;align-items:center;gap:6px">' +
                            '<span style="min-width:100px;color:var(--text-secondary);font-family:var(--font-mono);font-size:0.8rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escapeHtml(p) + '">' + escapeHtml(p) + '</span>' +
                            '<input type="text" value="' + escapeHtml(savedPath) + '"' +
                            ' placeholder="/path/to/repo"' +
                            ' data-project="' + escapeHtml(p) + '"' +
                            ' style="flex:1;min-width:140px;padding:0.2rem 0.4rem;background:var(--bg-primary);color:var(--text-primary);border:1px solid var(--border-glass);border-radius:4px;font-size:0.8rem;font-family:var(--font-mono)"' +
                            ' onchange="saveRepoPath(this.dataset.project, this.value)"' +
                            ' oninput="clearTimeout(this._t); var self=this; this._t=setTimeout(function(){saveRepoPath(self.dataset.project, self.value)},1200)" />' +
                            '</div>';
                    }).join('');
                    return [3 /*break*/, 7];
                case 6:
                    e_18 = _a.sent();
                    container.innerHTML = '<span style="color:var(--accent-rose);font-size:0.8rem">Failed to load</span>';
                    return [3 /*break*/, 7];
                case 7: return [2 /*return*/];
            }
        });
    });
}
function saveRepoPath(project, path) {
    return __awaiter(this, void 0, void 0, function () {
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, saveSetting('repo_path:' + project, path.trim())];
                case 1:
                    _a.sent();
                    return [2 /*return*/];
            }
        });
    });
}
function loadSettings() {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, s, e_19;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/settings?t=' + Date.now())];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    s = data.settings || {};
                    // Runtime toggles
                    if (s.auto_capture === 'true')
                        document.getElementById('toggle-auto-capture').classList.add('active');
                    else
                        document.getElementById('toggle-auto-capture').classList.remove('active');
                    // Context depth
                    if (s.default_context_depth)
                        document.getElementById('select-context-depth').value = s.default_context_depth;
                    // Theme
                    if (s.dashboard_theme) {
                        document.getElementById('select-theme').value = s.dashboard_theme;
                        applyTheme(s.dashboard_theme);
                    }
                    // Boot toggles
                    if (s.hivemind_enabled === 'true')
                        document.getElementById('toggle-hivemind').classList.add('active');
                    else
                        document.getElementById('toggle-hivemind').classList.remove('active');
                    if (s.task_router_enabled === 'true')
                        document.getElementById('toggle-task-router').classList.add('active');
                    else
                        document.getElementById('toggle-task-router').classList.remove('active');
                    // Storage Backend
                    if (s.PRISM_STORAGE) {
                        document.getElementById('storageBackendSelect').value = s.PRISM_STORAGE;
                    }
                    // Agent Identity
                    if (s.default_role)
                        document.getElementById('select-default-role').value = s.default_role;
                    if (s.agent_name)
                        document.getElementById('input-agent-name').value = s.agent_name;
                    if (s.max_tokens)
                        document.getElementById('input-max-tokens').value = s.max_tokens;
                    // Autoload checkboxes are loaded dynamically
                    loadAutoloadCheckboxes();
                    // Repo path inputs are loaded dynamically
                    loadRepoPathInputs();
                    // OTel settings are loaded dynamically when the tab is first opened,
                    // but also pre-load here so values are ready if user lands on that tab.
                    loadOtelSettings();
                    return [3 /*break*/, 4];
                case 3:
                    e_19 = _a.sent();
                    console.warn('Settings load failed:', e_19);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
// ─── OTel Settings Hydration (v4.6.0) ────────────────────────────────
// Separate loader function so it can be called from both loadSettings()
// (pre-warm on modal open) and switchSettingsTab('observability')
// (refresh on tab focus, in case settings changed elsewhere).
function loadOtelSettings() {
    return __awaiter(this, void 0, void 0, function () {
        var res, data, s, enabledEl, endpointEl, serviceEl, e_20;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 3, , 4]);
                    return [4 /*yield*/, fetch('/api/settings')];
                case 1:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 2:
                    data = _a.sent();
                    s = data.settings || {};
                    enabledEl = document.getElementById('input-otel-enabled');
                    if (enabledEl)
                        enabledEl.checked = s.otel_enabled === 'true';
                    endpointEl = document.getElementById('input-otel-endpoint');
                    if (endpointEl)
                        endpointEl.value = s.otel_endpoint || 'http://localhost:4318/v1/traces';
                    serviceEl = document.getElementById('input-otel-service');
                    if (serviceEl)
                        serviceEl.value = s.otel_service_name || 'prism-mcp-server';
                    return [3 /*break*/, 4];
                case 3:
                    e_20 = _a.sent();
                    console.warn('OTel settings load failed:', e_20);
                    return [3 /*break*/, 4];
                case 4: return [2 /*return*/];
            }
        });
    });
}
function toggleSetting(key, el) {
    var isActive = el.classList.toggle('active');
    saveSetting(key, isActive ? 'true' : 'false').then(function (ok) {
        if (!ok)
            el.classList.toggle('active'); // rollback on failure
    });
}
function toggleBootSetting(key, el) {
    var isActive = el.classList.toggle('active');
    saveSetting(key, isActive ? 'true' : 'false').then(function (ok) {
        if (!ok) {
            el.classList.toggle('active'); // rollback on failure
        }
        else {
            showToast('Saved. Restart your AI client for this to take effect.');
        }
    });
}
function saveBootSetting(key, value) {
    saveSetting(key, value).then(function (ok) {
        if (ok)
            showToast('Saved. Restart your AI client for this to take effect.');
    });
}
function saveSetting(key, value) {
    return __awaiter(this, void 0, void 0, function () {
        var res, e_21;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fetch('/api/settings', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ key: key, value: value })
                        })];
                case 1:
                    res = _a.sent();
                    if (!res.ok)
                        throw new Error('HTTP ' + res.status);
                    if (key === 'dashboard_theme')
                        applyTheme(value);
                    // Refresh identity chip if role or name changed
                    if (key === 'default_role' || key === 'agent_name')
                        loadIdentityChip();
                    showToast('Saved ✓');
                    return [2 /*return*/, true];
                case 2:
                    e_21 = _a.sent();
                    console.error('Setting save failed:', e_21);
                    showToast('⚠️ Save failed — check server connection', true);
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
/**
 * applyTheme — sets the data-theme attribute on <html>
 * CSS custom properties in [data-theme="..."] blocks
 * override :root defaults instantly, no page reload needed.
 */
function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme || 'dark');
}
function showToast(msg) {
    var toast = document.getElementById('savedToast');
    toast.textContent = msg || 'Saved ✓';
    toast.classList.add('show');
    setTimeout(function () { toast.classList.remove('show'); }, 2000);
}
// ─── Hivemind Radar (v5.3 — Health Watchdog) ───
var hivemindRefreshTimer = null;
function loadTeam() {
    return __awaiter(this, void 0, void 0, function () {
        var project, card, res, data, team, list, roleIcons, statusColors, statusLabels, healthyCt, warnCt, summary, e_22;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    project = document.getElementById('projectSelect').value;
                    if (!project)
                        return [2 /*return*/];
                    card = document.getElementById('hivemindCard');
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch('/api/team?project=' + encodeURIComponent(project))];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    team = data.team || [];
                    list = document.getElementById('teamList');
                    if (team.length > 0) {
                        roleIcons = { dev: '🛠️', qa: '🔍', pm: '📋', lead: '🏗️', security: '🔒', ux: '🎨', cmo: '📢' };
                        statusColors = {
                            active: '#10b981', stale: '#f59e0b', frozen: '#ef4444',
                            overdue: '#f97316', looping: '#a855f7', idle: '#64748b', shutdown: '#374151'
                        };
                        statusLabels = {
                            active: '🟢', stale: '🟡', frozen: '🔴',
                            overdue: '⏰', looping: '🔄', idle: '💤', shutdown: '⚫'
                        };
                        list.innerHTML = team.map(function (a) {
                            var icon = roleIcons[a.role] || '🤖';
                            var ago = a.last_heartbeat ? timeAgo(a.last_heartbeat) : '?';
                            var dotColor = statusColors[a.status] || '#64748b';
                            var statusIcon = statusLabels[a.status] || '❓';
                            var loopBadge = (a.loop_count && a.loop_count >= 3)
                                ? ' <span style="color:#a855f7;font-size:0.75rem">🔄 ' + a.loop_count + 'x</span>'
                                : '';
                            var dotClass = 'pulse-dot' + (a.status === 'looping' ? ' looping' : '');
                            return '<li class="team-item">' +
                                '<span class="' + dotClass + '" style="background:' + dotColor + '"></span>' +
                                '<span class="team-role">' + icon + ' ' + escapeHtml(a.role) + '</span>' +
                                '<span class="team-status" title="' + (a.status || 'active') + '">' + statusIcon + '</span>' +
                                '<span class="team-task">' + escapeHtml(a.current_task || 'idle') + loopBadge + '</span>' +
                                '<span class="team-heartbeat">' + ago + '</span></li>';
                        }).join('');
                        healthyCt = team.filter(function (a) { return a.status === 'active' || a.status === 'idle'; }).length;
                        warnCt = team.length - healthyCt;
                        summary = team.length + ' agent(s)';
                        if (warnCt > 0)
                            summary += ' | ⚠️ ' + warnCt + ' need attention';
                        summary += ' | 🐝 Watchdog active';
                        list.innerHTML += '<li style="color:var(--text-muted);font-size:0.75rem;text-align:center;padding:0.5rem;border-top:1px solid var(--border)">' + summary + '</li>';
                        card.style.display = 'block';
                    }
                    else {
                        list.innerHTML = '<li style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem">No active agents on this project.</li>';
                        card.style.display = 'block';
                    }
                    return [3 /*break*/, 5];
                case 4:
                    e_22 = _a.sent();
                    console.warn('Team load failed:', e_22);
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
// v5.3: Auto-refresh Hivemind Radar every 15s
function startHivemindRefresh() {
    stopHivemindRefresh();
    hivemindRefreshTimer = setInterval(loadTeam, 15000);
}
function stopHivemindRefresh() {
    if (hivemindRefreshTimer) {
        clearInterval(hivemindRefreshTimer);
        hivemindRefreshTimer = null;
    }
}
if (document.getElementById('hivemindCard')) {
    startHivemindRefresh();
}
// ─── Background Scheduler Status (v5.4) ───
function loadSchedulerStatus() {
    return __awaiter(this, void 0, void 0, function () {
        var el, res, data, offHtml, intervalH, parts, ls, t, bytes, bytesStr, errors, scholarStatusHtml, e_23;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    el = document.getElementById('schedulerContent');
                    if (!el)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch('/api/scheduler')];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    if (!data.running) {
                        offHtml = '<div style="color:var(--text-muted)">⏸ Scheduler not running. Set <code style="font-family:var(--font-mono);font-size:0.75rem">PRISM_SCHEDULER_ENABLED=true</code> to enable.</div>';
                        offHtml += '<div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-glass); font-size: 0.85em; color: var(--text-muted);">' +
                            '<strong>Web Scholar:</strong> ' + (data.scholarRunning ? '🟢 Enabled' : '🔴 Disabled') +
                            (data.scholarIntervalMs ? ' (every ' + Math.round(data.scholarIntervalMs / 60000) + 'm)' : '') +
                            '</div>';
                        el.innerHTML = offHtml;
                        return [2 /*return*/];
                    }
                    intervalH = Math.round(data.intervalMs / 3600000);
                    parts = ['<div style="display:flex;gap:0.75rem;flex-wrap:wrap;margin-bottom:0.5rem">'];
                    parts.push('<span style="color:var(--accent-green)">🟢 Running</span>');
                    parts.push('<span>Interval: <strong>' + intervalH + 'h</strong></span>');
                    if (data.startedAt) {
                        parts.push('<span>Started: ' + formatDate(data.startedAt) + '</span>');
                    }
                    parts.push('</div>');
                    if (data.lastSweep) {
                        ls = data.lastSweep;
                        parts.push('<div style="border-top:1px solid var(--border-glass);padding-top:0.5rem;margin-top:0.25rem">');
                        parts.push('<div style="margin-bottom:0.3rem;color:var(--text-secondary)">Last sweep: ' + formatDate(ls.completedAt) + ' (' + ls.durationMs + 'ms)</div>');
                        parts.push('<div style="display:grid;grid-template-columns:repeat(2,1fr);gap:0.3rem;font-size:0.75rem">');
                        t = ls.tasks;
                        if (t.ttlSweep.ran) {
                            parts.push('<div>🗓️ TTL: ' + t.ttlSweep.totalExpired + ' expired (' + t.ttlSweep.projectsSwept + ' projects)</div>');
                        }
                        if (t.importanceDecay.ran) {
                            parts.push('<div>📉 Decay: ' + t.importanceDecay.projectsDecayed + ' projects</div>');
                        }
                        if (t.compaction.ran) {
                            parts.push('<div>🧹 Compact: ' + t.compaction.projectsCompacted + ' compacted</div>');
                        }
                        if (t.deepPurge.ran) {
                            bytes = t.deepPurge.reclaimedBytes;
                            bytesStr = bytes > 1048576 ? (bytes / 1048576).toFixed(1) + 'MB' : bytes > 1024 ? (bytes / 1024).toFixed(1) + 'KB' : bytes + 'B';
                            parts.push('<div>💾 Purge: ' + t.deepPurge.purged + ' entries (' + bytesStr + ' freed)</div>');
                        }
                        parts.push('</div>');
                        errors = [t.ttlSweep.error, t.importanceDecay.error, t.compaction.error, t.deepPurge.error].filter(Boolean);
                        if (errors.length > 0) {
                            parts.push('<div style="color:var(--accent-rose);margin-top:0.3rem;font-size:0.7rem">⚠️ ' + errors.join(' | ') + '</div>');
                        }
                        parts.push('</div>');
                    }
                    else {
                        parts.push('<div style="color:var(--text-muted)">No sweep completed yet. First sweep runs 5s after start.</div>');
                    }
                    scholarStatusHtml = '<div style="margin-top: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--border-glass); font-size: 0.85em; color: var(--text-muted);">' +
                        '<strong>Web Scholar:</strong> ' + (data.scholarRunning ? '🟢 Enabled' : '🔴 Disabled') +
                        (data.scholarIntervalMs ? ' (every ' + Math.round(data.scholarIntervalMs / 60000) + 'm)' : '') +
                        '</div>';
                    parts.push(scholarStatusHtml);
                    el.innerHTML = parts.join('');
                    return [3 /*break*/, 5];
                case 4:
                    e_23 = _a.sent();
                    el.innerHTML = '<div style="color:var(--text-muted)">Scheduler status unavailable</div>';
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function loadGraphMetrics() {
    return __awaiter(this, void 0, void 0, function () {
        var el, warn, res, m, parts, synthStatus, tmStatus, pruneRatio, pruneSkipParts, rate, ratePct, rateColor, netNew, netColor, netSign, pruneRatioPct, cogTotal, autoP, clarP, fallP, ambPct, ambColor, fbPct, fbColor, lastRoute, lastConcept, lastConf, badges, e_24;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    el = document.getElementById('graphMetricsContent');
                    warn = document.getElementById('graphHealthWarnings');
                    if (!el)
                        return [2 /*return*/];
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch('/api/graph/metrics')];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    m = _a.sent();
                    parts = [];
                    // Synthesis row
                    parts.push('<div style="display:grid;grid-template-columns:1fr 1fr;gap:0.3rem;margin-bottom:0.5rem">');
                    parts.push('<div><strong>Synthesis</strong></div>');
                    parts.push('<div><strong>Test Me</strong></div>');
                    // Synthesis stats
                    parts.push('<div style="font-size:0.75rem">');
                    parts.push('Runs: <strong>' + m.synthesis.runs_total + '</strong>');
                    if (m.synthesis.runs_failed > 0)
                        parts.push(' (<span style="color:var(--accent-rose)">' + m.synthesis.runs_failed + ' failed</span>)');
                    parts.push('<br>Links created: <strong>' + m.synthesis.links_created_total + '</strong>');
                    if (m.synthesis.last_run_at) {
                        synthStatus = m.synthesis.last_status === 'ok'
                            ? '<span style="color:var(--accent-green)">✓ ok</span>'
                            : '<span style="color:var(--accent-rose)">✗ error</span>';
                        parts.push('<br>Last: ' + synthStatus + ' (' + m.synthesis.last_links_created + ' links)');
                        parts.push('<br><span style="color:var(--text-muted)">' + timeAgo(m.synthesis.last_run_at) + '</span>');
                    }
                    if (m.synthesis.duration_p50_ms !== null) {
                        parts.push('<br>p50: ' + m.synthesis.duration_p50_ms + 'ms');
                    }
                    parts.push('</div>');
                    // Test-Me stats
                    parts.push('<div style="font-size:0.75rem">');
                    parts.push('Requests: <strong>' + m.testMe.requests_total + '</strong>');
                    parts.push('<br><span style="color:var(--accent-green)">✓ ' + m.testMe.success_total + '</span>');
                    if (m.testMe.no_api_key_total > 0)
                        parts.push(' <span style="color:var(--accent-amber)">🔑 ' + m.testMe.no_api_key_total + '</span>');
                    if (m.testMe.generation_failed_total > 0)
                        parts.push(' <span style="color:var(--accent-rose)">✗ ' + m.testMe.generation_failed_total + '</span>');
                    if (m.testMe.last_run_at) {
                        tmStatus = m.testMe.last_status === 'success'
                            ? '<span style="color:var(--accent-green)">✓</span>'
                            : m.testMe.last_status === 'no_api_key'
                                ? '<span style="color:var(--accent-amber)">🔑</span>'
                                : '<span style="color:var(--accent-rose)">✗</span>';
                        parts.push('<br>Last: ' + tmStatus + ' ' + m.testMe.last_status);
                        parts.push('<br><span style="color:var(--text-muted)">' + timeAgo(m.testMe.last_run_at) + '</span>');
                    }
                    if (m.testMe.duration_p50_ms !== null) {
                        parts.push('<br>p50: ' + m.testMe.duration_p50_ms + 'ms');
                    }
                    parts.push('</div>');
                    parts.push('</div>');
                    // Pruning summary row
                    if (m.pruning && m.pruning.last_run_at) {
                        parts.push('<div style="border-top:1px solid var(--border-glass);padding-top:0.4rem;margin-top:0.2rem;font-size:0.75rem">');
                        parts.push('🧹 Pruning: ' + m.pruning.projects_considered_last + ' considered, ' + m.pruning.projects_pruned_last + ' impacted');
                        parts.push('<br>Links: ' + m.pruning.links_soft_pruned_last + ' soft-pruned / ' + m.pruning.links_scanned_last + ' scanned');
                        pruneRatio = m.pruning.links_scanned_last > 0
                            ? Math.round((m.pruning.links_soft_pruned_last / m.pruning.links_scanned_last) * 100)
                            : 0;
                        parts.push(' (' + pruneRatio + '%)');
                        parts.push('<br>Threshold: ' + m.pruning.min_strength_last + ' | ' + m.pruning.duration_ms_last + 'ms');
                        pruneSkipParts = [];
                        if (m.pruning.skipped_backpressure_last > 0)
                            pruneSkipParts.push('⏳ ' + m.pruning.skipped_backpressure_last + ' backpressure');
                        if (m.pruning.skipped_cooldown_last > 0)
                            pruneSkipParts.push('🕒 ' + m.pruning.skipped_cooldown_last + ' cooldown');
                        if (m.pruning.skipped_budget_last > 0)
                            pruneSkipParts.push('⛽ ' + m.pruning.skipped_budget_last + ' budget');
                        if (pruneSkipParts.length > 0) {
                            parts.push('<br><span style="color:var(--accent-amber)">Skipped: ' + pruneSkipParts.join(' · ') + '</span>');
                        }
                        parts.push('<br><span style="color:var(--text-muted)">' + timeAgo(m.pruning.last_run_at) + '</span>');
                        parts.push('</div>');
                    }
                    // SLO derivations row (WS4)
                    if (m.slo) {
                        parts.push('<div style="border-top:1px solid var(--border-glass);padding-top:0.4rem;margin-top:0.2rem;font-size:0.75rem">');
                        parts.push('<strong>SLO</strong>');
                        // Synthesis success rate — color-coded
                        if (m.slo.synthesis_success_rate !== null) {
                            rate = m.slo.synthesis_success_rate;
                            ratePct = Math.round(rate * 100);
                            rateColor = rate >= 0.95 ? 'var(--accent-green)' : rate >= 0.80 ? 'var(--accent-amber)' : 'var(--accent-rose)';
                            parts.push('<br>Success rate: <span style="color:' + rateColor + ';font-weight:600">' + ratePct + '%</span>');
                        }
                        else {
                            parts.push('<br>Success rate: <span style="color:var(--text-muted)">—</span>');
                        }
                        netNew = m.slo.net_new_links_last_sweep;
                        netColor = netNew > 0 ? 'var(--accent-green)' : netNew < 0 ? 'var(--accent-rose)' : 'var(--text-muted)';
                        netSign = netNew > 0 ? '+' : '';
                        parts.push(' · Net links: <span style="color:' + netColor + '">' + netSign + netNew + '</span>');
                        pruneRatioPct = Math.round(m.slo.prune_ratio_last_sweep * 100);
                        parts.push(' · Prune: ' + pruneRatioPct + '%');
                        // Sweep duration
                        if (m.slo.scheduler_sweep_duration_ms_last > 0) {
                            parts.push(' · Sweep: ' + m.slo.scheduler_sweep_duration_ms_last + 'ms');
                        }
                        parts.push('</div>');
                    }
                    // Cognitive Routing row (v6.5)
                    if (m.cognitive && m.cognitive.evaluations_total > 0) {
                        parts.push('<div style="border-top:1px solid var(--border-glass);padding-top:0.4rem;margin-top:0.2rem;font-size:0.75rem">');
                        parts.push('<strong>🧠 Cognitive Routing</strong>');
                        parts.push('<br>Evaluations: <strong>' + m.cognitive.evaluations_total + '</strong>');
                        cogTotal = m.cognitive.evaluations_total;
                        autoP = Math.round((m.cognitive.route_auto_total / cogTotal) * 100);
                        clarP = Math.round((m.cognitive.route_clarify_total / cogTotal) * 100);
                        fallP = 100 - autoP - clarP;
                        parts.push('<div style="display:flex;height:8px;border-radius:4px;overflow:hidden;margin:4px 0;background:var(--surface-glass)">');
                        if (autoP > 0)
                            parts.push('<div style="width:' + autoP + '%;background:var(--accent-green)" title="Auto: ' + autoP + '%"></div>');
                        if (clarP > 0)
                            parts.push('<div style="width:' + clarP + '%;background:var(--accent-amber)" title="Clarify: ' + clarP + '%"></div>');
                        if (fallP > 0)
                            parts.push('<div style="width:' + fallP + '%;background:var(--accent-rose)" title="Fallback: ' + fallP + '%"></div>');
                        parts.push('</div>');
                        parts.push('<span style="color:var(--accent-green)">● Auto ' + autoP + '%</span>');
                        parts.push(' <span style="color:var(--accent-amber)">● Clarify ' + clarP + '%</span>');
                        parts.push(' <span style="color:var(--accent-rose)">● Fallback ' + fallP + '%</span>');
                        // Rates
                        if (m.cognitive.ambiguity_rate !== null) {
                            ambPct = Math.round(m.cognitive.ambiguity_rate * 100);
                            ambColor = ambPct > 40 ? 'var(--accent-rose)' : ambPct > 20 ? 'var(--accent-amber)' : 'var(--accent-green)';
                            parts.push('<br>Ambiguity: <span style="color:' + ambColor + ';font-weight:600">' + ambPct + '%</span>');
                        }
                        if (m.cognitive.fallback_rate !== null) {
                            fbPct = Math.round(m.cognitive.fallback_rate * 100);
                            fbColor = fbPct > 30 ? 'var(--accent-rose)' : fbPct > 15 ? 'var(--accent-amber)' : 'var(--accent-green)';
                            parts.push(' · Fallback: <span style="color:' + fbColor + ';font-weight:600">' + fbPct + '%</span>');
                        }
                        // Convergence steps
                        if (m.cognitive.median_convergence_steps !== null) {
                            parts.push('<br>Convergence: ' + m.cognitive.median_convergence_steps + ' steps (avg)');
                        }
                        if (m.cognitive.duration_p50_ms !== null) {
                            parts.push(' · p50: ' + m.cognitive.duration_p50_ms + 'ms');
                        }
                        // Last evaluation
                        if (m.cognitive.last_run_at) {
                            lastRoute = m.cognitive.last_route || '—';
                            lastConcept = m.cognitive.last_concept || '(none)';
                            lastConf = m.cognitive.last_confidence !== null ? Math.round(m.cognitive.last_confidence * 100) + '%' : '—';
                            parts.push('<br>Last: ' + lastRoute + ' → ' + lastConcept + ' (' + lastConf + ')');
                            parts.push('<br><span style="color:var(--text-muted)">' + timeAgo(m.cognitive.last_run_at) + '</span>');
                        }
                        parts.push('</div>');
                    }
                    el.innerHTML = parts.join('');
                    // Warning badges
                    if (warn) {
                        badges = [];
                        if (m.warnings.synthesis_quality_warning) {
                            badges.push('<span style="background:var(--accent-amber);color:#000;padding:2px 6px;border-radius:3px;font-size:0.65rem;font-weight:600" title="Over 85% of synthesis candidates are below threshold">⚠ Quality</span>');
                        }
                        if (m.warnings.testme_provider_warning) {
                            badges.push('<span style="background:var(--accent-rose);color:#fff;padding:2px 6px;border-radius:3px;font-size:0.65rem;font-weight:600" title="No API key configured — Test Me cannot generate quizzes">🔑 No Key</span>');
                        }
                        if (m.warnings.synthesis_failure_warning) {
                            badges.push('<span style="background:var(--accent-rose);color:#fff;padding:2px 6px;border-radius:3px;font-size:0.65rem;font-weight:600" title="Over 20% of synthesis runs are failing">⚠ Failures</span>');
                        }
                        if (m.warnings.cognitive_fallback_rate_warning) {
                            badges.push('<span style="background:var(--accent-rose);color:#fff;padding:2px 6px;border-radius:3px;font-size:0.65rem;font-weight:600" title="Over 30% of cognitive routes land on FALLBACK">⚠ Cog Fallback</span>');
                        }
                        if (m.warnings.cognitive_ambiguity_rate_warning) {
                            badges.push('<span style="background:var(--accent-amber);color:#000;padding:2px 6px;border-radius:3px;font-size:0.65rem;font-weight:600" title="Over 40% of cognitive evaluations are ambiguous">⚠ Cog Ambiguity</span>');
                        }
                        warn.innerHTML = badges.join('');
                    }
                    return [3 /*break*/, 5];
                case 4:
                    e_24 = _a.sent();
                    el.innerHTML = '<div style="color:var(--text-muted)">Graph metrics unavailable</div>';
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function triggerWebScholar() {
    return __awaiter(this, void 0, void 0, function () {
        var btn, res, data, e_25;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    btn = document.getElementById('scholarBtn');
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = '🔄 Triggering...';
                    }
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, 5, 6]);
                    return [4 /*yield*/, fetch('/api/scholar/trigger', { method: 'POST' })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    showFixedToast(data.message || (data.ok ? 'Scholar triggered.' : 'Scholar failed.'), data.ok);
                    return [3 /*break*/, 6];
                case 4:
                    e_25 = _a.sent();
                    showFixedToast('Scholar trigger failed.', false);
                    return [3 /*break*/, 6];
                case 5:
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🧠 Scholar (Run)';
                    }
                    return [7 /*endfinally*/];
                case 6: return [2 /*return*/];
            }
        });
    });
}
// Load scheduler status on page load
loadSchedulerStatus();
loadGraphMetrics();
// Auto-refresh scheduler status every 60s
setInterval(loadSchedulerStatus, 60000);
setInterval(loadGraphMetrics, 60000);
function timeAgo(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1)
        return 'just now';
    if (mins < 60)
        return mins + 'm ago';
    return Math.floor(mins / 60) + 'h ago';
}
// ─── Brain Health Cleanup (v6.1.4) — with simulated progress bar ───
function cleanupIssues() {
    return __awaiter(this, void 0, void 0, function () {
        function setProgress(pct, label) {
            if (bar) {
                bar.style.width = pct + '%';
            }
            if (pctEl) {
                pctEl.textContent = pct + '%';
            }
            if (stageEl && label) {
                stageEl.textContent = label;
            }
        }
        function clearTimers() { timers.forEach(function (t) { clearTimeout(t); }); }
        function finishProgress(ok, label) {
            clearTimers();
            if (bar)
                bar.classList.add('done');
            setProgress(100, ok ? '✅ Repair complete' : '❌ ' + (label || 'Repair failed'));
            // hide bar after a short celebration
            setTimeout(function () {
                if (wrap)
                    wrap.style.display = 'none';
                if (bar) {
                    bar.classList.remove('done');
                    bar.style.width = '0%';
                }
                if (pctEl)
                    pctEl.textContent = '0%';
            }, 2500);
        }
        var btn, wrap, bar, pctEl, stageEl, stages, timers, res, data, msg, e_26;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    btn = document.getElementById('cleanupBtn');
                    wrap = document.getElementById('healthProgressWrap');
                    bar = document.getElementById('healthProgressBar');
                    pctEl = document.getElementById('healthProgressPct');
                    stageEl = document.getElementById('healthProgressStage');
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = 'Cleaning…';
                    }
                    // ── show progress bar ──
                    if (wrap)
                        wrap.style.display = 'block';
                    stages = [
                        { pct: 5, label: 'Running health scan…', ms: 1500 },
                        { pct: 12, label: 'Identifying missing embeddings…', ms: 4000 },
                        { pct: 22, label: 'Backfilling embeddings (batch 1)…', ms: 10000 },
                        { pct: 35, label: 'Backfilling embeddings (batch 2)…', ms: 20000 },
                        { pct: 48, label: 'Backfilling embeddings (batch 3)…', ms: 30000 },
                        { pct: 60, label: 'Backfilling embeddings (batch 4)…', ms: 40000 },
                        { pct: 70, label: 'Backfilling embeddings (batch 5)…', ms: 55000 },
                        { pct: 78, label: 'Backfilling embeddings (batch 6)…', ms: 70000 },
                        { pct: 85, label: 'Cleaning orphaned handoffs…', ms: 85000 },
                        { pct: 90, label: 'Verifying repairs…', ms: 100000 },
                        { pct: 95, label: 'Finalizing…', ms: 115000 },
                    ];
                    timers = stages.map(function (s) {
                        return setTimeout(function () { setProgress(s.pct, s.label); }, s.ms);
                    });
                    _a.label = 1;
                case 1:
                    _a.trys.push([1, 4, , 5]);
                    return [4 /*yield*/, fetch('/api/health/cleanup', { method: 'POST' })];
                case 2:
                    res = _a.sent();
                    return [4 /*yield*/, res.json()];
                case 3:
                    data = _a.sent();
                    msg = data.message || data.error || (data.ok ? 'Cleanup complete.' : 'Cleanup failed.');
                    finishProgress(data.ok, msg);
                    showFixedToast(msg, data.ok);
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🧹 Fix Issues';
                    }
                    // Re-run health check to refresh the card
                    setTimeout(function () {
                        return __awaiter(this, void 0, void 0, function () {
                            var healthRes, healthData, healthDot, healthLabel, healthSummary, healthIssues, cleanupBtn, statusMap, t, issues, sevIcons, e_27;
                            return __generator(this, function (_a) {
                                switch (_a.label) {
                                    case 0:
                                        _a.trys.push([0, 3, , 4]);
                                        return [4 /*yield*/, fetch('/api/health')];
                                    case 1:
                                        healthRes = _a.sent();
                                        return [4 /*yield*/, healthRes.json()];
                                    case 2:
                                        healthData = _a.sent();
                                        healthDot = document.getElementById('healthDot');
                                        healthLabel = document.getElementById('healthLabel');
                                        healthSummary = document.getElementById('healthSummary');
                                        healthIssues = document.getElementById('healthIssues');
                                        cleanupBtn = document.getElementById('cleanupBtn');
                                        statusMap = { healthy: '✅ Healthy', degraded: '⚠️ Degraded', unhealthy: '🔴 Unhealthy' };
                                        healthDot.className = 'health-dot ' + (healthData.status || 'unknown');
                                        healthLabel.textContent = statusMap[healthData.status] || '❓ Unknown';
                                        t = healthData.totals || {};
                                        healthSummary.textContent = (t.activeEntries || 0) + ' entries · ' + (t.handoffs || 0) + ' handoffs · ' + (t.rollups || 0) + ' rollups' + (t.crdtMerges ? ' · 🔄 ' + t.crdtMerges + ' merges' : '');
                                        issues = healthData.issues || [];
                                        if (issues.length > 0) {
                                            sevIcons = { error: '🔴', warning: '🟡', info: '🔵' };
                                            healthIssues.innerHTML = issues.map(function (i) {
                                                return '<div class="issue-row"><span>' + (sevIcons[i.severity] || '❓') + '</span><span>' + escapeHtml(i.message) + '</span></div>';
                                            }).join('');
                                            if (cleanupBtn) {
                                                cleanupBtn.disabled = false;
                                                cleanupBtn.textContent = '🧹 Fix Issues';
                                                cleanupBtn.style.display = 'inline-block';
                                            }
                                        }
                                        else {
                                            healthIssues.innerHTML = '<div style="color:var(--accent-green);font-size:0.8rem">🎉 No issues found</div>';
                                            if (cleanupBtn)
                                                cleanupBtn.style.display = 'none';
                                        }
                                        return [3 /*break*/, 4];
                                    case 3:
                                        e_27 = _a.sent();
                                        // Health re-check failed — ensure button is usable
                                        if (btn) {
                                            btn.disabled = false;
                                            btn.textContent = '🧹 Fix Issues';
                                        }
                                        return [3 /*break*/, 4];
                                    case 4: return [2 /*return*/];
                                }
                            });
                        });
                    }, 400);
                    return [3 /*break*/, 5];
                case 4:
                    e_26 = _a.sent();
                    finishProgress(false, 'Request failed');
                    showFixedToast('Cleanup request failed.', false);
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = '🧹 Fix Issues';
                    }
                    return [3 /*break*/, 5];
                case 5: return [2 /*return*/];
            }
        });
    });
}
function showFixedToast(msg, ok) {
    var t = document.getElementById('fixedToast');
    t.textContent = (ok === false ? '❌ ' : '✅ ') + msg;
    t.classList.add('show');
    setTimeout(function () { t.classList.remove('show'); }, 3500);
}
// ─── PWA Service Worker Registration ───
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
        navigator.serviceWorker.register('/sw.js').then(function (reg) {
            console.log('[Dashboard] Service Worker registered with scope:', reg.scope);
            reg.addEventListener('updatefound', function () {
                var newWorker = reg.installing;
                newWorker.addEventListener('statechange', function () {
                    if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                        var toast = document.createElement('div');
                        toast.style.cssText = 'position:fixed;bottom:2rem;right:2rem;background:var(--bg-glass);backdrop-filter:blur(12px);border:1px solid var(--border-glass);padding:1rem 1.5rem;border-radius:12px;display:flex;align-items:center;gap:1.5rem;z-index:9999;box-shadow:0 10px 30px rgba(0,0,0,0.5);transform:translateY(0);transition:transform 0.3s, opacity 0.3s;';
                        toast.innerHTML = '<div><p style="font-weight:600;margin-bottom:0.25rem;color:var(--text-primary);">Update Available</p><p style="color:var(--text-secondary);font-size:0.85rem;">A new version of Prism is ready.</p></div><button style="background:linear-gradient(135deg, var(--accent-purple), var(--accent-blue));color:white;border:none;padding:0.5rem 1rem;border-radius:6px;cursor:pointer;font-weight:600;">Refresh</button>';
                        toast.querySelector('button').addEventListener('click', function () {
                            newWorker.postMessage({ action: 'skipWaiting' });
                            toast.style.opacity = '0';
                        });
                        document.body.appendChild(toast);
                    }
                });
            });
        }).catch(function (err) {
            console.error('[Dashboard] Service Worker registration failed:', err);
        });
        var refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', function () {
            if (!refreshing) {
                refreshing = true;
                window.location.reload();
            }
        });
    });
}

/* --- INTENT HEALTH COMPONENT (ES5 Safe) --- */

function fetchIntentHealth(project) {
    var container = document.getElementById('intentHealthCardContent');
    var card = document.getElementById('intentHealthCard');
    if (!container || !card) return;

    card.style.display = 'block';
    container.innerHTML = '<div style="color: #8b949e; padding: 16px;">Computing intent debt...</div>';

    fetch('/api/intent-health?project=' + encodeURIComponent(project))
        .then(function(res) { return res.json(); })
        .then(function(data) {
            if (data.error) {
                container.innerHTML = '<div style="color: #ff7b72; padding: 16px;">Error: ' + escapeHtml(data.error) + '</div>';
                return;
            }
            renderIntentHealthCard(data);
        })
        .catch(function(err) {
            container.innerHTML = '<div style="color: #ff7b72; padding: 16px;">Failed to load intent health.</div>';
        });
}

function renderIntentHealthCard(data) {
    var container = document.getElementById('intentHealthCardContent');
    if (!container) return;

    // Determine Gauge Color
    var scoreColor = '#2ea043'; // Green
    if (data.score < 50) {
        scoreColor = '#ff7b72'; // Red
    } else if (data.score < 80) {
        scoreColor = '#d29922'; // Yellow
    }

    // Render Signals
    var signalsHtml = '';
    for (var i = 0; i < data.signals.length; i++) {
        var sig = data.signals[i];
        var icon = '🟢';
        if (sig.severity === 'warn') icon = '🟡';
        if (sig.severity === 'critical') icon = '🔴';
        signalsHtml += '<div style="margin-bottom: 8px; font-size: 13px;">' + icon + ' ' + escapeHtml(sig.message) + '</div>';
    }

    // Render Layout
    var html = '' +
        '<div style="display: flex; gap: 24px; align-items: center; padding: 16px;">' +
            '<div style="text-align: center; flex-shrink: 0; min-width: 80px;">' +
                '<div style="font-size: 42px; font-weight: bold; color: ' + scoreColor + '; line-height: 1;">' + (typeof data.score === 'number' ? data.score : '—') + '</div>' +
                '<div style="font-size: 10px; color: #8b949e; text-transform: uppercase; letter-spacing: 1px; margin-top: 8px;">Health Score</div>' +
            '</div>' +
            '<div style="flex-grow: 1; border-left: 1px solid var(--border-glass); padding-left: 24px;">' +
                signalsHtml +
            '</div>' +
        '</div>';

    container.innerHTML = html;
}

</script>
</body>
</html>`;
}
