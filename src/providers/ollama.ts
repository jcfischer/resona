/**
 * Ollama Embedding Provider
 *
 * Local embedding generation using Ollama.
 * Requires Ollama server running (default: http://localhost:11434)
 */

import type { EmbeddingProvider } from "../types";
import { OLLAMA_MODEL_DIMENSIONS } from "../types";

const DEFAULT_ENDPOINT = "http://localhost:11434";

/**
 * Ollama embedding provider
 *
 * Supports models like:
 * - nomic-embed-text (768 dimensions)
 * - mxbai-embed-large (1024 dimensions)
 * - all-minilm (384 dimensions)
 * - bge-m3 (1024 dimensions)
 */
export class OllamaProvider implements EmbeddingProvider {
  readonly name = "ollama";
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 10;
  readonly supportsAsync = false;

  private endpoint: string;

  /**
   * Create an Ollama embedding provider
   *
   * @param model - Model name (e.g., 'nomic-embed-text')
   * @param endpoint - Ollama server URL (default: http://localhost:11434)
   * @param dimensions - Explicit dimensions (auto-detected for known models)
   */
  constructor(model: string, endpoint?: string, dimensions?: number) {
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
  }

  /**
   * Embed a single text
   */
  async embedSingle(text: string): Promise<Float32Array> {
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
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

    // Ollama's /api/embed supports batch input
    const response = await fetch(`${this.endpoint}/api/embed`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        input: texts,
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
