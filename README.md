# Resona

**Semantic embeddings and vector search - find concepts that resonate**

Resona is a TypeScript library for generating, storing, and searching text embeddings. It supports multiple embedding providers and enables cross-source semantic search with hierarchical source identification.

## Features

- **Multiple Embedding Providers**: Ollama, OpenAI, Voyage AI, and Transformers.js (CPU-based)
- **Vector Storage**: LanceDB for efficient embedded vector similarity search
- **Change Detection**: Hash-based tracking to avoid re-embedding unchanged content
- **Batch Processing**: Efficient batch embedding with progress callbacks
- **Unified Search**: Search across multiple sources (Tana, email, etc.) with source identification
- **Hierarchical Source IDs**: Support for `type/instance` patterns (e.g., `tana/main`, `email/work`)

## Installation

```bash
bun add resona
```

No additional system dependencies required - LanceDB includes prebuilt binaries for all platforms.

## Quick Start

### Basic Embedding Service

```typescript
import { EmbeddingService, OllamaProvider } from "resona";

// Create an Ollama provider (requires Ollama running locally)
const provider = new OllamaProvider("nomic-embed-text");

// Create the embedding service with a database path
const service = new EmbeddingService(provider, "./embeddings.db");

// Embed items
await service.embed({
  id: "doc-1",
  text: "The quick brown fox jumps over the lazy dog",
});

await service.embedBatch([
  { id: "doc-2", text: "Machine learning fundamentals" },
  { id: "doc-3", text: "Natural language processing basics" },
]);

// Search for similar content
const results = await service.search("AI and ML concepts", 5);
console.log(results);
// [
//   { id: "doc-2", similarity: 0.87, contextText: "..." },
//   { id: "doc-3", similarity: 0.82, contextText: "..." },
//   ...
// ]
```

### Unified Search Across Sources

```typescript
import { UnifiedSearchService, EmbeddingService, OllamaProvider } from "resona";

// Create a unified search service
const unifiedSearch = new UnifiedSearchService();

// Register multiple sources
const tanaService = new EmbeddingService(provider, "./tana.db");
const emailService = new EmbeddingService(provider, "./email.db");

// Sources implement the SearchSource interface
unifiedSearch.registerSource({
  sourceId: "tana/main",
  description: "Tana main workspace",
  search: (query, k) => tanaService.search(query, k),
});

unifiedSearch.registerSource({
  sourceId: "email/work",
  description: "Work email",
  search: (query, k) => emailService.search(query, k),
});

// Search across all sources
const results = await unifiedSearch.search("project planning", 10);
// [
//   { source: "tana/main", id: "node_abc", similarity: 0.92 },
//   { source: "email/work", id: "msg_123", similarity: 0.88 },
//   ...
// ]

// Filter by source type
const tanaOnly = await unifiedSearch.search("planning", 10, {
  sourceTypes: ["tana"],
});
```

## API Reference

### Providers

#### OllamaProvider

```typescript
import { OllamaProvider } from "resona";

// Default endpoint (http://localhost:11434)
const provider = new OllamaProvider("nomic-embed-text");

// Custom endpoint
const provider = new OllamaProvider("nomic-embed-text", "http://ollama:11434");

// Custom dimensions for unknown models
const provider = new OllamaProvider("custom-model", undefined, 512);

// Check if Ollama is available
const available = await provider.healthCheck();
```

**Supported Ollama Models**:
- `nomic-embed-text` (768 dimensions)
- `mxbai-embed-large` (1024 dimensions)
- `all-minilm` (384 dimensions)
- `bge-m3` (1024 dimensions)
- `snowflake-arctic-embed` (1024 dimensions)

#### OpenAIProvider

```typescript
import { OpenAIProvider } from "resona";

// Default model (text-embedding-3-small)
const provider = new OpenAIProvider(process.env.OPENAI_API_KEY!);

// Specific model
const provider = new OpenAIProvider(apiKey, "text-embedding-3-large");

// Custom dimensions (for dimension reduction)
const provider = new OpenAIProvider(apiKey, "text-embedding-3-large", {
  dimensions: 1024,
});

// Azure OpenAI or custom endpoint
const provider = new OpenAIProvider(apiKey, "text-embedding-3-small", {
  endpoint: "https://your-resource.openai.azure.com/v1",
});
```

**Supported OpenAI Models**:
- `text-embedding-3-small` (1536 dimensions, supports reduction to 512+)
- `text-embedding-3-large` (3072 dimensions, supports reduction to 256+)
- `text-embedding-ada-002` (1536 dimensions, legacy)

#### VoyageProvider

```typescript
import { VoyageProvider } from "resona";

// Default model (voyage-3)
const provider = new VoyageProvider(process.env.VOYAGE_API_KEY!);

// Specific model
const provider = new VoyageProvider(apiKey, "voyage-3-large");

// With input type (optimizes for queries vs documents)
const queryProvider = new VoyageProvider(apiKey, "voyage-3", {
  inputType: "query",
});
const docProvider = new VoyageProvider(apiKey, "voyage-3", {
  inputType: "document",
});
```

