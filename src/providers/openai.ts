/**
 * OpenAI Embedding Provider
 *
 * Cloud embedding generation using OpenAI's API.
 * Requires an API key from https://platform.openai.com/api-keys
 */

import type { EmbeddingProvider } from "../types";
import { OPENAI_MODEL_DIMENSIONS } from "../types";

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_ENDPOINT = "https://api.openai.com/v1";

interface OpenAIProviderOptions {
  /** Custom dimensions (for models that support dimension reduction) */
  dimensions?: number;
  /** Custom API endpoint (for Azure OpenAI or proxies) */
  endpoint?: string;
}

interface OpenAIEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

/**
 * OpenAI embedding provider
 *
 * Supports models:
 * - text-embedding-3-small (1536 dimensions, supports reduction to 512+)
 * - text-embedding-3-large (3072 dimensions, supports reduction to 256+)
 * - text-embedding-ada-002 (1536 dimensions, legacy)
 */
export class OpenAIProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 2048; // OpenAI supports up to 2048 texts per request
  readonly supportsAsync = true;

  private apiKey: string;
  private endpoint: string;
  private customDimensions?: number;

  /**
   * Create an OpenAI embedding provider
   *
   * @param apiKey - OpenAI API key
   * @param model - Model name (default: 'text-embedding-3-small')
   * @param options - Additional options (dimensions, endpoint)
   */
  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    options?: OpenAIProviderOptions
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = options?.endpoint || DEFAULT_ENDPOINT;
    this.customDimensions = options?.dimensions;

    // Determine dimensions
    if (options?.dimensions !== undefined) {
      this.dimensions = options.dimensions;
    } else if (OPENAI_MODEL_DIMENSIONS[model]) {
      this.dimensions = OPENAI_MODEL_DIMENSIONS[model];
    } else {
      throw new Error(
        `Unknown model "${model}". Please provide explicit dimensions in options.`
      );
    }
  }

  /**
   * Embed a single text
   */
  async embedSingle(text: string): Promise<Float32Array> {
    const embeddings = await this.embed([text]);
    return embeddings[0];
  }

  /**
   * Embed multiple texts in a batch
   */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) {
      return [];
    }

    const body: Record<string, unknown> = {
      model: this.model,
      input: texts,
    };

    // Add custom dimensions if specified (only for 3rd gen models)
    if (this.customDimensions !== undefined) {
      body.dimensions = this.customDimensions;
    }

    const response = await fetch(`${this.endpoint}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`OpenAI embed failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as OpenAIEmbeddingResponse;

    if (!data.data || data.data.length === 0) {
      throw new Error("OpenAI returned empty embeddings");
    }

    // Sort by index to ensure correct order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);

    return sorted.map((item) => new Float32Array(item.embedding));
  }

  /**
   * Check if OpenAI API is accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.endpoint}/models`, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
