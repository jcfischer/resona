/**
 * Transformers.js Embedding Provider
 *
 * CPU-based local embedding generation using @huggingface/transformers.
 * No GPU, API key, or external service required.
 *
 * Models are downloaded and cached locally on first use.
 */

import type { EmbeddingProvider } from "../types";
import { TRANSFORMERS_MODEL_DIMENSIONS } from "../types";

const DEFAULT_MODEL = "Xenova/all-MiniLM-L6-v2";

interface TransformersProviderOptions {
  /** Custom dimensions for unknown models */
  dimensions?: number;
  /** Custom cache directory for models */
  cacheDir?: string;
  /** Show download progress (default: true) */
  showProgress?: boolean;
}

// Dynamic import types for transformers
type Pipeline = (task: string, model: string, options?: object) => Promise<FeatureExtractionPipeline>;
type FeatureExtractionPipeline = (texts: string[], options?: object) => Promise<{
  tolist: () => number[][];
}>;

/**
 * Transformers.js embedding provider
 *
 * Runs entirely on CPU - no GPU required.
 *
 * Supports models like:
 * - Xenova/all-MiniLM-L6-v2 (384 dimensions) - Fast, good quality
 * - Xenova/all-MiniLM-L12-v2 (384 dimensions) - Higher quality
 * - Xenova/bge-small-en-v1.5 (384 dimensions) - BGE small
 * - Xenova/bge-base-en-v1.5 (768 dimensions) - BGE base
 * - Xenova/bge-large-en-v1.5 (1024 dimensions) - BGE large
 * - nomic-ai/nomic-embed-text-v1.5 (768 dimensions) - Nomic
 */
export class TransformersProvider implements EmbeddingProvider {
  readonly name = "transformers";
  readonly model: string;
  readonly dimensions: number;
  readonly maxBatchSize = 32; // Conservative batch size for CPU
  readonly supportsAsync = true;

  private cacheDir?: string;
  private showProgress: boolean;
  private pipeline: FeatureExtractionPipeline | null = null;
  private pipelinePromise: Promise<FeatureExtractionPipeline> | null = null;

  /**
   * Create a Transformers.js embedding provider
   *
   * @param model - Model name (default: 'Xenova/all-MiniLM-L6-v2')
   * @param options - Additional options (dimensions, cacheDir, showProgress)
   */
  constructor(
    model: string = DEFAULT_MODEL,
    options?: TransformersProviderOptions
  ) {
    this.model = model;
    this.cacheDir = options?.cacheDir;
    this.showProgress = options?.showProgress ?? true;

    // Determine dimensions
    if (options?.dimensions !== undefined) {
      this.dimensions = options.dimensions;
    } else if (TRANSFORMERS_MODEL_DIMENSIONS[model]) {
      this.dimensions = TRANSFORMERS_MODEL_DIMENSIONS[model];
    } else {
      throw new Error(
        `Unknown model "${model}". Please provide explicit dimensions in options.`
      );
    }
  }

  /**
   * Get cache directory
   */
  getCacheDir(): string | undefined {
    return this.cacheDir;
  }

  /**
   * Get show progress setting
   */
  getShowProgress(): boolean {
    return this.showProgress;
  }

  /**
   * Check if model is loaded
   */
  isModelLoaded(): boolean {
    return this.pipeline !== null;
  }

  /**
   * Lazily load the pipeline
   */
  private async getPipeline(): Promise<FeatureExtractionPipeline> {
    // Return cached pipeline
    if (this.pipeline) {
      return this.pipeline;
    }

    // Return in-flight promise if loading
    if (this.pipelinePromise) {
      return this.pipelinePromise;
    }

    // Start loading
    this.pipelinePromise = this.loadPipeline();
    try {
      this.pipeline = await this.pipelinePromise;
      return this.pipeline;
    } finally {
      this.pipelinePromise = null;
    }
  }

  /**
   * Load the embedding pipeline
   */
  private async loadPipeline(): Promise<FeatureExtractionPipeline> {
    try {
      // Dynamic import to keep transformers optional
      const { pipeline, env } = await import("@huggingface/transformers");

      // Configure cache directory if specified
      if (this.cacheDir) {
        env.cacheDir = this.cacheDir;
      }

      // Disable progress if requested
      if (!this.showProgress) {
        env.allowLocalModels = true;
      }

      // Create the feature extraction pipeline
      const pipe = await pipeline("feature-extraction", this.model, {
        dtype: "fp32", // Use float32 for consistency
      });

      return pipe as unknown as FeatureExtractionPipeline;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Cannot find module")
      ) {
        throw new Error(
          `@huggingface/transformers is not installed. Install it with: bun add @huggingface/transformers`
        );
      }
      throw error;
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

    const pipe = await this.getPipeline();

    // Run feature extraction
    const result = await pipe(texts, {
      pooling: "mean",
      normalize: true,
    });

    // Convert to Float32Arrays
    const embeddings = result.tolist();
    return embeddings.map((emb: number[]) => new Float32Array(emb));
  }

  /**
   * Check if the model can be loaded
   */
  async healthCheck(): Promise<boolean> {
    try {
      await this.getPipeline();
      return true;
    } catch {
      return false;
    }
  }
}
