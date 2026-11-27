import { describe, expect, it } from 'vitest';
import { getHostImageRoute } from '../../src/tools/hostImageRouting.js';

describe('host image generation routing', () => {
    it.each([
        ['codex', 'codex', 'image_gen'],
        ['gemini-cli-mcp-client', 'gemini', 'mcp_nanobanana_generate_image'],
        ['cursor', 'cursor', 'GenerateImage'],
        ['claude-code', 'claude', 'mcp__nanobanana__generate_image'],
    ])('returns the callable image tool reported by %s without guessing the rendering model', (client, host, tool) => {
        const route = getHostImageRoute({
            image_generation: { available_tools: ['view_image', tool], host_model: 'fixture-chat-model' },
        }, client);
        expect(route).toEqual({ target: 'host', host, reported_host_model: 'fixture-chat-model', tool, image_model: null });
    });

    it('preserves ordinary prompt routing when image capabilities were not supplied', () => {
        expect(getHostImageRoute({ prompt: 'Generate an image of a blue cup.' }, 'codex')).toBeUndefined();
    });

    it('ignores capability reports without an inventory array', () => {
        for (const report of [null, {}, { available_tools: 'image_gen' }]) {
            expect(getHostImageRoute({ image_generation: report }, 'codex')).toBeUndefined();
        }
    });

    it('can route an advertised image tool even when the active chat model is unknown', () => {
        expect(getHostImageRoute({ image_generation: { available_tools: ['GenerateImage'] } }, 'cursor'))
            .toEqual({ target: 'host', host: 'cursor', reported_host_model: null, tool: 'GenerateImage', image_model: null });
    });

    it.each([
        { availableTools: [] },
        { availableTools: ['view_image', 'image_gen_preview_unused'] },
    ])('requires an exact generation tool among $availableTools even for an image-capable model', ({ availableTools }) => {
        expect(getHostImageRoute({
            image_generation: { available_tools: availableTools, host_model: 'fixture-image-model' },
        }, 'codex')).toEqual({ target: 'unavailable', host: 'codex', reported_host_model: 'fixture-image-model', tool: null, image_model: null });
    });

    it('uses the initialized client identity even if the caller claims another host', () => {
        const args = { image_generation: { available_tools: ['image_gen'], host_model: 'fixture-chat-model', host: 'codex' } };
        expect(getHostImageRoute(args, 'unrecognized-client'))
            .toEqual({ target: 'unavailable', host: 'unknown', reported_host_model: 'fixture-chat-model', tool: null, image_model: null });
    });

    it('keeps a Cursor session on its own available tool when its chat model is Claude', () => {
        const report = { host_model: 'claude-fixture', available_tools: ['mcp__nanobanana__generate_image', 'GenerateImage'] };
        expect(getHostImageRoute({ image_generation: report }, 'cursor'))
            .toEqual({ target: 'host', host: 'cursor', reported_host_model: 'claude-fixture', tool: 'GenerateImage', image_model: null });
    });
});
