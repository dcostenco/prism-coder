import { beforeEach, describe, expect, it, vi } from 'vitest';
const { create, googleGenerate, anthropicCreate } = vi.hoisted(() => { process.env.GOOGLE_API_KEY = 'local-test-key'; return { create: vi.fn(), googleGenerate: vi.fn(), anthropicCreate: vi.fn() }; });
vi.mock('openai', () => ({ default: class { chat = { completions: { create } }; } }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel = (request: any) => ({ generateContent: (prompt: string) => googleGenerate(request, prompt) }); }, TaskType: { SEMANTIC_SIMILARITY: 'SEMANTIC_SIMILARITY' } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: anthropicCreate }; } }));
vi.mock('../../src/storage/configStorage.js', () => ({ getSettingSync: (key: string, fallback: string) => key === 'openai_base_url' ? 'http://127.0.0.1:11434/v1' : key === 'anthropic_api_key' ? 'local-test-key' : fallback }));
import { OpenAIAdapter } from '../../src/utils/llm/adapters/openai.js';
import { TracingLLMProvider } from '../../src/utils/llm/adapters/traced.js';
import { invokeClawAgent } from '../../src/darkfactory/clawInvocation.js';

beforeEach(() => { create.mockReset(); googleGenerate.mockReset(); anthropicCreate.mockReset(); create.mockResolvedValue({ choices: [{ message: { content: '{"pass":true}' } }] }); });
describe('Factory structured model requests', () => {
  it('leaves room for thinking before a Factory evaluator emits its JSON', async () => {
    vi.useFakeTimers();
    try {
      const spec = { objective: 'Fix source.cjs and verify its tests.', maxIterations: 3, modelOverride: 'isolated-test-model' };
      const state = { id: 'budget-fixture', project: 'fixture', status: 'RUNNING', current_step: 'EVALUATE', iteration: 0, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), spec: JSON.stringify(spec), contract_payload: JSON.stringify({ criteria: [{ id: 'one', description: 'Independent tests pass' }] }) };
      await invokeClawAgent(spec, state as any);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ response_format: { type: 'json_object' }, max_tokens: 4096 }));
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('sends JSON mode and the requested model instead of silently using the configured default', async () => {
    const value = await new OpenAIAdapter().generateText('Return a JSON evaluation.', 'Factory evaluation', { json: true, model: 'isolated-test-model' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'isolated-test-model', response_format: { type: 'json_object' } }));
    expect(value).toBe('{"pass":true}');
  });
  it('preserves ordinary text requests without forcing JSON output', async () => {
    await new OpenAIAdapter().generateText('Explain the code.');
    const request = create.mock.calls[0][0];
    expect(request).not.toHaveProperty('response_format');
    expect(request.model).toBe('gpt-4o-mini');
  });
  it('preserves JSON/model/output-budget options through the actual tracing decorator', async () => {
    const decorated = new TracingLLMProvider(new OpenAIAdapter(), 'openai');
    await decorated.generateText('Return a JSON object.', undefined, { json: true, model: 'isolated-test-model', maxOutputTokens: 2048 });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'isolated-test-model', response_format: { type: 'json_object' }, max_tokens: 2048 }));
  });
});

describe('provider structured generation requests', () => {
  it('Gemini sends model, JSON mime type, and output budget', async () => {
    process.env.GOOGLE_API_KEY = 'local-test-key';
    googleGenerate.mockResolvedValue({ response: { text: () => '{"ok":true}' } });
    const { GeminiAdapter } = await import('../../src/utils/llm/adapters/gemini.js');
    const value = await new GeminiAdapter().generateText('json', 'system', { json: true, model: 'gemini-test', maxOutputTokens: 321 });
    expect(googleGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-test', generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 321 }, systemInstruction: 'system' }), 'json');
    expect(value).toBe('{"ok":true}');
  });
  it('Gemini ordinary text keeps default request shape', async () => {
    process.env.GOOGLE_API_KEY = 'local-test-key';
    googleGenerate.mockResolvedValue({ response: { text: () => 'plain' } });
    const { GeminiAdapter } = await import('../../src/utils/llm/adapters/gemini.js');
    await new GeminiAdapter().generateText('plain');
    expect(googleGenerate).toHaveBeenCalledWith(expect.objectContaining({ model: expect.any(String) }), 'plain');
    expect(googleGenerate.mock.calls[0][0]).not.toHaveProperty('generationConfig');
  });
  it('Anthropic forces emit_json tool use and returns serialized input', async () => {
    anthropicCreate.mockResolvedValue({ content: [{ type: 'tool_use', input: { ok: true } }] });
    const { AnthropicAdapter } = await import('../../src/utils/llm/adapters/anthropic.js');
    const value = await new AnthropicAdapter().generateText('json', undefined, { json: true, model: 'claude-test', maxOutputTokens: 222 });
    expect(anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'claude-test', max_tokens: 222, tool_choice: { type: 'tool', name: 'emit_json' }, tools: [expect.objectContaining({ name: 'emit_json' })] }));
    expect(value).toBe('{"ok":true}');
  });
  it('Anthropic rejects JSON responses without the required tool block and preserves ordinary text', async () => {
    anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'wrong' }] });
    const { AnthropicAdapter } = await import('../../src/utils/llm/adapters/anthropic.js');
    await expect(new AnthropicAdapter().generateText('json', undefined, { json: true })).rejects.toThrow(/Structured response missing/);
    anthropicCreate.mockResolvedValueOnce({ content: [{ type: 'text', text: 'plain' }] });
    expect(await new AnthropicAdapter().generateText('plain')).toBe('plain');
    expect(anthropicCreate.mock.calls[1][0]).not.toHaveProperty('tools');
  });
});
