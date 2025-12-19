# Specification: LanceDB Write Batching

**Status**: Draft
**Created**: 2025-12-19
**Author**: PAI

## Problem Statement

The `embedBatch()` method in `EmbeddingService` writes to LanceDB after every Ollama batch. Since Ollama batches are small (constrained by model context/memory), this causes many small writes:

```typescript
// Current flow (embedding-service.ts lines 236-280):
const batchSize = this.provider.maxBatchSize;  // Small: ~10-50
for (let i = 0; i < itemsToEmbed.length; i += batchSize) {
  const embeddings = await this.provider.embed(texts);
  // ...build records...
  await this.storeEmbeddingsBatch(records);  // Write EVERY batch!
}
```

**Impact**:
- Embedding 100k nodes with maxBatchSize=50 causes 2,000 LanceDB writes
- LanceDB performance degrades with many small writes
- mergeInsert operations on large tables become slow

## Requirements

### FR-1: Configurable LanceDB Batch Size

Add `storeBatchSize` option to `BatchEmbedOptions`:

```typescript
interface BatchEmbedOptions {
  // Existing options...
  onProgress?: (progress: BatchProgress) => void;
  progressInterval?: number;
  forceAll?: boolean;

  // NEW: LanceDB write batching
  storeBatchSize?: number;  // Default: 5000
}
```

### FR-2: Buffered Writes

Buffer embedding records in memory until:
1. Buffer reaches `storeBatchSize` threshold
2. All items are processed (flush remaining)

### FR-3: Enhanced Progress Reporting

Update `BatchProgress` to include both counters:

```typescript
interface BatchProgress {
  // Existing fields...
  processed: number;      // Renamed semantically to embeddingsGenerated
  skipped: number;
  errors: number;
  total: number;
  rate?: number;

  // NEW: Storage progress
  stored: number;         // Embeddings written to LanceDB
  bufferSize: number;     // Current buffer occupancy
}
```

### FR-4: Backward Compatibility

- Default `storeBatchSize` of 5000 provides improved performance without code changes
- Existing `onProgress` callbacks continue to work (new fields are additive)

## Implementation Notes

### Modified Flow

```typescript
async embedBatch(items, options = {}) {
  const { storeBatchSize = 5000, onProgress, ... } = options;

  const buffer: EmbeddingRecord[] = [];
  let stored = 0;

  for (let i = 0; i < itemsToEmbed.length; i += batchSize) {
    // Get embeddings from Ollama
    const embeddings = await this.provider.embed(texts);

    // Build records and add to buffer
    for (const record of records) {
      buffer.push(record);
    }
    result.processed += records.length;

    // Flush buffer when full
    if (buffer.length >= storeBatchSize) {
      await this.storeEmbeddingsBatch(buffer);
      stored += buffer.length;
      buffer.length = 0;  // Clear buffer
    }

    // Progress with both counters
    if (onProgress) {
      onProgress({
        processed: result.processed,  // Embeddings from Ollama
        stored,                        // Written to LanceDB
        bufferSize: buffer.length,
        ...
      });
    }
  }

  // Flush remaining
  if (buffer.length > 0) {
    await this.storeEmbeddingsBatch(buffer);
    stored += buffer.length;
  }
}
```

### Memory Considerations

- 1024-dim vectors at 4 bytes each = 4KB per embedding
- 5000 buffer = 20MB for vectors + metadata overhead
- 10000 buffer = 40MB
- Acceptable for modern systems

## Success Criteria

1. LanceDB writes reduced by 100x (from per-Ollama-batch to per-5000)
2. Existing tests pass without modification
3. New tests cover:
   - Buffer filling and flushing
   - Partial buffer flush at end
   - Progress callback with new fields
4. Backward compatible - no breaking changes to API

## Files to Modify

- `src/service/embedding-service.ts` - Add buffering logic
- `src/types.ts` - Update BatchEmbedOptions and BatchProgress types

## Testing

```typescript
describe("storeBatchSize option", () => {
  it("should buffer writes until threshold", async () => {
    let storeCount = 0;
    // Mock storeEmbeddingsBatch to count calls

    await service.embedBatch(items, { storeBatchSize: 100 });

    // With 250 items and storeBatchSize=100:
    // Expect 3 writes: 100 + 100 + 50
    expect(storeCount).toBe(3);
  });

  it("should report stored count in progress", async () => {
    const progress: BatchProgress[] = [];
    await service.embedBatch(items, {
      storeBatchSize: 100,
      onProgress: (p) => progress.push(p),
    });

    // Progress should show stored lagging behind processed
    expect(progress[0].stored).toBeLessThan(progress[0].processed);
  });
});
```
