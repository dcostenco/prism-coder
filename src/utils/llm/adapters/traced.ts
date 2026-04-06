/**
 * TracingLLMProvider — OpenTelemetry Decorator (v4.6.0)
 * ─────────────────────────────────────────────────────────────────────────────
 * PURPOSE:
 *   Wraps any LLMProvider with OTel span instrumentation without modifying
 *   any of the three existing adapters (gemini.ts, openai.ts, anthropic.ts).
 *
 * PATTERN: Decorator (Gang of Four)
 *   Implements LLMProvider and delegates every method call to the wrapped
 *   `inner` provider, bookending each call with an OTel span.
 *
 * WHY NOT INSTRUMENT INSIDE THE ADAPTERS?
 *   1. Single Responsibility — each adapter has one job: talk to its API.
 *   2. DRY — the span pattern is identical across all three adapters.
 *   3. Testability — this class can be tested with a mock inner provider.
 *   4. Composability — future decorators (rate-limiting, caching) layer on
 *      top without touching any adapter code.
 *
 * VLM METHOD OPTIONALITY:
 *   TypeScript class methods always exist on the prototype — even optional ones.
 *   To preserve the `generateImageDescription?` contract (so imageCaptioner.ts's
 *   `if (llm.generateImageDescription)` check works correctly), we assign the
 *   VLM method as an own-property in the constructor only when the inner
 *   adapter supports it. Otherwise the property stays `undefined`.
 *
 * GDPR NOTE ON SPAN ATTRIBUTES:
 *   We log character counts and dimensions — never the full prompt, embedding
 *   vector, or base64 image content. A full prompt stored in Jaeger/Datadog
 *   would be a GDPR compliance risk.
 *
 * SPAN HIERARCHY (example for session_search_memory):
 *   ▼ mcp.call_tool (session_search_memory) [root — server.ts]
 *     ▼ llm.generate_embedding               [this decorator]
 *
 * CONTEXT PROPAGATION:
 *   AsyncLocalStorage (OTel's context mechanism) automatically parents these
 *   spans to the active root span from server.ts. No explicit ref-passing needed.
 *
 * FILE LOCATION: src/utils/llm/adapters/traced.ts
 * IMPORTS FROM:  ../provider.js  (one level up, in src/utils/llm/)
 *                ../../telemetry.js (two levels up, in src/utils/)
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { SpanStatusCode, context, trace } from "@opentelemetry/api";
import type { LLMProvider } from "../provider.js";
import { getTracer } from "../../telemetry.js";

export class TracingLLMProvider implements LLMProvider {
  /**
   * Optional batch embeddings generation support.
   */
  generateEmbeddings?: LLMProvider["generateEmbeddings"];

  /**
   * The optional VLM method is declared here as a typed property so TypeScript
   * knows about it. It is assigned (or left undefined) in the constructor body
   * based on whether the inner adapter supports it.
   *
   * @see constructor for assignment logic
   */
  generateImageDescription?: LLMProvider["generateImageDescription"];

  /**
   * @param inner        The actual LLM adapter (Gemini, OpenAI, or Anthropic).
   * @param providerName Human-readable label used in span attributes.
   *                     factory.ts passes e.g. "gemini", "openai", "anthropic".
   */
  constructor(
    private readonly inner: LLMProvider,
    private readonly providerName: string,
  ) {
    // ── Batch Embeddings: conditional own-property assignment ───────────────
    if (inner.generateEmbeddings) {
      const innerEmbeds = inner.generateEmbeddings.bind(inner);
      const providerName = this.providerName;

      this.generateEmbeddings = async (texts: string[]): Promise<number[][]> => {
        const span = getTracer().startSpan("llm.generate_embeddings_batch", {
          attributes: {
            "llm.provider": providerName,
            "llm.batch_size": texts.length,
          },
        });

        return context.with(trace.setSpan(context.active(), span), async () => {
          try {
            const result = await innerEmbeds(texts);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    }
    // ── VLM method: conditional own-property assignment ──────────────────
    // REVIEWER NOTE: TypeScript class methods always appear on the prototype,
    // which means `if (llm.generateImageDescription)` would always be truthy
    // even if we wrote `generateImageDescription?() {}` as a class method.
    // Assigning as an own-property in the constructor and leaving it undefined
    // when the inner adapter has no VLM support is the correct TypeScript
    // pattern for preserving optional interface method semantics.
    if (inner.generateImageDescription) {
      const innerVlm = inner.generateImageDescription.bind(inner);
      const providerName = this.providerName; // capture for closure (avoids 'this' ambiguity)

      this.generateImageDescription = async (
        imageBase64: string,
        mimeType: string,
        ctx?: string,
      ): Promise<string> => {
        /**
         * Span: llm.generate_image_description
         *
         * VLM calls are the most expensive operations in Prism (2–5 seconds).
         * We log the image size (bytes) as a cost proxy but NOT the base64
         * content itself — storing megabytes in OTLP backends causes OOM in
         * most collector configurations and violates GDPR data minimization.
         */
        const span = getTracer().startSpan("llm.generate_image_description", {
          attributes: {
            "llm.provider":         providerName,
            "llm.mime_type":        mimeType,
            // Estimate decoded byte size from base64 length (base64 overhead ≈ 4/3)
            "llm.image_size_bytes": Math.round(imageBase64.length * 0.75),
          },
        });

        return context.with(trace.setSpan(context.active(), span), async () => {
          try {
            const result = await innerVlm(imageBase64, mimeType, ctx);
            span.setAttribute("llm.caption_len", result.length);
            span.setStatus({ code: SpanStatusCode.OK });
            return result;
          } catch (err) {
            span.recordException(err instanceof Error ? err : new Error(String(err)));
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
            throw err;
          } finally {
            span.end();
          }
        });
      };
    }
    // If inner.generateImageDescription is undefined, this.generateImageDescription
    // stays undefined (as declared above) — the property check in imageCaptioner.ts
    // will correctly evaluate to false.
  }

  // ── generateText ──────────────────────────────────────────────────────────

  async generateText(prompt: string, systemInstruction?: string): Promise<string> {
    /**
     * Span: llm.generate_text
     *
     * `llm.text_len` (character count) is a cost proxy. We do NOT store the
     * full prompt — it can contain session memory content (PII risk).
     */
    const span = getTracer().startSpan("llm.generate_text", {
      attributes: {
        "llm.provider": this.providerName,
        "llm.text_len": prompt.length,
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await this.inner.generateText(prompt, systemInstruction);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        // Always end the span — even on error — to prevent BatchSpanProcessor
        // from holding a reference to a never-ending span object indefinitely.
        span.end();
      }
    });
  }

  // ── generateEmbedding ─────────────────────────────────────────────────────

  async generateEmbedding(text: string): Promise<number[]> {
    /**
     * Span: llm.generate_embedding
     *
     * Embeddings are the most frequent LLM calls in Prism — one fires
     * asynchronously on every ledger save. The latency distribution in Jaeger
     * reveals when to consider local embedding models (Ollama nomic-embed-text).
     *
     * `llm.embed_dim` lets us catch dimension mismatches before pgvector fails:
     * if an adapter returns 384 dimensions instead of 768, it shows in the trace.
     */
    const span = getTracer().startSpan("llm.generate_embedding", {
      attributes: {
        "llm.provider":  this.providerName,
        "llm.embed_len": text.length,
      },
    });

    return context.with(trace.setSpan(context.active(), span), async () => {
      try {
        const result = await this.inner.generateEmbedding(text);
        span.setAttribute("llm.embed_dim", result.length);
        span.setStatus({ code: SpanStatusCode.OK });
        return result;
      } catch (err) {
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: err instanceof Error ? err.message : String(err),
        });
        throw err;
      } finally {
        span.end();
      }
    });
  }
}
