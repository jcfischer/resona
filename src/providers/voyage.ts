/**
 * Voyage AI Embedding Provider
 *
 * High-quality embedding generation using Voyage AI's API.
 * Requires an API key from https://dash.voyageai.com/
 *
 * Voyage AI specializes in embeddings optimized for retrieval tasks,
 * with support for query/document differentiation.
 */

import type { EmbeddingProvider } from "../types";
import { VOYAGE_MODEL_DIMENSIONS } from "../types";

const DEFAULT_MODEL = "voyage-3";
const DEFAULT_ENDPOINT = "https://api.voyageai.com/v1";

interface VoyageProviderOptions {
  /** Custom dimensions (if model supports it) */
  dimensions?: number;
  /** Input type: 'query' for search queries, 'document' for content to be retrieved */
  inputType?: "query" | "document";
  /** Custom API endpoint */
  endpoint?: string;
}

interface VoyageEmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    embedding: number[];
    index: number;
  }>;
  model: string;
  usage: {
    total_tokens: number;
  };
}

/**
 * Voyage AI embedding provider
 *
 * Supports models:
 * - voyage-3 (1024 dimensions) - Best general-purpose embeddings
 * - voyage-3-large (1024 dimensions) - Higher quality for complex tasks
 * - voyage-3-lite (512 dimensions) - Fast and cost-effective
 * - voyage-code-3 (1024 dimensions) - Optimized for code retrieval
 */
export class VoyageProvider implements EmbeddingProvider {
  readonly name = "voyage";
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 128; // Voyage supports up to 128 texts per request
  readonly supportsAsync = true;

  private apiKey: string;
  private endpoint: string;
  private inputType?: "query" | "document";

  /**
   * Create a Voyage AI embedding provider
   *
   * @param apiKey - Voyage AI API key
   * @param model - Model name (default: 'voyage-3')
   * @param options - Additional options (dimensions, inputType, endpoint)
   */
  constructor(
    apiKey: string,
    model: string = DEFAULT_MODEL,
    options?: VoyageProviderOptions
  ) {
    this.apiKey = apiKey;
    this.model = model;
    this.endpoint = options?.endpoint || DEFAULT_ENDPOINT;
    this.inputType = options?.inputType;

    // Determine dimensions
    if (options?.dimensions !== undefined) {
      this.dimensions = options.dimensions;
    } else if (VOYAGE_MODEL_DIMENSIONS[model]) {
      this.dimensions = VOYAGE_MODEL_DIMENSIONS[model];
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

    // Add input_type if specified
    if (this.inputType) {
      body.input_type = this.inputType;
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
      throw new Error(`Voyage embed failed: ${response.status} ${error}`);
    }

    const data = (await response.json()) as VoyageEmbeddingResponse;

    if (!data.data || data.data.length === 0) {
      throw new Error("Voyage returned empty embeddings");
    }

    // Sort by index to ensure correct order
    const sorted = [...data.data].sort((a, b) => a.index - b.index);

    return sorted.map((item) => new Float32Array(item.embedding));
  }

  /**
   * Check if Voyage AI API is accessible
   */
  async healthCheck(): Promise<boolean> {
    try {
      // Voyage doesn't have a dedicated health endpoint, so we'll use
      // a minimal embedding request to verify the API is working
      const response = await fetch(`${this.endpoint}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: ["health check"],
        }),
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
