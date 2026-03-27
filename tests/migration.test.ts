import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { universalImporter } from '../src/utils/universalImporter.js';
import { claudeAdapter } from '../src/utils/migration/claudeAdapter.js';
import { geminiAdapter } from '../src/utils/migration/geminiAdapter.js';
import { openaiAdapter } from '../src/utils/migration/openaiAdapter.js';

const TMP_DIR = path.join(process.cwd(), 'tests', '.tmp', 'migration-tests');
if (!fs.existsSync(TMP_DIR)) {
  fs.mkdirSync(TMP_DIR, { recursive: true });
}

// Mock storage
vi.mock('../src/storage/index.js', () => ({
  getStorage: vi.fn(() => ({
    saveLedger: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe('Migration Utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    // Cleanup
    if (fs.existsSync(TMP_DIR)) {
      fs.rmSync(TMP_DIR, { recursive: true, force: true });
    }
  });

  describe('Claude Adapter', () => {
    it('should deduplicate streaming chunks by message.id', async () => {
      const filePath = path.join(TMP_DIR, 'test.jsonl');
      const mockData = [
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Hello' }] }, timestamp: '2024-01-01T00:00:00Z' }),
        JSON.stringify({ type: 'assistant', message: { id: 'msg1', content: [{ text: 'Hello world' }] }, timestamp: '2024-01-01T00:00:01Z' }),
        JSON.stringify({ type: 'user', content: 'Hi', timestamp: '2024-01-01T00:00:02Z' }),
      ].join('\n');
      fs.writeFileSync(filePath, mockData);

      const turns: any[] = [];
      await claudeAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(2);
      expect(turns.find(t => t.role === 'assistant').content).toBe('Hello world');
    });
  });

  describe('Gemini Adapter', () => {
    it('should map "model" role to "assistant"', async () => {
      const filePath = path.join(TMP_DIR, 'gemini.json');
      const mockData = JSON.stringify([
        { role: 'user', parts: [{ text: 'Hi' }], createTime: '2024-01-01T00:00:00Z' },
        { role: 'model', parts: [{ text: 'Hello' }], createTime: '2024-01-01T00:00:01Z' },
      ]);
      fs.writeFileSync(filePath, mockData);

      const turns: any[] = [];
      await geminiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns).toHaveLength(2);
      expect(turns[1].role).toBe('assistant');
    });
  });

  describe('OpenAI Adapter', () => {
    it('should normalize tool calls into content', async () => {
      const filePath = path.join(TMP_DIR, 'openai.json');
      const mockData = JSON.stringify([
        { 
          role: 'assistant', 
          content: 'Running tool...', 
          tool_calls: [{ id: 'call1', function: { name: 'get_weather' } }],
          created_at: 1704067200 
        },
      ]);
      fs.writeFileSync(filePath, mockData);

      const turns: any[] = [];
      await openaiAdapter.parse(filePath, async (turn) => {
        turns.push(turn);
      });

      expect(turns[0].content).toContain('[Tool Use: get_weather]');
      expect(turns[0].timestamp).toBe(new Date(1704067200 * 1000).toISOString());
    });
  });

  describe('Universal Importer (Orchestrator)', () => {
    it('should handle large-file OOM safety via temporary file', async () => {
      const filePath = path.join(TMP_DIR, 'massive.jsonl');
      const stream = fs.createWriteStream(filePath);
      for (let i = 0; i < 100; i++) {
        stream.write(JSON.stringify({ 
          role: 'user', 
          content: `Turn ${i}`, 
          timestamp: new Date().toISOString() 
        }) + '\n');
      }
      stream.end();
      
      // Wait for write to finish
      await new Promise<void>(resolve => stream.on('finish', () => resolve()));

      const result = await universalImporter({
        format: 'claude',
        path: filePath,
        project: 'test-project',
        dryRun: true,
        verbose: false
      });

      expect(result.successCount).toBe(100);
    });
  });
});
