/**
 * Resona - Semantic Embeddings and Vector Search
 *
 * Core type definitions for the embedding system.
 * Supports hierarchical source identifiers (e.g., "tana/main", "email/work")
 */

// ============================================
// PROVIDER CONFIGURATION
// ============================================

/**
 * Supported embedding providers
 */
export type ProviderType = "ollama" | "transformers" | "openai" | "voyage";

/**
 * Configuration for embedding providers
 */
export interface EmbeddingConfig {
  /** Provider type: local (ollama, transformers) or cloud (openai, voyage) */
  provider: ProviderType;

  /** Model name (e.g., 'nomic-embed-text', 'text-embedding-3-small') */
  model: string;

  /** Embedding dimensions (768, 1024, 1536, etc.) */
  dimensions: number;

  /** API key for cloud providers (optional for local) */
  apiKey?: string;

  /** Custom endpoint URL (for custom Ollama installations) */
  endpoint?: string;
}

// ============================================
// EMBEDDING PROVIDER INTERFACE
// ============================================

/**
 * Abstract interface for embedding providers
 *
 * Implementations must provide:
 * - Metadata (name, model, dimensions)
 * - Batch embedding capability
 * - Single text embedding capability
 */
export interface EmbeddingProvider {
  /** Provider name (e.g., 'ollama', 'openai') */
  readonly name: string;

  /** Model identifier */
  readonly model: string;

  /** Output embedding dimensions */
  readonly dimensions: number;

  /** Maximum texts per batch request */
  readonly maxBatchSize: number;

  /** Whether provider supports async/parallel requests */
  readonly supportsAsync: boolean;

  /**
   * Embed multiple texts in a batch
   * @param texts - Array of text strings to embed
   * @returns Array of Float32Array embeddings (one per input text)
   */
  embed(texts: string[]): Promise<Float32Array[]>;

  /**
   * Embed a single text
   * @param text - Text string to embed
   * @returns Float32Array embedding vector
   */
  embedSingle(text: string): Promise<Float32Array>;

  /**
   * Check if provider is available and healthy
   * @returns true if provider is ready to accept requests
   */
  healthCheck?(): Promise<boolean>;
}

// ============================================
// ITEMS & EMBEDDINGS
// ============================================

/**
 * Item to be embedded
 *
 * The id should be unique within the source. When used with unified search,
 * the full identifier becomes "source/id" (e.g., "tana/main/node_abc123")
 */
export interface ItemToEmbed {
  /** Source-specific ID (node_id, email_id, etc.) */
  id: string;

  /** Text to generate embedding from */
  text: string;

  /** Optional enriched context text (what actually gets embedded) */
  contextText?: string;

  /** Optional metadata to store alongside the embedding */
  metadata?: Record<string, unknown>;
}

/**
 * Stored embedding record
 */
export interface StoredEmbedding {
  /** Item ID */
  id: string;

  /** The embedding vector */
  embedding: Float32Array;

  /** SHA256 hash of source text (for change detection) */
  textHash: string;

  /** What was actually embedded */
  contextText: string;

  /** Model used to generate embedding */
  model: string;

  /** Embedding dimensions */
  dimensions: number;

  /** Optional metadata */
  metadata?: Record<string, unknown>;

  /** Creation timestamp */
  createdAt: number;

  /** Last update timestamp */
  updatedAt: number;
}

// ============================================
// SEARCH RESULTS
// ============================================

/**
 * Single-source search result (returned by EmbeddingService)
 */
export interface SearchResult {
  /** Source-specific ID */
  id: string;

  /** Vector distance (lower = more similar) */
  distance: number;

  /** Similarity score (1 - distance, higher = more similar) */
  similarity: number;

  /** What was embedded (for preview) */
  contextText?: string;

  /** Optional metadata */
  metadata?: Record<string, unknown>;
}

// ============================================
// UNIFIED SEARCH (resona-unified)
// ============================================

/**
 * Hierarchical source identifier
 *
 * Supports namespaced sources like:
 * - "tana" (simple)
 * - "tana/main" (workspace)
 * - "tana/books" (workspace)
 * - "email/personal" (account)
 * - "email/work" (account)
 *
 * Format: "type" or "type/instance"
 */
export type SourceId = string;

/**
 * Parse a source ID into its components
 */
export function parseSourceId(sourceId: SourceId): {
  type: string;
  instance?: string;
} {
  const parts = sourceId.split("/");
  return {
    type: parts[0],
    instance: parts.length > 1 ? parts.slice(1).join("/") : undefined,
  };
}

/**
 * Create a source ID from components
 */
export function createSourceId(type: string, instance?: string): SourceId {
  return instance ? `${type}/${instance}` : type;
}

/**
 * A searchable source that can be registered with UnifiedSearchService
 */
