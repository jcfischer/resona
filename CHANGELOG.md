# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2025-12-19

### Added

- **LanceDB Write Batching**: Buffer embedding records in memory before writing to LanceDB for dramatically improved performance on large datasets
  - New `storeBatchSize` option in `BatchEmbedOptions` (default: 5000)
  - Reduces LanceDB writes by ~100x (e.g., 2000 writes → 20 writes for 100k items)
  - New progress fields: `stored` (embeddings written to LanceDB) and `bufferSize` (current buffer occupancy)
  - Dual progress visibility: see Ollama embeddings generated vs LanceDB persisted

### Performance

- Embedding 100k nodes now writes to LanceDB only ~20 times instead of ~2000 times
- Memory overhead: ~20-40MB for default buffer size (acceptable tradeoff)

### Backward Compatibility

- All changes are additive and backward compatible
- Existing callers work unchanged with default behavior
- New progress fields are optional in callbacks

## [0.1.0] - 2025-12-14

### Added

- Initial release
- Multiple embedding providers: Ollama, OpenAI, Voyage AI, Transformers.js
- LanceDB vector storage with efficient similarity search
- Hash-based change detection to avoid re-embedding unchanged content
- Batch processing with progress callbacks
- Unified search across multiple sources
- Hierarchical source IDs (`type/instance` patterns)
