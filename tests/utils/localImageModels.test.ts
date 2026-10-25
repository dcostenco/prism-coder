import { describe, expect, it } from 'vitest';
import { advertisedImageCapability } from '../../src/utils/localImageModels.js';

describe('advertised image capability is evidence, never model-name guessing', () => {
    it('uses the exact oMLX engine advertisement, independently of the model name', () => {
        expect(advertisedImageCapability('omlx', { engine_type: 'vlm' })).toEqual({ vision: 'yes', source: 'omlx.engine_type' });
        expect(advertisedImageCapability('omlx', { engine_type: 'llm', id: 'vision-9b' })).toEqual({ vision: 'no', source: 'omlx.engine_type' });
        expect(advertisedImageCapability('omlx', { id: 'vision-9b' }).vision).toBe('unknown');
    });
    it('requires a well-formed exact Ollama show capabilities array', () => {
        expect(advertisedImageCapability('ollama', { capabilities: ['completion', 'vision'] })).toEqual({ vision: 'yes', source: 'ollama.show.capabilities' });
        expect(advertisedImageCapability('ollama', { capabilities: ['completion'] }).vision).toBe('no');
        for (const capabilities of [undefined, null, 'vision', ['vision', 3], new Array(2), Array(65).fill('vision')]) {
            expect(advertisedImageCapability('ollama', { capabilities }).vision).toBe('unknown');
        }
    });
    it('does not accept inherited evidence or infer qualification', () => {
        for (const backend of ['omlx', 'ollama'] as const) {
            const result = advertisedImageCapability(backend, Object.create({ engine_type: 'vlm', capabilities: ['vision'] }));
            expect(result).toEqual({ vision: 'unknown', source: 'metadata_unavailable' });
            expect(Object.keys(result).sort()).toEqual(['source', 'vision']);
        }
    });
});
