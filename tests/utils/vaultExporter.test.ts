import { describe, it, expect } from "vitest";
import { buildVaultDirectory } from "../../src/utils/vaultExporter.js";

describe("vaultExporter", () => {
  describe("slugify edge cases", () => {
    it("handles empty or purely special-character summaries/keywords, falling back to 'untitled'", () => {
      const data = {
        prism_export: {
          project: "test",
          ledger: [
            {
              summary: "",
              keywords: ["", "@@@!!!"]
            }
          ]
        }
      };
      const vault = buildVaultDirectory(data);
      const files = Object.keys(vault);
      
      // Expected empty slugification to fall back to 'untitled'
      expect(files.some(f => f.includes("untitled.md"))).toBe(true);
      expect(files.some(f => f.includes("Keywords/untitled.md"))).toBe(true);
    });

    it("strips special characters and trims dashes", () => {
      const data = {
        prism_export: {
          project: "test",
          ledger: [
            {
              summary: "---Hello_World!!!   ",
              keywords: ["--Special@!#_Chars--"]
            }
          ]
        }
      };
      const vault = buildVaultDirectory(data);
      const files = Object.keys(vault);
      
      expect(files.some(f => f.includes("hello-world.md"))).toBe(true);
      expect(files.some(f => f.includes("Keywords/special-chars.md"))).toBe(true);
    });
  });

  describe("escapeYaml edge cases", () => {
    it("escapes quotes and newlines in project, summary, and keywords safely", () => {
      const data = {
        prism_export: {
          project: 'Project\n"Name"',
          ledger: [
            {
              summary: 'Summary\n"Text";\\',
              keywords: ['Key\n"Word"']
            }
          ]
        }
      };
      
      const vault = buildVaultDirectory(data);
      // We know there's only one ledger file, let's find it
      const ledgerFile = Object.keys(vault).find(f => f.startsWith("Ledger/"));
      expect(ledgerFile).toBeDefined();
      
      const content = vault[ledgerFile!].toString("utf-8");
      
      // Look for the escaped strings in the YAML frontmatter
      expect(content).toContain(`project: "Project \\"Name\\""`);
      expect(content).toContain(`summary: "Summary \\"Text\\";\\\\"`);
      expect(content).toContain(`tags: ["Key \\"Word\\""]`);
    });

    it("handles undefined or null yaml fields", () => {
       const data = {
        prism_export: {
          project: null as any,
          ledger: [
            {
              summary: null as any,
              keywords: null as any
            }
          ]
        }
      };
      
      const vault = buildVaultDirectory(data);
      const ledgerFile = Object.keys(vault).find(f => f.startsWith("Ledger/"));
      expect(ledgerFile).toBeDefined();
      
      const content = vault[ledgerFile!].toString("utf-8");
      expect(content).toContain(`project: "Unknown_Project"`);
      expect(content).toContain(`summary: "No summary"`);
      // null keywords is converted to empty array before escaping in the implementation
      expect(content).toContain(`tags: []`);
    });
  });
});
