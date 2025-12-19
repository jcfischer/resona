# Specification: Paginated Hash Loading for Change Detection

**Date**: 2025-12-19
**Status**: Draft
**Author**: PAI
**Component**: resona/src/service/embedding-service.ts

## Problem Statement

The `embedBatch()` method loads ALL existing embeddings into memory at once for change detection:

```typescript
const existingRecords = await this.table
  .query()
  .select(["id", "text_hash"])
  .toArray();  // Loads 450k+ records into memory
```

This causes SIGILL (illegal hardware instruction) crashes in compiled Bun binaries when the dataset is large (450k+ records). The crash appears to be related to memory pressure when `bun build --compile` interacts with LanceDB's native Rust bindings.

**Impact**: Users cannot run `embed generate` on large workspaces with compiled binaries.

## Goals

1. **Primary**: Eliminate memory spike during hash map building
2. **Secondary**: Maintain same change detection accuracy (hash-based skip logic)
3. **Constraint**: No significant performance regression for small datasets
4. **Constraint**: Backward compatible - no API changes

## Non-Goals

- Changing the hash algorithm
- Modifying how embeddings are stored
- Adding new configuration options (keep it automatic)

## User Journey

**Before (crashes)**:
```bash
./supertag embed generate -w main
# SIGILL crash after "Starting embedding process..."
```

**After (works)**:
```bash
./supertag embed generate -w main
# Successfully processes 318k nodes against 450k existing embeddings
```

## Functional Requirements

### FR1: Streaming Hash Map Construction
The system MUST build the hash map using streaming iteration instead of loading all records at once.

### FR2: Memory Bounded
Peak memory usage during hash map construction MUST NOT exceed O(unique_base_ids) rather than O(total_records).

### FR3: Progress Feedback
When `RESONA_DEBUG=1`, the system SHOULD log progress during hash map loading (e.g., every 50k records).

### FR4: Identical Behavior
The change detection logic (which items to skip vs embed) MUST produce identical results to the current implementation.

## Technical Approach

### Option A: RecordBatch Streaming (Recommended)

LanceDB Query implements `AsyncIterable<RecordBatch>`, allowing streaming with backpressure:

```typescript
// Instead of:
const existingRecords = await this.table.query().select(["id", "text_hash"]).toArray();

// Use:
const query = this.table.query().select(["id", "text_hash"]);
for await (const batch of query) {
  for (let i = 0; i < batch.numRows; i++) {
    const id = batch.getChild("id")?.get(i) as string;
    const textHash = batch.getChild("text_hash")?.get(i) as string;
    // Process row...
  }
}
```

**Pros**:
- Built-in backpressure from LanceDB
- No repeated queries
- Single pass through data
- Native support in LanceDB API

**Cons**:
- Requires understanding Arrow RecordBatch API
- Slightly more complex code

### Option B: Limit/Offset Pagination

```typescript
const PAGE_SIZE = 50000;
let offset = 0;
while (true) {
  const batch = await this.table
    .query()
    .select(["id", "text_hash"])
    .limit(PAGE_SIZE)
    .offset(offset)
    .toArray();

  if (batch.length === 0) break;
  // Process batch...
  offset += batch.length;
}
```

**Pros**:
- Simple to understand
- Uses familiar pagination pattern

**Cons**:
- Multiple queries (slower for large datasets)
- Offset queries can be slow in some databases
- Manual pagination logic

### Recommendation

**Option A (RecordBatch Streaming)** is recommended because:
1. Single query execution
2. Built-in memory management via backpressure
3. Native LanceDB pattern for large result sets
4. Better performance characteristics

## Success Criteria

1. `embed generate` completes successfully on workspace with 450k+ existing embeddings using compiled binary
2. All existing resona tests pass
3. Change detection produces identical results (same items skipped/embedded)
4. No measurable performance regression on small datasets (<10k embeddings)

## Edge Cases

| Scenario | Expected Behavior |
|----------|-------------------|
| Empty table | Skip hash loading entirely (current behavior preserved) |
| Table doesn't exist | Catch error, continue with empty hash map |
| Partial batch at end | Process all rows in final batch |
| Null text_hash values | Treat as "needs re-embedding" |

## Testing Requirements

1. **Unit Test**: Mock streaming iterator, verify hash map built correctly
2. **Integration Test**: Create 1000+ embeddings, run embedBatch with change detection
3. **Regression Test**: Verify items with matching hashes are skipped
4. **Memory Test**: (Manual) Verify no crash with large dataset in compiled binary

## References

- [LanceDB Query Class](https://lancedb.github.io/lancedb/js/classes/Query/) - `execute()` returns RecordBatchIterator
- [Bug Report](~/.claude/History/Execution/Bugs/2025-12/2025-12-19-embed-generate-crashes-with-illegal-hardware-instr.md)
- Current implementation: `resona/src/service/embedding-service.ts:279-310`

## Assumptions

1. LanceDB RecordBatch iteration is stable and production-ready
2. The crash is caused by memory pressure, not a different issue
3. Streaming will not significantly slow down the hash loading phase
