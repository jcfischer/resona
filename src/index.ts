/**
 * Resona - Semantic Embeddings and Vector Search
 *
 * Find concepts that resonate across your data.
 *
 * @module resona
 */

// Core types
export {
  // Provider types
  type ProviderType,
  type EmbeddingConfig,
  type EmbeddingProvider,

  // Item types
  type ItemToEmbed,
  type StoredEmbedding,

  // Search types
  type SearchResult,
  type UnifiedSearchResult,
  type SearchSource,
  type SourceId,

  // Batch processing types
  type BatchEmbedProgress,
  type BatchEmbedOptions,
  type BatchEmbedResult,

  // Statistics types
  type EmbeddingStats,

  // Helper functions
  parseSourceId,
  createSourceId,
  getModelDimensions,

  // Model dimension constants
  OLLAMA_MODEL_DIMENSIONS,
  OPENAI_MODEL_DIMENSIONS,
  VOYAGE_MODEL_DIMENSIONS,
  TRANSFORMERS_MODEL_DIMENSIONS,
} from "./types";

// Embedding Service
export { EmbeddingService } from "./service/embedding-service";

// Unified Search Service
export {
  UnifiedSearchService,
  type UnifiedSearchOptions,
  type SourceInfo,
} from "./service/unified-search-service";

// Providers
export { OllamaProvider } from "./providers/ollama";
export { OpenAIProvider } from "./providers/openai";
export { VoyageProvider } from "./providers/voyage";
export { TransformersProvider } from "./providers/transformers";
