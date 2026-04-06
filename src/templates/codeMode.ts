/**
 * Code Mode Templates (v2.1 — Step 12)
 *
 * Pre-built QuickJS extraction scripts for common MCP tool outputs.
 * Instead of writing JavaScript from scratch, the LLM passes `template: "github_issues"`
 * and the handler substitutes the pre-built script before running the sandbox.
 *
 * Each template:
 *   - Reads the `DATA` global variable (string)
 *   - Extracts relevant fields
 *   - Outputs a compact summary via console.log()
 *   - Wraps in try/catch for graceful error handling
 *
 * ═══════════════════════════════════════════════════════════════════
 * ADDING A NEW TEMPLATE:
 *   1. Add a new key to CODE_MODE_TEMPLATES below
 *   2. Write the extraction script (must use var, not const/let — QuickJS compat)
 *   3. Update the tool description in definitions.ts to advertise it
 *   4. Add a test fixture in the smoke test
 * ═══════════════════════════════════════════════════════════════════
 */

export const CODE_MODE_TEMPLATES: Record<string, string> = {

  // ─── GitHub Issues ────────────────────────────────────────────
  // Source: GitHub REST API GET /repos/{owner}/{repo}/issues
  github_issues: `
    try {
      var issues = JSON.parse(DATA);
      if (!Array.isArray(issues)) issues = issues.items || [issues];
      var summary = issues.map(function(i) {
        var labels = (i.labels || []).map(function(l) { return typeof l === 'string' ? l : l.name; }).join(', ');
        return '#' + i.number + ' [' + i.state + '] ' + i.title +
          ' (@' + (i.user ? i.user.login : '?') + ')' +
          (labels ? ' {' + labels + '}' : '') +
          ' - ' + (i.comments || 0) + ' comments';
      });
      console.log(summary.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── GitHub Pull Requests ─────────────────────────────────────
  // Source: GitHub REST API GET /repos/{owner}/{repo}/pulls
  github_prs: `
    try {
      var prs = JSON.parse(DATA);
      if (!Array.isArray(prs)) prs = [prs];
      var summary = prs.map(function(pr) {
        var reviewState = pr.requested_reviewers && pr.requested_reviewers.length > 0
          ? ' (review pending)' : '';
        return '#' + pr.number + ' [' + pr.state + '] ' + pr.title +
          ' (by @' + (pr.user ? pr.user.login : '?') + ')' +
          ' ' + (pr.base ? pr.base.ref : '?') + ' <- ' + (pr.head ? pr.head.ref : '?') +
          reviewState;
      });
      console.log(summary.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── Jira Tickets ─────────────────────────────────────────────
  // Source: Jira REST API /rest/api/2/search
  jira_tickets: `
    try {
      var data = JSON.parse(DATA);
      var issues = data.issues || (Array.isArray(data) ? data : [data]);
      var summary = issues.map(function(i) {
        var f = i.fields || {};
        return '[' + (i.key || '?') + '] ' + (f.summary || 'No title') +
          ' - Status: ' + (f.status ? f.status.name : '?') +
          ' - Priority: ' + (f.priority ? f.priority.name : '?') +
          ' - Assignee: ' + (f.assignee ? f.assignee.displayName : 'Unassigned');
      });
      console.log(summary.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── DOM Links Extraction ─────────────────────────────────────
  // Source: chrome-devtools take_snapshot or any raw HTML string
  dom_links: `
    try {
      var html = DATA;
      var matches = [];
      var re = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\\/a>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var text = m[2].replace(/<[^>]+>/g, '').trim();
        if (text.length > 0 && m[1].length > 0) {
          matches.push('[' + text + '](' + m[1] + ')');
        }
      }
      console.log(matches.length + ' links found:\\n' + matches.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── DOM Headings Hierarchy ───────────────────────────────────
  // Source: chrome-devtools take_snapshot or any raw HTML string
  dom_headings: `
    try {
      var html = DATA;
      var headings = [];
      var re = /<(h[1-6])[^>]*>(.*?)<\\/\\1>/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var level = parseInt(m[1].charAt(1));
        var text = m[2].replace(/<[^>]+>/g, '').trim();
        var indent = '';
        for (var i = 1; i < level; i++) indent += '  ';
        headings.push(indent + m[1].toUpperCase() + ': ' + text);
      }
      console.log(headings.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── OpenAPI / Swagger Endpoints ──────────────────────────────
  // Source: Any OpenAPI 3.x or Swagger 2.x JSON spec
  api_endpoints: `
    try {
      var spec = JSON.parse(DATA);
      var paths = spec.paths || {};
      var endpoints = [];
      var pathKeys = Object.keys(paths);
      for (var p = 0; p < pathKeys.length; p++) {
        var path = pathKeys[p];
        var methods = paths[path];
        var methodKeys = Object.keys(methods);
        for (var m = 0; m < methodKeys.length; m++) {
          var method = methodKeys[m];
          if (method === 'parameters' || method === 'summary') continue;
          var details = methods[method];
          endpoints.push('[' + method.toUpperCase() + '] ' + path +
            ' - ' + (details.summary || details.operationId || 'No summary'));
        }
      }
      console.log(endpoints.length + ' endpoints:\\n' + endpoints.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── Slack Messages ───────────────────────────────────────────
  // Source: Slack Web API conversations.history
  slack_messages: `
    try {
      var data = JSON.parse(DATA);
      var messages = data.messages || (Array.isArray(data) ? data : [data]);
      var summary = messages.map(function(m) {
        var ts = m.ts ? new Date(parseFloat(m.ts) * 1000).toISOString().substring(0, 16) : '?';
        var user = m.user || m.username || 'bot';
        var text = (m.text || '').substring(0, 120);
        return '[' + ts + '] @' + user + ': ' + text;
      });
      console.log(summary.join("\\n"));
    } catch (e) { console.log("Template Error: " + e.message); }
  `,

  // ─── CSV Summary ──────────────────────────────────────────────
  // Source: Any CSV text data
  csv_summary: `
    try {
      var lines = DATA.trim().split("\\n");
      var headers = lines[0];
      var rowCount = lines.length - 1;
      var cols = headers.split(",").map(function(h) { return h.trim(); });
      var output = 'Columns (' + cols.length + '): ' + cols.join(', ') + '\\n';
      output += 'Rows: ' + rowCount + '\\n';
      if (rowCount > 0) {
        output += '\\nSample (first 3 rows):\\n';
        for (var i = 1; i <= Math.min(3, rowCount); i++) {
          output += '  Row ' + i + ': ' + lines[i] + '\\n';
        }
      }
      console.log(output);
    } catch (e) { console.log("Template Error: " + e.message); }
  `,
};

/** Returns a sorted list of all available template names. */
export function getTemplateNames(): string[] {
  return Object.keys(CODE_MODE_TEMPLATES).sort();
}
