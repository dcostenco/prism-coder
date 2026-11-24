import { beforeEach, describe, expect, it, vi } from 'vitest';
const { create, googleGenerate, anthropicCreate, sdkOptions, policy } = vi.hoisted(() => {
  process.env.GOOGLE_API_KEY = 'local-test-key';
  return { create: vi.fn(), googleGenerate: vi.fn(), anthropicCreate: vi.fn(), sdkOptions: vi.fn(),
    policy: { force: false, baseURL: 'http://127.0.0.1:11434/v1', key: 'local-test-key' } };
});
vi.mock('openai', () => ({ default: class {
  constructor(options: unknown) { sdkOptions(options); }
  chat = { completions: { create } };
} }));
vi.mock('@google/generative-ai', () => ({ GoogleGenerativeAI: class { getGenerativeModel = (request: any) => ({ generateContent: (...args: [string, unknown?]) => googleGenerate(request, ...args) }); }, TaskType: { SEMANTIC_SIMILARITY: 'SEMANTIC_SIMILARITY' } }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: anthropicCreate }; } }));
vi.mock('../../src/storage/configStorage.js', () => ({ getSettingSync: (key: string, fallback: string) =>
  key === 'openai_base_url' ? policy.baseURL
    : key === 'openai_api_key' ? policy.key : key === 'anthropic_api_key' ? 'local-test-key' : fallback }));
vi.mock('../../src/config.js', async original => ({
  ...await original<typeof import('../../src/config.js')>(), get PRISM_FORCE_LOCAL() { return policy.force; },
}));
import { OpenAIAdapter } from '../../src/utils/llm/adapters/openai.js';
import { TracingLLMProvider } from '../../src/utils/llm/adapters/traced.js';
import { invokeClawAgent } from '../../src/darkfactory/clawInvocation.js';

beforeEach(() => {
  create.mockReset(); googleGenerate.mockReset(); anthropicCreate.mockReset(); sdkOptions.mockClear();
  policy.force = false; policy.baseURL = 'http://127.0.0.1:11434/v1'; policy.key = 'local-test-key';
  create.mockResolvedValue({ choices: [{ message: { content: '{"pass":true}' } }] });
});
describe('Factory structured model requests', () => {
  it('refuses a hosted Factory override before opening any provider in local-only mode', async () => {
    policy.force = true;
    policy.baseURL = 'https://provider.example.test/v1';
    vi.useFakeTimers();
    try {
      const result = await invokeClawAgent({ objective: 'Local fixture', maxIterations: 1, modelOverride: 'fixture-model' },
        { id: 'local-fixture', current_step: 'PLAN', project: 'fixture' } as any);
      expect(result).toMatchObject({ success: false, resultText: expect.stringMatching(/loopback/) });
      expect(sdkOptions).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('blocks Factory redirects on a valid local override and preserves the requested model', async () => {
    policy.force = true;
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await invokeClawAgent({ objective: 'Local fixture', maxIterations: 1, modelOverride: 'fixture-model' },
        { id: 'local-fixture', current_step: 'PLAN', project: 'fixture' } as any);
      expect(result.success).toBe(true);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture-model' }));
      const url = policy.baseURL + '/chat/completions';
      await sdkOptions.mock.calls[0][0].fetch(url, { redirect: 'follow' });
      expect(fetchMock).toHaveBeenCalledWith(url, { redirect: 'error' });
    } finally { vi.unstubAllGlobals(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('leaves room for thinking before a Factory evaluator emits its JSON', async () => {
    vi.useFakeTimers();
    try {
      const spec = { objective: 'Fix source.cjs and verify its tests.', maxIterations: 3, modelOverride: 'isolated-test-model' };
      const state = { id: 'budget-fixture', project: 'fixture', status: 'RUNNING', current_step: 'EVALUATE', iteration: 0, started_at: new Date().toISOString(), updated_at: new Date().toISOString(), spec: JSON.stringify(spec), contract_payload: JSON.stringify({ criteria: [{ id: 'one', description: 'Independent tests pass' }] }) };
      await invokeClawAgent(spec, state as any);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ response_format: { type: 'json_object' }, max_tokens: 4096 }));
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('runs a keyless IPv6 loopback Factory override', async () => {
    policy.force = true;
    policy.baseURL = 'http://[::1]:11434/v1';
    policy.key = '';
    vi.useFakeTimers();
    try {
      const result = await invokeClawAgent({ objective: 'Local fixture', maxIterations: 1, modelOverride: 'fixture-model' },
        { id: 'local-fixture', current_step: 'PLAN', project: 'fixture' } as any);
      expect(result.success).toBe(true);
      expect(sdkOptions).toHaveBeenCalledWith(expect.objectContaining({ baseURL: policy.baseURL, apiKey: 'ollama' }));
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ model: 'fixture-model' }));
    } finally { vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('requires a key when a remote compatible hostname only resembles loopback', () => {
    policy.baseURL = 'http://localhost.fixture.test/v1';
    policy.key = '';
    expect(() => new OpenAIAdapter()).toThrow(/API key is not set/);
    expect(sdkOptions).not.toHaveBeenCalled();
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
  it('passes caller cancellation to each configured text transport', async () => {
    const { signal } = new AbortController();
    const { AnthropicAdapter } = await import('../../src/utils/llm/adapters/anthropic.js');
    const { GeminiAdapter } = await import('../../src/utils/llm/adapters/gemini.js');
    anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'plain' }] });
    googleGenerate.mockResolvedValue({ response: { text: () => 'plain' } });
    await new TracingLLMProvider(new OpenAIAdapter(), 'openai').generateText('plain', undefined, { signal });
    await new AnthropicAdapter().generateText('plain', undefined, { signal });
    await new GeminiAdapter().generateText('plain', undefined, { signal });
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { signal });
    expect(anthropicCreate).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { signal });
    expect(googleGenerate).toHaveBeenCalledExactlyOnceWith(expect.any(Object), 'plain', { signal });
  });
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

  it.each(['openai', 'anthropic', 'gemini'] as const)('%s requires completion for protected text alone', async provider => {
    const { AnthropicAdapter } = await import('../../src/utils/llm/adapters/anthropic.js');
    const { GeminiAdapter } = await import('../../src/utils/llm/adapters/gemini.js');
    const body = 'Synthetic rollup text.';
    const stop = { openai: 'stop', anthropic: 'end_turn', gemini: 'STOP' }[provider];
    const limit = { openai: 'length', anthropic: 'max_tokens', gemini: 'MAX_TOKENS' }[provider];
    const response = (reason?: string) => {
      switch (provider) {
        case 'openai':
          create.mockResolvedValue({ choices: [{ finish_reason: reason, message: { role: 'assistant', content: body } }] });
          return new OpenAIAdapter();
        case 'anthropic':
          anthropicCreate.mockResolvedValue({ stop_reason: reason, content: [{ type: 'text', text: body }] });
          return new AnthropicAdapter();
        case 'gemini':
          googleGenerate.mockResolvedValue({ response: { candidates: [{ finishReason: reason }], text: () => body } });
          return new GeminiAdapter();
      }
    };
    const protectedText = new TracingLLMProvider(response(limit), provider);
    const options = { requireCompleteResponse: true };
    await expect(protectedText.generateText('Compact fixture entries.', undefined, options)).rejects.toThrow(/did not complete/);
    await expect(response().generateText('Compact fixture entries.', undefined, options)).rejects.toThrow(/did not complete/);
    await expect(response(stop).generateText('Compact fixture entries.', undefined, options)).resolves.toBe(body);
    await expect(response(limit).generateText('Ordinary text.')).resolves.toBe(body);
  });
});
