---
feature: "paginated-hash-loading"
plan: "./plan.md"
status: "completed"
total_tasks: 5
completed: 5
---

# Tasks: Paginated Hash Loading for Change Detection

## Legend

- `[T]` - Test required (TDD mandatory - write test FIRST)
- `[P]` - Can run in parallel with other [P] tasks in same group
- `depends: T-X.Y` - Must complete after specified task(s)

## Task Groups

### Group 1: Foundation (Test Infrastructure)

- [ ] **T-1.1** Add regression test for change detection behavior [T]
  - File: `test/service/embedding-service.test.ts`
  - Test: Self-contained (this IS the test)
  - Description: Create test that embeds items, modifies some, re-embeds, and verifies correct skip count. This test MUST pass with current `.toArray()` implementation before any refactoring.

### Group 2: Core Implementation

- [ ] **T-2.1** Extract hash map building into streaming helper [T] (depends: T-1.1)
  - File: `src/service/embedding-service.ts`
  - Test: `test/service/embedding-service.test.ts`
  - Description: Replace `.toArray()` with `for await (const batch of query)` streaming. Build `baseHashMap`, `existingIds`, and `existingChunks` incrementally from RecordBatch data using Arrow column accessors.

- [ ] **T-2.2** Add progress logging for large datasets (depends: T-2.1)
  - File: `src/service/embedding-service.ts`
  - Test: Not required (debug logging only)
  - Description: When `RESONA_DEBUG=1`, log progress every 50k records loaded. Format: `[resona] Loaded 50000 embeddings...`

### Group 3: Integration (Verification)

- [ ] **T-3.1** Verify all existing tests pass [T] (depends: T-2.2)
  - Files: All test files
  - Test: Run full test suite
  - Description: Run `bun test` and ensure all 125+ tests pass. Regression test from T-1.1 MUST still pass. This validates behavioral equivalence.

- [ ] **T-3.2** Manual verification with compiled binary (depends: T-3.1)
  - Files: None (manual testing)
  - Description: Rebuild supertag binary, run `./supertag embed generate -w main` on large workspace (450k+ embeddings). Verify no SIGILL crash. Update bug report if fixed.

## Dependency Graph

```
T-1.1 ──> T-2.1 ──> T-2.2 ──> T-3.1 ──> T-3.2
  │         │
  │         └── [Core streaming implementation]
  │
  └── [Regression test - MUST pass before AND after]
```

## Execution Order

1. **T-1.1** - Write regression test (proves current behavior)
2. **T-2.1** - Implement streaming (main change)
3. **T-2.2** - Add debug logging
4. **T-3.1** - Run full test suite
5. **T-3.2** - Manual binary test

**Critical path:** All tasks are sequential (no parallelism). Total: 5 tasks.

## Progress Tracking

| Task | Status | Started | Completed | Notes |
|------|--------|---------|-----------|-------|
| T-1.1 | completed | 2025-12-19 | 2025-12-19 | 2 regression tests added |
| T-2.1 | completed | 2025-12-19 | 2025-12-19 | Streaming via AsyncIterable<RecordBatch> |
| T-2.2 | completed | 2025-12-19 | 2025-12-19 | Logs every 50k records |
| T-3.1 | completed | 2025-12-19 | 2025-12-19 | 127 tests pass |
| T-3.2 | completed | 2025-12-19 | 2025-12-19 | Binary processed 318k nodes, no crash |

## TDD Reminder

For each task marked [T]:

1. **RED:** Write failing test first
2. **GREEN:** Write minimal implementation to pass
3. **BLUE:** Refactor while keeping tests green
4. **VERIFY:** Run full test suite (`bun test`)

**DO NOT proceed to next task until:**
- Current task's tests pass
- Full test suite passes (no regressions)

## Task Details

### T-1.1: Regression Test

```typescript
it("should correctly skip unchanged items during re-embedding", async () => {
  // 1. Embed 100 items
  // 2. Modify 20 of them (change text)
  // 3. Re-run embedBatch with all 100
  // 4. Verify: 20 processed, 80 skipped
});
```

### T-2.1: Streaming Implementation

Replace lines 284-287:
```typescript
// FROM:
const existingRecords = await this.table.query().select(["id", "text_hash"]).toArray();

// TO:
const query = this.table.query().select(["id", "text_hash"]);
for await (const batch of query) {
  // Process batch rows using Arrow column accessors
}
```

### T-2.2: Debug Logging

Add after batch processing:
```typescript
if (process.env.RESONA_DEBUG && loadedCount % 50000 === 0) {
  console.error(`[resona] Loaded ${loadedCount} embeddings...`);
}
```

## Blockers & Issues

[Track any blockers discovered during implementation]

| Task | Issue | Resolution |
|------|-------|------------|
| - | - | - |
