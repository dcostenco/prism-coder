import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/storage/configStorage.js', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { getSetting, setSetting } from '../../src/storage/configStorage.js';
import { parseLocalImageSettings, readLocalImageSettings, saveLocalImageSettings } from '../../src/utils/localImageSettings.js';
import { readLocalCodingSettings, saveLocalCodingSettings } from '../../src/utils/localCodingSettings.js';

describe('independent image selections', () => {
    beforeEach(() => vi.resetAllMocks());
    afterEach(() => vi.unstubAllEnvs());
    it('starts unset and ignores coding backend overrides', async () => {
        vi.stubEnv('PRISM_LOCAL_CODING_BACKEND', 'omlx');
        vi.mocked(getSetting).mockResolvedValue('');
        expect(await readLocalImageSettings()).toEqual({});
        expect(getSetting).toHaveBeenCalledExactlyOnceWith('local_image_config_v1', '', { fresh: true });
    });
    it('accepts future backend-bound IDs, including one shared with coding roles', () => {
        const input = { backend: 'omlx', models: { omlx: 'vendor/future-build', ollama: 'org/future:latest' } };
        expect(parseLocalImageSettings(input)).toEqual(input);
        expect(parseLocalImageSettings({ models: input.models })).toEqual({ models: input.models });
        expect(parseLocalImageSettings({ backend: 'ollama' })).toEqual({ backend: 'ollama' });
        expect(parseLocalImageSettings({})).toEqual({});
        expect(parseLocalImageSettings(input).models).not.toBe(input.models);
    });
    it('never imports inherited selections', () => {
        expect(parseLocalImageSettings(Object.create({ backend: 'omlx', models: { omlx: 'phantom' } }))).toEqual({});
        expect(parseLocalImageSettings({ models: Object.create({ omlx: 'phantom' }) })).toEqual({ models: {} });
    });
    it.each([
        null, [], 'omlx', { backend: 'auto' }, { backend: 'cloud' }, { backend: null },
        { models: null }, { models: [] }, { models: 'model' }, { models: { cloud: 'model' } },
        { models: { omlx: '' } }, { models: { ollama: 'bad\nmodel' } }, { models: { omlx: 9 } },
        { models: { omlx: 'x'.repeat(257) } }, { model: 'unbound' }, { source: 'managed' },
        { enabled: true }, { qualified: true }, { receipt: 'caller-supplied' }, { apiKey: 'not-allowed' },
    ])('rejects invalid selection or client readiness: %j', value => {
        expect(() => parseLocalImageSettings(value)).toThrow('local_image_preference_invalid');
    });
    it('refuses corrupted persisted data rather than silently returning an unset selection', async () => {
        vi.mocked(getSetting).mockResolvedValueOnce('{bad json').mockResolvedValueOnce('{"backend":"auto"}');
        await expect(readLocalImageSettings()).rejects.toThrow();
        await expect(readLocalImageSettings()).rejects.toThrow('local_image_preference_invalid');
    });
    it('preserves coding bytes across independent concurrent saves and fresh reads', async () => {
        const legacy = '{"backend":"omlx","source":"existing","model":"legacy-build"}';
        const originalCoding = '{"backend":"auto","source":"existing","models":{"omlx":{"coder":"shared-build","reviewer":"shared-build"}}}';
        const store = new Map([['local_coding_config', legacy], ['local_coding_config_v2', originalCoding]]);
        vi.mocked(getSetting).mockImplementation(async key => store.get(key) ?? '');
        vi.mocked(setSetting).mockImplementation(async (key, value) => { store.set(key, value); });
        const images = { backend: 'omlx', models: { omlx: 'shared-build', ollama: 'future:tag' } };
        await saveLocalImageSettings(images);
        expect(store.get('local_coding_config_v2')).toBe(originalCoding);
        expect(store.get('local_coding_config')).toBe(legacy);
        const coding = { backend: 'ollama', source: 'existing', models: { ollama: { coder: 'next:tag', reviewer: 'next:tag' } } };
        await Promise.all([saveLocalCodingSettings(coding), saveLocalImageSettings(images)]);
        expect(await readLocalImageSettings()).toEqual(images);
        expect(await readLocalCodingSettings()).toEqual(coding);
        expect(store.get('local_coding_config')).toBe(legacy);
        await saveLocalImageSettings({});
        expect(await readLocalImageSettings()).toEqual({});
        expect(await readLocalCodingSettings()).toEqual(coding);
        expect(setSetting).toHaveBeenCalledWith('local_image_config_v1', '{}');
    });
    it('validates before storage and propagates failed saves', async () => {
        await expect(saveLocalImageSettings({ enabled: true })).rejects.toThrow();
        expect(setSetting).not.toHaveBeenCalled();
        vi.mocked(setSetting).mockRejectedValueOnce(new Error('storage unavailable'));
        await expect(saveLocalImageSettings({ backend: 'omlx' })).rejects.toThrow('storage unavailable');
    });
});
