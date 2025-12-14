# Resona

**Semantic embeddings and vector search - find concepts that resonate**

Resona is a TypeScript library for generating, storing, and searching text embeddings. It supports multiple embedding providers and enables cross-source semantic search with hierarchical source identification.

## Features

- **Multiple Embedding Providers**: Ollama (local), with OpenAI and Voyage AI planned
- **Vector Storage**: sqlite-vec for efficient vector similarity search
- **Change Detection**: Hash-based tracking to avoid re-embedding unchanged content
- **Batch Processing**: Efficient batch embedding with progress callbacks
- **Unified Search**: Search across multiple sources (Tana, email, etc.) with source identification
- **Hierarchical Source IDs**: Support for `type/instance` patterns (e.g., `tana/main`, `email/work`)

## Installation

```bash
bun add resona
```

### Prerequisites

**macOS**: Requires Homebrew's SQLite for extension support:

```bash
brew install sqlite
```

**Linux**: System SQLite usually supports extensions by default.

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

// Get statistics
const stats = service.getStats();
// { totalEmbeddings: 1000, model: "nomic-embed-text", dimensions: 768 }

// Cleanup old embeddings
const removed = service.cleanup(["id1", "id2"]); // Keep only these IDs

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

## Development

```bash
# Install dependencies
bun install

# Run tests
bun test

# Type check
bun run typecheck
```

### Testing with sqlite-vec

Tests automatically configure the custom SQLite via `bunfig.toml` preload.

## Architecture

```
resona/
├── src/
│   ├── index.ts                    # Package exports
│   ├── types.ts                    # Core type definitions
│   ├── sqlite-vec-loader.ts        # SQLite extension loader
│   ├── providers/
│   │   └── ollama.ts               # Ollama provider
│   └── service/
│       ├── embedding-service.ts    # Core embedding service
│       └── unified-search-service.ts # Cross-source search
└── test/
    ├── providers/
    │   └── ollama.test.ts
    └── service/
        ├── embedding-service.test.ts
        └── unified-search-service.test.ts
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please follow the existing code style and add tests for new features.