export interface SearchSource {
  /**
   * Unique identifier for this source
   * Supports hierarchical IDs: "tana", "tana/main", "email/work"
   */
  readonly sourceId: SourceId;

  /** Human-readable description */
  readonly description?: string;

  /**
   * Search this source
   * @param query - Search query text
   * @param k - Number of results to return
   * @returns Search results with source-local IDs
   */
  search(query: string, k: number): Promise<SearchResult[]>;

  /**
   * Get item details by ID for preview/display
   * @param id - Source-local item ID
   * @returns Preview text and optional URL, or null if not found
   */
  getItem?(id: string): Promise<{ preview: string; url?: string } | null>;
}

/**
 * Unified search result with source identification
 *
 * The combination of (source, id) uniquely identifies an item across all sources.
 * Consumers can use source to route to the appropriate skill for full details.
 */
export interface UnifiedSearchResult {
  /** Source identifier (e.g., "tana/main", "email/work") */
  source: SourceId;

  /** Source-specific ID that can be used to fetch full item */
  id: string;

  /** Similarity score (0-1, higher = more similar) */
  similarity: number;

  /** Text preview (from contextText or getItem) */
  preview?: string;

  /** Optional metadata from the source */
  metadata?: Record<string, unknown>;
}

// ============================================
// BATCH PROCESSING
// ============================================

/**
 * Progress information for batch embedding operations
 */
export interface BatchEmbedProgress {
  /** Number of items successfully processed */
  processed: number;

  /** Number of items skipped (unchanged) */
  skipped: number;

  /** Number of items that failed */
  errors: number;

  /** Total items to process */
  total: number;

  /** Current item being processed (truncated) */
  currentItem?: string;

  /** Processing rate (items per second) */
  rate?: number;
}

/**
 * Options for batch embedding operations
 */
export interface BatchEmbedOptions {
  /** Callback for progress updates */
  onProgress?: (progress: BatchEmbedProgress) => void;

  /** How often to report progress (default: 100) */
  progressInterval?: number;

  /** How often to checkpoint database (default: 100) */
  commitInterval?: number;

  /** Force regeneration of all embeddings, ignoring cache (default: false) */
  forceAll?: boolean;
}

/**
 * Result of a batch embedding operation
 */
export interface BatchEmbedResult {
  /** Number of items successfully processed */
  processed: number;

  /** Number of items skipped (unchanged) */
  skipped: number;

  /** Number of items that failed */
  errors: number;

  /** Sample of error messages for debugging */
  errorSamples?: string[];
}

// ============================================
// STATISTICS
// ============================================

/**
 * Embedding statistics for a source
 */
export interface EmbeddingStats {
  /** Total number of embeddings stored */
  totalEmbeddings: number;

  /** Model used for embeddings */
  model: string;

  /** Embedding dimensions */
  dimensions: number;

  /** Oldest embedding timestamp */
  oldestEmbedding?: Date;

  /** Newest embedding timestamp */
  newestEmbedding?: Date;
}

// ============================================
// MODEL DIMENSION MAPPINGS
// ============================================

/**
 * Known Ollama model dimensions
 */
export const OLLAMA_MODEL_DIMENSIONS: Record<string, number> = {
  "nomic-embed-text": 768,
  "mxbai-embed-large": 1024,
  "all-minilm": 384,
  "bge-m3": 1024,
  "snowflake-arctic-embed": 1024,
};

/**
 * Known OpenAI model dimensions
 */
export const OPENAI_MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

/**
 * Known Voyage AI model dimensions
 */
export const VOYAGE_MODEL_DIMENSIONS: Record<string, number> = {
  "voyage-3-large": 1024,
  "voyage-3": 1024,
  "voyage-3-lite": 512,
  "voyage-code-3": 1024,
};

/**
 * Known Transformers.js model dimensions
 */
export const TRANSFORMERS_MODEL_DIMENSIONS: Record<string, number> = {
  "Xenova/all-MiniLM-L6-v2": 384,
  "Xenova/all-MiniLM-L12-v2": 384,
  "Xenova/bge-small-en-v1.5": 384,
  "Xenova/bge-base-en-v1.5": 768,
  "Xenova/bge-large-en-v1.5": 1024,
  "Xenova/jina-embeddings-v2-base-en": 768,
  "nomic-ai/nomic-embed-text-v1.5": 768,
};

/**
 * Get dimensions for a known model
 */
export function getModelDimensions(
  provider: ProviderType,
  model: string
): number | undefined {
  switch (provider) {
    case "ollama":
      return OLLAMA_MODEL_DIMENSIONS[model];
    case "openai":
      return OPENAI_MODEL_DIMENSIONS[model];
    case "voyage":
      return VOYAGE_MODEL_DIMENSIONS[model];
    case "transformers":
      return TRANSFORMERS_MODEL_DIMENSIONS[model];
    default:
      return undefined;
  }
}
