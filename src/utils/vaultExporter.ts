import { redactSettings } from "../tools/commonHelpers.js";

/**
 * Ensures filenames are safe for all filesystems.
 */
function slugify(text: string): string {
  if (!text) return 'untitled';
  const result = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return result || 'untitled'; // fallback if all chars were stripped
}

/**
 * Escapes YAML string values safely.
 */
function escapeYaml(text: string): string {
  if (!text) return '""';
  // YAML double-quoted scalar: escape backslashes first, then quotes,
  // then strip control characters (newlines, tabs) to prevent broken frontmatter.
  const safe = text
    .replace(/\\/g, '\\\\')       // \ → \\
    .replace(/"/g, '\\"')        // " → \\"
    .replace(/[\r\n]+/g, ' ')    // newlines → space
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, ''); // strip control chars
  return `"${safe}"`;
}

/**
 * Translates a Prism JSON export payload into a flat Map of filepaths to Uint8Array/Buffer.
 * This structure is ready to be consumed by fflate or native fs writers.
 */
export function buildVaultDirectory(exportData: any): Record<string, Buffer> {
  const d = exportData?.prism_export;
  if (!d) {
    throw new Error("Invalid or missing Prism memory export data.");
  }

  const vaultFiles: Record<string, Buffer> = {};
  const projectName = d.project || "Unknown_Project";

  // Helper to add files easily
  const addFile = (path: string, content: string) => {
    vaultFiles[path] = Buffer.from(content, "utf-8");
  };

  // 1. Handoff.md (Live Context)
  let handoffMd = `# Live Project State: ${projectName}\n\n`;
  handoffMd += `> Exported: ${d.exported_at || "Unknown Date"} | Version: ${d.version || "Unknown"}\n\n`;
  if (d.handoff) {
    const h = d.handoff;
    if (h.last_summary) handoffMd += `## Last Summary\n${h.last_summary}\n\n`;
    if (h.key_context) handoffMd += `## Key Context\n${h.key_context}\n\n`;
    if (h.active_branch) handoffMd += `**Active Branch:** \`${h.active_branch}\`\n\n`;
    
    if (Array.isArray(h.pending_todo) && h.pending_todo.length > 0) {
      handoffMd += `## Open TODOs\n`;
      h.pending_todo.forEach((t: string) => handoffMd += `- [ ] ${t}\n`);
      handoffMd += `\n`;
    }
  }
  addFile("Handoff.md", handoffMd);

  // 2. Settings/Config.md
  let settingsMd = `# Prism Settings\n\n| Key | Value |\n|-----|-------|\n`;
  for (const [k, v] of Object.entries(redactSettings(d.settings || {}))) {
    // Escape pipe chars so they don't break the Markdown table
    const safeVal = String(v).replace(/\|/g, '\\|');
    settingsMd += `| \`${k}\` | ${safeVal} |\n`;
  }
  addFile("Settings.md", settingsMd);

  // 3. Visual_Memory/Index.md
  if (Array.isArray(d.visual_memory) && d.visual_memory.length > 0) {
    let visualMd = `# Visual Memory Index\n\n`;
    for (const vm of d.visual_memory) {
      if (!vm) continue;
      const safeId = String(vm.id ?? "").substring(0, 8);
      visualMd += `- **[\`${safeId}\`]** ${vm.description || "No description"}\n`;
      visualMd += `  <small>File: \`${vm.filename || "Unknown"}\` | Date: ${vm.timestamp || "Unknown"}</small>\n`;
    }
    addFile("Visual_Memory/Index.md", visualMd);
  }

  // 4. Ledger/ and Keywords/ processing
  const keywordMentions: Record<string, { sessionName: string, path: string }[]> = {};

  // O(1) filename collision counter: key = "YYYY-MM-DD_slug", value = next suffix number
  const filenameCounters = new Map<string, number>();

  if (Array.isArray(d.ledger)) {
    for (const entry of d.ledger) {
      if (!entry) continue;
      
      const dateStr = typeof entry.created_at === "string" 
        ? entry.created_at.split("T")[0] 
        : "Unknown_Date";
      
      const sessionSlug = slugify(entry.summary ? entry.summary.substring(0, 40) : "Session");
      const baseKey = `${dateStr}_${sessionSlug}`;
      const count = filenameCounters.get(baseKey) ?? 0;
      filenameCounters.set(baseKey, count + 1);
      // First entry gets no suffix; subsequent collisions get -1, -2, …
      const filename = count === 0 ? `${baseKey}.md` : `${baseKey}-${count}.md`;
      const fullPath = `Ledger/${filename}`;

      // Extract raw keywords from entry
      const keywords: string[] = Array.isArray(entry.keywords) ? entry.keywords : [];
      
      // Build YAML Frontmatter
      let content = `---\n`;
      content += `date: ${dateStr}\n`;
      content += `type: prism-session\n`;
      content += `project: ${escapeYaml(projectName)}\n`;
      if (typeof entry.importance === "number") {
        content += `importance: ${entry.importance}\n`;
      } else {
        content += `importance: 1\n`; // default fallback
      }
      
      if (keywords.length > 0) {
        content += `tags: [${keywords.map((k: string) => escapeYaml(k)).join(", ")}]\n`;
      } else {
        content += `tags: []\n`;
      }
      content += `summary: ${escapeYaml(entry.summary || "No summary")}\n`;
      content += `---\n\n`;

      content += `# Session: ${dateStr}\n\n`;
      content += `**Summary:** ${entry.summary || "No summary"}\n\n`;

      if (Array.isArray(entry.todos) && entry.todos.length > 0) {
        content += `## Outstanding TODOs\n`;
        entry.todos.forEach((t: string) => content += `- [ ] ${t}\n`);
        content += `\n`;
      }
      
      if (Array.isArray(entry.decisions) && entry.decisions.length > 0) {
        content += `## Decisions\n`;
        entry.decisions.forEach((dec: string) => content += `- ${dec}\n`);
        content += `\n`;
      }

      if (Array.isArray(entry.files_changed) && entry.files_changed.length > 0) {
        content += `## Files Changed\n`;
        entry.files_changed.forEach((f: string) => content += `- \`${f}\`\n`);
        content += `\n`;
      }

      // Add Wikilinks for related keywords at the bottom
      if (keywords.length > 0) {
        content += `## Indexed Topics\n`;
        keywords.forEach(kw => {
          const kwSlug = slugify(kw);
          // Register for the reverse backlink index
          if (!keywordMentions[kwSlug]) {
            keywordMentions[kwSlug] = [];
          }
          keywordMentions[kwSlug].push({
            sessionName: entry.summary || filename,
            // Vault-relative path (no "../" prefix) — Obsidian [[Wikilinks]] resolve
            // from vault root, not from the current file's directory.
            path: `Ledger/${filename}`
          });

          // Embed wikilink in the ledger file
          // Using vault-relative path for Obsidian/Logseq compatibility
          content += `- [[Keywords/${kwSlug}|${kw}]]\n`;
        });
      }

      addFile(fullPath, content);
    }
  }

  // Generate the Keyword backlink pages
  for (const [kwSlug, mentions] of Object.entries(keywordMentions)) {
    let kwContent = `# Keyword: ${kwSlug}\n\n`;
    kwContent += `## Related Sessions\n`;
    
    // Deduplicate mentions just in case
    const uniqueMentions = Array.from(new Map(mentions.map(m => [m.path, m])).values());
    
    uniqueMentions.forEach(m => {
      // Create a nice human-readable display name for the link
      const displayName = m.sessionName.substring(0, 60).replace(/[\[\]|]/g, '');
      kwContent += `- [[${m.path}|${displayName}]]\n`;
    });

    addFile(`Keywords/${kwSlug}.md`, kwContent);
  }

  return vaultFiles;
}