**Supported Voyage Models**:
- `voyage-3` (1024 dimensions) - Best general-purpose
- `voyage-3-large` (1024 dimensions) - Higher quality
- `voyage-3-lite` (512 dimensions) - Fast and cost-effective
- `voyage-code-3` (1024 dimensions) - Code retrieval

#### TransformersProvider (CPU-based)

```typescript
import { TransformersProvider } from "resona";

// Default model (all-MiniLM-L6-v2)
const provider = new TransformersProvider();

// Specific model
const provider = new TransformersProvider("Xenova/bge-base-en-v1.5");

// Custom cache directory
const provider = new TransformersProvider("Xenova/all-MiniLM-L6-v2", {
  cacheDir: "/path/to/cache",
});
```

**Supported Transformers Models**:
- `Xenova/all-MiniLM-L6-v2` (384 dimensions) - Fast, good quality
- `Xenova/all-MiniLM-L12-v2` (384 dimensions) - Higher quality
- `Xenova/bge-small-en-v1.5` (384 dimensions)
- `Xenova/bge-base-en-v1.5` (768 dimensions)
- `Xenova/bge-large-en-v1.5` (1024 dimensions)
- `nomic-ai/nomic-embed-text-v1.5` (768 dimensions)

**Note**: TransformersProvider requires `@huggingface/transformers` as an optional dependency:
```bash
bun add @huggingface/transformers
```

### EmbeddingService

```typescript
import { EmbeddingService } from "resona";

const service = new EmbeddingService(provider, "./embeddings.db");

// Embed single item
await service.embed({
  id: "unique-id",
  text: "Content to embed",
  contextText: "Optional enriched context for embedding",
  metadata: { tags: ["example"] },
});

// Batch embed with progress
await service.embedBatch(items, {
  onProgress: (progress) => {
    console.log(`${progress.processed}/${progress.total}`);
  },
  progressInterval: 100,
  forceAll: false, // Set to true to re-embed unchanged items
});

// Search
const results = await service.search("query text", 10);

// Get statistics (async)
const stats = await service.getStats();
// { totalEmbeddings: 1000, model: "nomic-embed-text", dimensions: 768 }

// Cleanup old embeddings (async)
const removed = await service.cleanup(["id1", "id2"]); // Keep only these IDs

// Get embedded IDs (async)
const ids = await service.getEmbeddedIds();

// Close connection
service.close();
```

### UnifiedSearchService

```typescript
import { UnifiedSearchService } from "resona";

const unified = new UnifiedSearchService();

// Register sources
unified.registerSource(source);

// List sources
const sources = unified.listSources();
// [{ sourceId: "tana/main", description: "..." }, ...]

// Search with filters
const results = await unified.search("query", 10, {
  sources: ["tana/main"],        // Specific source IDs
  sourceTypes: ["tana", "email"], // Source type prefixes
});

// Get item details
const item = await unified.getItem("tana/main", "node_abc");
// { preview: "...", url: "https://..." }
```

### Source IDs

Resona uses hierarchical source IDs in the format `type/instance`:

```typescript
import { parseSourceId, createSourceId } from "resona";

// Parse a source ID
const { type, instance } = parseSourceId("tana/main");
// { type: "tana", instance: "main" }

// Create a source ID
const sourceId = createSourceId("email", "work");
// "email/work"
```

## Storage

Resona uses LanceDB for vector storage. Database paths with `.db` extension are automatically converted to `.lance` directories:

```typescript
// This creates ./embeddings.lance/ directory
const service = new EmbeddingService(provider, "./embeddings.db");
```

LanceDB provides:
- Fast vector similarity search
- No external dependencies (prebuilt binaries included)
- Efficient columnar storage
- Works with Bun, Node.js, and Deno

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck
```

## Architecture

```
resona/
├── src/
│   ├── index.ts                    # Package exports
│   ├── types.ts                    # Core type definitions
│   ├── providers/
│   │   ├── ollama.ts               # Ollama provider (local GPU)
│   │   ├── openai.ts               # OpenAI provider (cloud)
│   │   ├── voyage.ts               # Voyage AI provider (cloud)
│   │   └── transformers.ts         # Transformers.js (local CPU)
│   └── service/
│       ├── embedding-service.ts    # Core embedding service (LanceDB)
│       └── unified-search-service.ts # Cross-source search
└── test/
    ├── providers/
    │   ├── ollama.test.ts
    │   ├── openai.test.ts
    │   ├── voyage.test.ts
    │   └── transformers.test.ts
    └── service/
        ├── embedding-service.test.ts
        └── unified-search-service.test.ts
```

## Known Issues

### LanceDB Large Result Set Bug

LanceDB 0.13.x has a bug where querying large result sets (1000+ rows) without pagination returns corrupted string data. Resona works around this by paginating `getEmbeddedIds()` queries in batches of 100 rows. The warnings about "Ran out of fragments" at the end of pagination are expected and harmless.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please follow the existing code style and add tests for new features.
