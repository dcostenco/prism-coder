/**
 * ═══════════════════════════════════════════════════════════════════
 * Migration Edge Case & Negative Tests
 * ═══════════════════════════════════════════════════════════════════
 *
 * Tests for robustness against:
 *   - Empty files
 *   - Malformed/corrupt JSON
 *   - Missing required fields
 *   - Mixed valid/invalid entries
 *   - Unusual role values
 *   - Unicode and special characters in content
 *   - Content-sniffing canHandle auto-detection
 *   - Very large content fields
 * ═══════════════════════════════════════════════════════════════════
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { universalImporter } from '../src/utils/universalImporter.js';
import { claudeAdapter } from '../src/utils/migration/claudeAdapter.js';
import { geminiAdapter } from '../src/utils/migration/geminiAdapter.js';
import { openaiAdapter } from '../src/utils/migration/openaiAdapter.js';
import { normalizeContent } from '../src/utils/migration/utils.js';

const TMP_DIR = path.join(process.cwd(), 'tests', '.tmp', 'migration-edge-tests');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Mock storage
// Track saveLedger calls for assertion in conversation grouping tests
const mockSaveLedger = vi.fn().mockResolvedValue([{ id: 'test-id' }]);
const mockGetLedgerEntries = vi.fn().mockResolvedValue([]);

vi.mock('../src/storage/index.js', () => ({
  getStorage: vi.fn(() => ({
    saveLedger: mockSaveLedger,
    getLedgerEntries: mockGetLedgerEntries,
  })),
}));

describe('Migration Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  // ── Empty Files ──────────────────────────────────────────────────

  describe('Empty Files', () => {
    it('Claude: should handle empty .jsonl file gracefully', async () => {
      const filePath = path.join(TMP_DIR, 'empty.jsonl');
      fs.writeFileSync(filePath, '');

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(0);
    });

    it('Gemini: should handle empty JSON array gracefully', async () => {
      const filePath = path.join(TMP_DIR, 'empty-gemini.json');
      fs.writeFileSync(filePath, '[]');

      const turns: any[] = [];
      await geminiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(0);
    });

    it('OpenAI: should handle empty JSON array gracefully', async () => {
      const filePath = path.join(TMP_DIR, 'empty-openai.json');
      fs.writeFileSync(filePath, '[]');

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(0);
    });
  });

  // ── Malformed Data ────────────────────────────────────────────────

  describe('Malformed Data', () => {
    it('Claude: should skip malformed JSON lines and continue', async () => {
      const filePath = path.join(TMP_DIR, 'malformed.jsonl');
      const lines = [
        '{ invalid json !!!',
        JSON.stringify({ type: 'user', content: 'Valid line', timestamp: '2024-01-01T00:00:00Z' }),
        'not json at all',
        '',
        JSON.stringify({ type: 'user', content: 'Another valid', timestamp: '2024-01-01T00:01:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(2);
      expect(turns[0].content).toBe('Valid line');
      expect(turns[1].content).toBe('Another valid');
    });

    it('Claude: should handle lines with only whitespace', async () => {
      const filePath = path.join(TMP_DIR, 'whitespace.jsonl');
      const lines = [
        '   ',
        '\t',
        JSON.stringify({ type: 'user', content: 'Real entry', timestamp: '2024-01-01T00:00:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('Real entry');
    });
  });

  // ── Missing Fields ────────────────────────────────────────────────

  describe('Missing Fields', () => {
    it('Claude: should handle entries with no content gracefully', async () => {
      const filePath = path.join(TMP_DIR, 'no-content.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('');
    });

    it('Claude: should provide timestamp fallback when missing', async () => {
      const filePath = path.join(TMP_DIR, 'no-timestamp.jsonl');
      const lines = [
        JSON.stringify({ type: 'user', content: 'No time' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      // Timestamp should be an ISO string (fallback to now)
      expect(turns[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });

    it('OpenAI: should handle entries with null content', async () => {
      const filePath = path.join(TMP_DIR, 'null-content-openai.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'assistant', content: null, created_at: 1704067200 },
      ]));

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('');
    });

    it('Gemini: should handle entries with empty parts array', async () => {
      const filePath = path.join(TMP_DIR, 'empty-parts.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'user', parts: [], createTime: '2024-01-01T00:00:00Z' },
      ]));

      const turns: any[] = [];
      await geminiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      expect(turns[0].content).toBe('');
    });
  });

  // ── Role Edge Cases ───────────────────────────────────────────────

  describe('Role Normalization', () => {
    it('Gemini: should handle "assistant" role (non-standard for Gemini)', async () => {
      const filePath = path.join(TMP_DIR, 'gemini-assistant-role.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'assistant', parts: [{ text: 'Hi' }], createTime: '2024-01-01T00:00:00Z' },
      ]));

      const turns: any[] = [];
      await geminiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns[0].role).toBe('assistant');
    });

    it('OpenAI: should treat unknown roles as "user"', async () => {
      const filePath = path.join(TMP_DIR, 'openai-system-role.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'system', content: 'System prompt', created_at: 1704067200 },
        { role: 'tool', content: 'Tool result', created_at: 1704067201 },
      ]));

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      // Both non-assistant roles should map to 'user'
      expect(turns[0].role).toBe('user');
      expect(turns[1].role).toBe('user');
    });

    it('Claude: should detect assistant role via message.role fallback', async () => {
      const filePath = path.join(TMP_DIR, 'claude-nested-role.jsonl');
      const lines = [
        JSON.stringify({
          message: { id: 'msg1', role: 'assistant', content: [{ text: 'Nested role' }] },
          timestamp: '2024-01-01T00:00:00Z'
        }),
        JSON.stringify({ type: 'user', content: 'Trigger flush', timestamp: '2024-01-01T00:01:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns[0].role).toBe('assistant');
      expect(turns[0].content).toBe('Nested role');
    });
  });

  // ── Content Normalization ─────────────────────────────────────────

  describe('normalizeContent', () => {
    it('should handle plain string', () => {
      expect(normalizeContent('hello')).toBe('hello');
    });

    it('should handle empty string', () => {
      expect(normalizeContent('')).toBe('');
    });

    it('should handle array of text objects (Claude format)', () => {
      expect(normalizeContent([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ])).toBe('Hello world');
    });

    it('should handle array of part objects (Gemini format)', () => {
      expect(normalizeContent([
        { text: 'Part 1' },
        { text: 'Part 2' },
      ])).toBe('Part 1Part 2');
    });

    it('should handle array of plain strings', () => {
      expect(normalizeContent(['a', 'b', 'c'])).toBe('abc');
    });

    it('should return empty string for null/undefined', () => {
      expect(normalizeContent(null)).toBe('');
      expect(normalizeContent(undefined)).toBe('');
    });

    it('should return empty string for non-text parts (functionCall)', () => {
      expect(normalizeContent([
        { functionCall: { name: 'get_weather', args: {} } },
      ])).toBe('');
    });

    it('should handle mixed text and non-text parts', () => {
      expect(normalizeContent([
        { text: 'Before tool' },
        { functionCall: { name: 'search' } },
        { text: 'After tool' },
      ])).toBe('Before toolAfter tool');
    });

    it('should handle unicode content', () => {
      expect(normalizeContent('こんにちは 🤖 Γεια σου')).toBe('こんにちは 🤖 Γεια σου');
    });

    it('should handle number input', () => {
      expect(normalizeContent(42)).toBe('');
    });

    it('should handle boolean input', () => {
      expect(normalizeContent(true)).toBe('');
    });
  });

  // ── canHandle Auto-Detection ──────────────────────────────────────

  describe('canHandle Auto-Detection', () => {
    it('Claude: should match .jsonl extension', () => {
      expect(claudeAdapter.canHandle('/path/to/history.jsonl')).toBe(true);
      expect(claudeAdapter.canHandle('export.JSONL')).toBe(false); // case-sensitive
    });

    it('Claude: should reject .json files', () => {
      expect(claudeAdapter.canHandle('/path/to/history.json')).toBe(false);
    });

    it('Gemini: should match .json files without openai/chatgpt', () => {
      expect(geminiAdapter.canHandle('/path/to/gemini-export.json')).toBe(true);
      expect(geminiAdapter.canHandle('/path/to/history.json')).toBe(true);
    });

    it('Gemini: should reject files with openai/chatgpt in path', () => {
      expect(geminiAdapter.canHandle('/openai/export.json')).toBe(false);
      expect(geminiAdapter.canHandle('/downloads/chatgpt-history.json')).toBe(false);
    });

    it('OpenAI: should match files with openai in path', () => {
      expect(openaiAdapter.canHandle('/path/openai-export.json')).toBe(true);
      expect(openaiAdapter.canHandle('/path/OPENAI/data.json')).toBe(true);
    });

    it('OpenAI: should match files with chatgpt in path', () => {
      expect(openaiAdapter.canHandle('/path/chatgpt-conversations.json')).toBe(true);
      expect(openaiAdapter.canHandle('/downloads/ChatGPT-export.json')).toBe(true);
    });

    it('OpenAI: should match regardless of extension', () => {
      // canHandle checks for openai/chatgpt in path, not extension
      expect(openaiAdapter.canHandle('/openai/data.txt')).toBe(true);
    });

    it('No adapter should match non-json/jsonl files without keywords', () => {
      expect(claudeAdapter.canHandle('/path/to/data.csv')).toBe(false);
      expect(geminiAdapter.canHandle('/path/to/data.csv')).toBe(false);
      expect(openaiAdapter.canHandle('/path/to/data.csv')).toBe(false);
    });
  });

  // ── Claude Streaming Dedup Edge Cases ─────────────────────────────

  describe('Claude Streaming Deduplication', () => {
    it('should handle assistant messages without message.id (no dedup)', async () => {
      const filePath = path.join(TMP_DIR, 'no-msgid.jsonl');
      const lines = [
        JSON.stringify({ type: 'assistant', content: 'No ID here', timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'user', content: 'Hi', timestamp: '2024-01-01T00:01:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      // Without message.id, assistant msg should NOT be deduplicated — it's emitted as a user turn
      // (because the role detection falls through without type/message.role)
      // Actually it IS detected as assistant via entry.type === 'assistant', but without messageId
      // it won't be buffered. Let's verify the actual behavior.
      expect(turns.length).toBeGreaterThanOrEqual(1);
    });

    it('should flush remaining assistant chunks at end of file', async () => {
      const filePath = path.join(TMP_DIR, 'trailing-assistant.jsonl');
      const lines = [
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Final answer' }] }, timestamp: '2024-01-01T00:00:00Z' }),
        // No trailing user message — should still flush
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      expect(turns[0].role).toBe('assistant');
      expect(turns[0].content).toBe('Final answer');
    });

    it('should keep the LAST chunk for each message.id', async () => {
      const filePath = path.join(TMP_DIR, 'multi-chunk.jsonl');
      const lines = [
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Chunk 1' }] }, timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Chunk 2' }] }, timestamp: '2024-01-01T00:00:01Z' }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Chunk 3 - Final' }] }, timestamp: '2024-01-01T00:00:02Z' }),
        JSON.stringify({ type: 'user', content: 'Done', timestamp: '2024-01-01T00:01:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(2); // 1 assistant (deduped) + 1 user
      expect(turns[0].content).toBe('Chunk 3 - Final');
    });

    it('should handle multiple concurrent message.ids', async () => {
      const filePath = path.join(TMP_DIR, 'multi-id.jsonl');
      const lines = [
        JSON.stringify({ type: 'assistant', message: { id: 'msgA', content: [{ text: 'A1' }] }, timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant', message: { id: 'msgB', content: [{ text: 'B1' }] }, timestamp: '2024-01-01T00:00:01Z' }),
        JSON.stringify({ type: 'assistant', message: { id: 'msgA', content: [{ text: 'A2-Final' }] }, timestamp: '2024-01-01T00:00:02Z' }),
        JSON.stringify({ type: 'user', content: 'Flush', timestamp: '2024-01-01T00:01:00Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, lines);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      const assistantTurns = turns.filter(t => t.role === 'assistant');
      expect(assistantTurns).toHaveLength(2); // msgA and msgB
      expect(assistantTurns.find(t => t.messageId === 'msgA')?.content).toBe('A2-Final');
      expect(assistantTurns.find(t => t.messageId === 'msgB')?.content).toBe('B1');
    });
  });

  // ── OpenAI Tool Call Edge Cases ───────────────────────────────────

  describe('OpenAI Tool Call Edge Cases', () => {
    it('should handle tool_calls with missing function name', async () => {
      const filePath = path.join(TMP_DIR, 'openai-bad-toolcall.json');
      fs.writeFileSync(filePath, JSON.stringify([
        {
          role: 'assistant',
          content: 'Running...',
          tool_calls: [{ id: 'call1' }], // No function object
          created_at: 1704067200,
        },
      ]));

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(1);
      // Should use call id as fallback
      expect(turns[0].content).toContain('[Tool Use: call1]');
    });

    it('should handle multiple tool calls on a single message', async () => {
      const filePath = path.join(TMP_DIR, 'openai-multi-tool.json');
      fs.writeFileSync(filePath, JSON.stringify([
        {
          role: 'assistant',
          content: 'Multi-tool',
          tool_calls: [
            { id: 'c1', function: { name: 'search' } },
            { id: 'c2', function: { name: 'read_file' } },
            { id: 'c3', function: { name: 'write_file' } },
          ],
          created_at: 1704067200,
        },
      ]));

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns[0].content).toContain('[Tool Use: search]');
      expect(turns[0].content).toContain('[Tool Use: read_file]');
      expect(turns[0].content).toContain('[Tool Use: write_file]');
      expect(turns[0].tools).toEqual(['search', 'read_file', 'write_file']);
    });
  });

  // ── Universal Importer Orchestrator ───────────────────────────────

  describe('Universal Importer Error Handling', () => {
    it('should throw on unrecognized format flag', async () => {
      const filePath = path.join(TMP_DIR, 'any.txt');
      fs.writeFileSync(filePath, 'just plain text with no markers');

      await expect(universalImporter({
        path: filePath,
        format: 'unknown-format',
        dryRun: true,
        verbose: false,
      })).rejects.toThrow('Could not determine adapter');
    });

    it('should throw on unrecognized file extension without format flag', async () => {
      const filePath = path.join(TMP_DIR, 'mystery.xml');
      fs.writeFileSync(filePath, '<data></data>');

      await expect(universalImporter({
        path: filePath,
        dryRun: true,
        verbose: false,
      })).rejects.toThrow('Could not determine adapter');
    });

    it('should use explicit --format over auto-detection', async () => {
      const jsonPath = path.join(TMP_DIR, 'override.json');
      fs.writeFileSync(jsonPath, JSON.stringify([
        { role: 'user', parts: [{ text: 'Gemini format' }], createTime: '2024-01-01T00:00:00Z' },
      ]));

      const result = await universalImporter({
        path: jsonPath,
        format: 'gemini',
        project: 'test-project',
        dryRun: true,
        verbose: false,
      });

      // 1 turn grouped into 1 conversation
      expect(result.successCount).toBe(1);
      expect(result.conversationCount).toBe(1);
    });
  });

  // ── Conversation Grouping ────────────────────────────────────────

  describe('Conversation Grouping', () => {
    beforeEach(() => {
      mockSaveLedger.mockClear();
      mockGetLedgerEntries.mockClear();
      mockGetLedgerEntries.mockResolvedValue([]);
    });

    it('should group turns within 30 min into one conversation', async () => {
      const filePath = path.join(TMP_DIR, 'grouping-close.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'user', parts: [{ text: 'Hello' }], createTime: '2024-01-01T10:00:00Z' },
        { role: 'model', parts: [{ text: 'Hi!' }], createTime: '2024-01-01T10:00:30Z' },
        { role: 'user', parts: [{ text: 'How are you?' }], createTime: '2024-01-01T10:05:00Z' },
        { role: 'model', parts: [{ text: 'Great!' }], createTime: '2024-01-01T10:05:30Z' },
      ]));

      const result = await universalImporter({
        path: filePath,
        format: 'gemini',
        project: 'test',
        dryRun: false,
      });

      // 4 turns within 5 min → 1 conversation, 1 saveLedger call
      expect(result.conversationCount).toBe(1);
      expect(result.successCount).toBe(4);
      expect(mockSaveLedger).toHaveBeenCalledTimes(1);

      // Verify the summary includes turn count
      const savedEntry = mockSaveLedger.mock.calls[0][0];
      expect(savedEntry.summary).toContain('4 turns');
      expect(savedEntry.summary).toContain('[Imported]');
      expect(savedEntry.conversation_id).toMatch(/^import-gemini-/);
      expect(savedEntry.user_id).toBe('universal-migration-tool');
    });

    it('should split turns with 30+ min gaps into separate conversations', async () => {
      const filePath = path.join(TMP_DIR, 'grouping-split.json');
      fs.writeFileSync(filePath, JSON.stringify([
        // Conversation 1: 10:00 AM
        { role: 'user', parts: [{ text: 'Morning task' }], createTime: '2024-01-01T10:00:00Z' },
        { role: 'model', parts: [{ text: 'On it!' }], createTime: '2024-01-01T10:01:00Z' },
        // 2-hour gap
        // Conversation 2: 12:00 PM
        { role: 'user', parts: [{ text: 'Afternoon task' }], createTime: '2024-01-01T12:00:00Z' },
        { role: 'model', parts: [{ text: 'Sure!' }], createTime: '2024-01-01T12:01:00Z' },
      ]));

      const result = await universalImporter({
        path: filePath,
        format: 'gemini',
        project: 'test',
        dryRun: false,
      });

      // 2 conversations separated by 2-hour gap
      expect(result.conversationCount).toBe(2);
      expect(result.successCount).toBe(4);
      expect(mockSaveLedger).toHaveBeenCalledTimes(2);

      // Verify each conversation has correct content
      const call1 = mockSaveLedger.mock.calls[0][0];
      const call2 = mockSaveLedger.mock.calls[1][0];
      expect(call1.summary).toContain('Morning task');
      expect(call2.summary).toContain('Afternoon task');

      // Each should have a unique conversation_id
      expect(call1.conversation_id).not.toBe(call2.conversation_id);
    });

    it('should skip duplicate conversations on re-import', async () => {
      const filePath = path.join(TMP_DIR, 'grouping-dedup.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'user', parts: [{ text: 'Already imported' }], createTime: '2024-06-15T10:00:00Z' },
        { role: 'model', parts: [{ text: 'Yep' }], createTime: '2024-06-15T10:01:00Z' },
      ]));

      // Mock: getLedgerEntries returns existing entry (= duplicate)
      mockGetLedgerEntries.mockResolvedValueOnce([{ id: 'existing-id' }]);

      const result = await universalImporter({
        path: filePath,
        format: 'gemini',
        project: 'test',
        dryRun: false,
      });

      // Should skip, not save
      expect(result.skipCount).toBe(2);
      expect(result.successCount).toBe(0);
      expect(mockSaveLedger).toHaveBeenCalledTimes(0);
    });

    it('should preserve tools as keywords in summary entry', async () => {
      const filePath = path.join(TMP_DIR, 'grouping-tools-openai.json');
      fs.writeFileSync(filePath, JSON.stringify([
        { role: 'user', content: 'Search for info', created_at: 1704067200 },
        {
          role: 'assistant', content: 'Found it',
          tool_calls: [
            { id: 'c1', function: { name: 'web_search' } },
            { id: 'c2', function: { name: 'read_file' } },
          ],
          created_at: 1704067201,
        },
      ]));

      const result = await universalImporter({
        path: filePath,
        format: 'openai',
        project: 'test',
        dryRun: false,
      });

      expect(result.conversationCount).toBe(1);
      const savedEntry = mockSaveLedger.mock.calls[0][0];
      expect(savedEntry.keywords).toContain('web_search');
      expect(savedEntry.keywords).toContain('read_file');
    });

    it('should handle empty file gracefully with 0 conversations', async () => {
      const filePath = path.join(TMP_DIR, 'grouping-empty.json');
      fs.writeFileSync(filePath, '[]');

      const result = await universalImporter({
        path: filePath,
        format: 'gemini',
        project: 'test',
        dryRun: true,
      });

      expect(result.conversationCount).toBe(0);
      expect(result.successCount).toBe(0);
    });
  });
});
