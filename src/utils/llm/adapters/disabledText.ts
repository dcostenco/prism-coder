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
      "[DisabledTextAdapter] generateEmbedding should not be called directly. " +
      "The factory routes embeddings to LocalEmbeddingAdapter."
    );
  }
}
