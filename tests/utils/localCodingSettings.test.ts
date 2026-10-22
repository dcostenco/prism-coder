import { describe, expect, it, vi, beforeEach } from 'vitest';
vi.mock('../../src/storage/configStorage.js', () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));
import { getSetting, setSetting } from '../../src/storage/configStorage.js';
import { parseLocalCodingSettings, readLocalCodingSettings, saveLocalCodingSettings, resolveLocalCodingModel } from '../../src/utils/localCodingSettings.js';
const base = { backend: 'auto', source: 'existing' };
const assignments = { omlx: { coder: 'vendor/new-build', reviewer: 'vendor/new-build' }, ollama: { coder: 'org/future:latest', reviewer: 'different:tag' } };
describe('local coding model assignments', () => {
    beforeEach(() => vi.resetAllMocks());
    it('allows arbitrary model versions and the same model for both roles on both backends', () => {
        const value = { ...base, models: assignments };
        expect(parseLocalCodingSettings(value)).toEqual(value);
        expect(parseLocalCodingSettings({ ...base, models: { ollama: { coder: 'same:tag', reviewer: 'same:tag' } } }).models?.ollama).toEqual({ coder: 'same:tag', reviewer: 'same:tag' });
    });
    it('selects exact backend and role, with explicit overrides first', () => {
        const settings = parseLocalCodingSettings({ ...base, model: 'legacy', models: assignments });
        expect(resolveLocalCodingModel(settings, 'omlx', 'coder')).toBe('vendor/new-build');
        expect(resolveLocalCodingModel(settings, 'omlx', 'reviewer')).toBe('vendor/new-build');
        expect(resolveLocalCodingModel(settings, 'ollama', 'coder')).toBe('org/future:latest');
        expect(resolveLocalCodingModel(settings, 'ollama', 'reviewer', 'one-off:tag')).toBe('one-off:tag');
    });
    it('preserves legacy coder only, with no implicit writer-as-reviewer choice', () => {
        const legacy = parseLocalCodingSettings({ ...base, model: 'legacy' });
        expect(resolveLocalCodingModel(legacy, 'omlx', 'coder')).toBe('legacy');
        expect(resolveLocalCodingModel(legacy, 'omlx', 'reviewer')).toBeUndefined();
        expect(resolveLocalCodingModel(legacy, 'ollama', 'coder')).toBeUndefined();
        expect(resolveLocalCodingModel(parseLocalCodingSettings(base), 'omlx', 'coder')).toBeUndefined();
    });
    it.each([null, [], { cloud: {} }, { omlx: [] }, { ollama: null }, { omlx: { router: 'x' } }, { omlx: { coder: '' } }, { ollama: { reviewer: 'a\nb' } }, { omlx: { coder: 3 } }, { omlx: { coder: 'x'.repeat(257) } }])('rejects malformed assignments: %j', models => {
        expect(() => parseLocalCodingSettings({ ...base, models })).toThrow('local_coding_preference_invalid');
    });
    it('does not accept inherited roles or backend values as saved assignments', () => {
        expect(parseLocalCodingSettings({ ...base, models: { omlx: Object.create({ coder: 'phantom' }) } }).models?.omlx?.coder).toBeUndefined();
        expect(() => parseLocalCodingSettings(Object.create(base))).toThrow();
    });
    it('reads fresh persisted changes and rejects bad saves before storage mutation', async () => {
        vi.mocked(getSetting).mockResolvedValueOnce(JSON.stringify({ ...base, models: assignments })).mockResolvedValueOnce(JSON.stringify(base));
        expect((await readLocalCodingSettings()).models).toEqual(assignments);
        expect((await readLocalCodingSettings()).models).toBeUndefined();
        expect(getSetting).toHaveBeenLastCalledWith('local_coding_config_v2', '', { fresh: true });
        await expect(saveLocalCodingSettings({ ...base, models: { omlx: { coder: '' } } })).rejects.toThrow();
        expect(setSetting).not.toHaveBeenCalled();
        await saveLocalCodingSettings({ ...base, models: assignments });
        expect(setSetting).toHaveBeenCalledWith('local_coding_config_v2', JSON.stringify({ ...base, models: assignments }));
    });
    it('reads legacy settings before the first new save and preserves them for old processes and rollback', async () => {
        const legacy = JSON.stringify({ backend: 'omlx', source: 'existing', model: 'previous-model' });
        const store = new Map([['local_coding_config', legacy]]);
        vi.mocked(getSetting).mockImplementation(async key => store.get(key) ?? '');
        vi.mocked(setSetting).mockImplementation(async (key, value) => { store.set(key, value); });
        expect(await readLocalCodingSettings()).toEqual(JSON.parse(legacy));
        const next = { ...base, models: assignments };
        await saveLocalCodingSettings(next);
        expect(store.get('local_coding_config')).toBe(legacy);
        expect(Object.keys(JSON.parse(store.get('local_coding_config')!)).sort()).toEqual(['backend','model','source']);
        expect(await readLocalCodingSettings()).toEqual(next);
        await saveLocalCodingSettings({ ...base, models: {} });
        expect((await readLocalCodingSettings()).model).toBeUndefined();
        expect(store.get('local_coding_config')).toBe(legacy);
    });
});
