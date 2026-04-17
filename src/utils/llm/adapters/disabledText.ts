import type { LLMProvider } from "../provider.js";

export class DisabledTextAdapter implements LLMProvider {
  async generateText(_prompt: string, _systemInstruction?: string): Promise<string> {
    throw new Error(
      "Text generation is not available. " +
      "Configure an AI provider in the Mind Palace dashboard."
    );
  }

  async generateEmbedding(_text: string): Promise<number[]> {
    throw new Error(
      "[DisabledTextAdapter] Embedding is handled by a separate adapter — this method should not be called directly."
    );
  }
}
