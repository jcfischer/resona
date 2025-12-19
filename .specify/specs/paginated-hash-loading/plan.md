---
feature: "paginated-hash-loading"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: Paginated Hash Loading for Change Detection

## Architecture Overview

Replace the single `.toArray()` call that loads all records into memory with streaming iteration over RecordBatches. The change is localized to the hash map building section of `embedBatch()`.

```
┌─────────────────────────────────────────────────────────────────┐
│                    embedBatch() method                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  BEFORE (memory spike):                                         │
│  ┌─────────────┐     ┌──────────────────────┐                   │
│  │   LanceDB   │────▶│  450k records array  │────▶ Hash Maps    │
│  │   .toArray()│     │   (all in memory)    │                   │
│  └─────────────┘     └──────────────────────┘                   │
│                                                                 │
│  AFTER (bounded memory):                                        │
│  ┌─────────────┐     ┌──────────────────────┐                   │
│  │   LanceDB   │────▶│  RecordBatch (~1k)   │────▶ Hash Maps    │
│  │ for await() │     │ (stream + discard)   │     (build incr.) │
│  └─────────────┘     └──────────────────────┘                   │
│         │                     │                                 │
│         └─────────────────────┘                                 │
│              iterate until done                                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Key insight**: The hash maps (`baseHashMap`, `existingIds`, `existingChunks`) are still built completely, but we never hold all raw records in memory simultaneously.

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | PAI standard, existing codebase |
| Runtime | Bun | PAI standard, existing codebase |
| Database | LanceDB | Existing, has streaming support |
| Arrow | apache-arrow | LanceDB dependency, RecordBatch API |

No new dependencies required.

## Constitutional Compliance

- [x] **CLI-First:** No CLI changes - internal optimization only
- [x] **Library-First:** Change is in reusable `embedding-service.ts` module
- [x] **Test-First:** TDD approach with regression test before implementation
- [x] **Deterministic:** Same hash comparison logic, deterministic results
- [x] **Code Before Prompts:** Pure code change, no prompts involved

## Data Model

No schema changes. The existing data structures remain identical:

```typescript
// Built incrementally from streaming batches (no change to structure)
const baseHashMap = new Map<string, string>();      // baseId -> text_hash
const existingIds = new Set<string>();              // All IDs including chunks
const existingChunks = new Map<string, string[]>(); // baseId -> [chunkId1, ...]
```

### Arrow RecordBatch Access Pattern

```typescript
// New: Accessing columns from Arrow RecordBatch
const idColumn = batch.getChild("id");
const hashColumn = batch.getChild("text_hash");

for (let i = 0; i < batch.numRows; i++) {
  const id = idColumn?.get(i) as string;
  const textHash = hashColumn?.get(i) as string;
  // ... same map building logic
}
```

## API Contracts

### Internal APIs

No public API changes. Internal method signature remains:

```typescript
async embedBatch(
  items: ItemToEmbed[],
  options?: BatchEmbedOptions
): Promise<BatchEmbedResult>
```

### New Private Helper (Optional)

```typescript
/**
 * Stream existing records and build hash maps for change detection.
 * Uses RecordBatch iteration to avoid loading all records into memory.
 */
private async buildHashMapsStreaming(): Promise<{
  baseHashMap: Map<string, string>;
  existingIds: Set<string>;
  existingChunks: Map<string, string[]>;
}>
```

## Implementation Strategy

### Phase 1: Foundation (Test Infrastructure)

Write regression test FIRST to ensure behavior doesn't change.

- [ ] Create test that embeds 1000+ items, re-runs with some changed, verifies correct skip count
- [ ] Test passes with current `.toArray()` implementation
- [ ] Test will catch any behavioral drift after refactor

### Phase 2: Core (Streaming Implementation)

Replace `.toArray()` with streaming iteration.

- [ ] Replace `toArray()` with `for await (const batch of query)`
- [ ] Extract column accessors using Arrow API
- [ ] Add debug logging for progress (every 50k records)
- [ ] Verify all existing tests pass

### Phase 3: Integration (Verification)

- [ ] Manual test with compiled binary on large workspace
- [ ] Verify SIGILL crash is resolved
- [ ] Update bug report with fix status

## File Structure

```
resona/
├── src/
│   └── service/
│       └── embedding-service.ts    # [Modified] ~15 lines changed
└── test/
    └── service/
        └── embedding-service.test.ts  # [Modified] ~30 lines added
```

**Changes localized to lines 279-310 in embedding-service.ts**

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Arrow API behaves differently than expected | High | Low | Read LanceDB source, test with real data |
| Performance regression on small datasets | Medium | Low | Benchmark before/after with 1k items |
| RecordBatch column access returns wrong types | Medium | Low | Type assertions with runtime checks |
| Streaming doesn't fix SIGILL (different root cause) | High | Low | If fix fails, investigate further |

## Dependencies

### External

- `@lancedb/lancedb` - Already installed, provides Query AsyncIterable
- `apache-arrow` - Already installed (LanceDB peer dep), provides RecordBatch

### Internal

- `getBaseId()` - Existing helper function, no changes
- `hashText()` - Existing helper function, no changes

## Migration/Deployment

- [ ] **Database migrations needed?** No
- [ ] **Environment variables?** No (RESONA_DEBUG already exists)
- [ ] **Breaking changes?** No - internal optimization only

## Estimated Complexity

- **New files:** 0
- **Modified files:** 2 (embedding-service.ts, embedding-service.test.ts)
- **Test files:** 1 modified (add regression test)
- **Estimated tasks:** 4-5
- **Lines changed:** ~50

## Code Change Preview

```typescript
// BEFORE (lines 284-287):
const existingRecords = await this.table
  .query()
  .select(["id", "text_hash"])
  .toArray();

// AFTER:
const query = this.table.query().select(["id", "text_hash"]);
let loadedCount = 0;
for await (const batch of query) {
  const idColumn = batch.getChild("id");
  const hashColumn = batch.getChild("text_hash");

  for (let i = 0; i < batch.numRows; i++) {
    const id = idColumn?.get(i) as string;
    const textHash = hashColumn?.get(i) as string;

    const baseId = getBaseId(id);
    existingIds.add(id);

    if (!baseHashMap.has(baseId)) {
      baseHashMap.set(baseId, textHash);
    }

    if (!existingChunks.has(baseId)) {
      existingChunks.set(baseId, []);
    }
    existingChunks.get(baseId)!.push(id);

    loadedCount++;
  }

  if (process.env.RESONA_DEBUG && loadedCount % 50000 === 0) {
    console.error(`[resona] Loaded ${loadedCount} embeddings...`);
  }
}
```
