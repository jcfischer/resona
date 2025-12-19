/**
 * Ollama Embedding Provider
 *
 * Local embedding generation using Ollama.
 * Requires Ollama server running (default: http://localhost:11434)
 */

import type { EmbeddingProvider } from "../types";
import { OLLAMA_MODEL_DIMENSIONS, OLLAMA_MODEL_CONTEXT_TOKENS } from "../types";

const DEFAULT_ENDPOINT = "http://localhost:11434";

/**
 * Ollama embedding provider
 *
 * Supports models like:
 * - nomic-embed-text (768 dimensions, 8192 token context)
 * - mxbai-embed-large (1024 dimensions, 512 token context)
 * - all-minilm (384 dimensions, 512 token context)
 * - bge-m3 (1024 dimensions, 8192 token context)
 */

// Default context for unknown models: conservative 512 tokens
const DEFAULT_CONTEXT_TOKENS = 512;
// ~4 chars per token (rough estimate)
const CHARS_PER_TOKEN = 4;

export class OllamaProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 10;
  readonly supportsAsync = false;
  /** Maximum characters before truncation (based on model context limit) */
  readonly maxChars: number;

  private endpoint: string;

  /**
   * Create an Ollama embedding provider
   *
   * @param model - Model name (e.g., 'nomic-embed-text')
   * @param endpoint - Ollama server URL (default: http://localhost:11434)
   * @param dimensions - Explicit dimensions (auto-detected for known models)
   * @param maxChars - Max characters before truncation (auto-detected based on model)
   */
  constructor(
    model: string,
    endpoint?: string,
    dimensions?: number,
    maxChars?: number
  ) {
    this.model = model;
    this.endpoint = endpoint || DEFAULT_ENDPOINT;

    // Auto-detect dimensions for known models
    if (dimensions !== undefined) {
      this.dimensions = dimensions;
    } else if (OLLAMA_MODEL_DIMENSIONS[model]) {
      this.dimensions = OLLAMA_MODEL_DIMENSIONS[model];
    } else {
      throw new Error(
        `Unknown model "${model}". Please provide explicit dimensions parameter.`
      );
    }

    // Auto-detect maxChars based on model's context token limit
    if (maxChars !== undefined) {
      this.maxChars = maxChars;
    } else {
      const contextTokens =
        OLLAMA_MODEL_CONTEXT_TOKENS[model] ?? DEFAULT_CONTEXT_TOKENS;
      this.maxChars = contextTokens * CHARS_PER_TOKEN;
    }
  }

  /**
   * Truncate text to fit within model's context window
   */
  private truncate(text: string): string {
    if (text.length <= this.maxChars) {
      return text;
    }
    // Truncate and add indicator
    return text.substring(0, this.maxChars - 3) + "...";
  }

  /**
   * Embed a single text
   */
  async embedSingle(text: string): Promise<Float32Array> {
    const truncatedText = this.truncate(text);
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: truncatedText,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embed failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      embeddings: number[][];
    };

    if (!data.embeddings || !data.embeddings[0]) {
      throw new Error("Ollama returned empty embeddings");
    }

    return new Float32Array(data.embeddings[0]);
  }

  /**
   * Embed multiple texts
   *
   * Note: Ollama processes embeddings sequentially, so this is
   * essentially a loop over embedSingle. For true batch processing,
   * consider a cloud provider.
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    // Truncate all texts to fit context window
    const truncatedTexts = texts.map((t) => this.truncate(t));

    // Ollama's /api/embed supports batch input
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: truncatedTexts,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Ollama embed failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as {
      embeddings: number[][];
    };

    if (!data.embeddings) {
      throw new Error("Ollama returned empty embeddings");
    }

    return data.embeddings.map((emb) => new Float32Array(emb));
  }

  /**
   * Check if Ollama server is available
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
