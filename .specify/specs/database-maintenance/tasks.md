---
feature: "database-maintenance"
plan: "./plan.md"
status: "pending"
total_tasks: 9
completed: 0
---

# Tasks: Database Maintenance for Resona

## Legend

- `[T]` - Test required (TDD mandatory - write test FIRST)
- `[P]` - Can run in parallel with other [P] tasks in same group
- `depends: T-X.Y` - Must complete after specified task(s)

## Task Groups

### Group 1: Foundation (Types)

- [ ] **T-1.1** Add maintenance types to types.ts [T]
  - File: `resona/src/types.ts`
  - Test: `resona/test/types.test.ts` (new file)
  - Description: Add MaintenanceOptions, MaintenanceResult, DatabaseDiagnostics interfaces. Test type exports.

- [ ] **T-1.2** Export new types from index.ts
  - File: `resona/src/index.ts`
  - Test: N/A (covered by T-1.1)
  - Description: Re-export new interfaces from package entry point.

### Group 2: Core Implementation (EmbeddingService)

- [ ] **T-2.1** Implement getDiagnostics() method [T] (depends: T-1.1)
  - File: `resona/src/service/embedding-service.ts`
  - Test: `resona/test/service/embedding-service.test.ts`
  - Description: Read-only diagnostics: row count, version, index stats. TC-5 from spec.

- [ ] **T-2.2** Implement maintain() - compaction step [T] (depends: T-2.1)
  - File: `resona/src/service/embedding-service.ts`
  - Test: `resona/test/service/embedding-service.test.ts`
  - Description: Add maintain() skeleton, implement compactFiles() call with options. TC-1 from spec.

- [ ] **T-2.3** Implement maintain() - index rebuild step [T] (depends: T-2.2)
  - File: `resona/src/service/embedding-service.ts`
  - Test: `resona/test/service/embedding-service.test.ts`
  - Description: Check indexStats(), rebuild if stale (>threshold unindexed). TC-2 from spec.

- [ ] **T-2.4** Implement maintain() - cleanup step [T] (depends: T-2.3)
  - File: `resona/src/service/embedding-service.ts`
  - Test: `resona/test/service/embedding-service.test.ts`
  - Description: Call cleanupOldVersions() with retention policy. TC-3 from spec.

- [ ] **T-2.5** Implement skip options [T] (depends: T-2.4)
  - File: `resona/src/service/embedding-service.ts`
  - Test: `resona/test/service/embedding-service.test.ts`
  - Description: Honor skipCompaction, skipIndex, skipCleanup flags. TC-4 from spec.

### Group 3: CLI Integration (tana skill)

- [ ] **T-3.1** Add `embed stats` command [T] (depends: T-2.1)
  - File: `tana/src/commands/embed.ts`
  - Test: `tana/test/commands/embed.test.ts`
  - Description: Display getDiagnostics() output in formatted table.

- [ ] **T-3.2** Add `embed maintain` command [T] (depends: T-2.5)
  - File: `tana/src/commands/embed.ts`
  - Test: `tana/test/commands/embed.test.ts`
  - Description: Run maintain() with CLI flags: --skip-compact, --skip-index, --retention-days. Show progress and results.

## Dependency Graph

```
T-1.1 ───> T-1.2
  │
  v
T-2.1 ───────────────────> T-3.1 (CLI stats)
  │
  v
T-2.2 (compaction)
  │
  v
T-2.3 (index rebuild)
  │
  v
T-2.4 (cleanup)
  │
  v
T-2.5 (skip options) ───> T-3.2 (CLI maintain)
```

## Execution Order

1. **Batch 1:** T-1.1 (types)
2. **Batch 2:** T-1.2 (exports) - fast, follows T-1.1
3. **Batch 3:** T-2.1 (diagnostics) - can start T-3.1 after
4. **Sequential:** T-2.2 → T-2.3 → T-2.4 → T-2.5 (maintain steps)
5. **Parallel opportunity:** T-3.1 can run after T-2.1 (doesn't need maintain())
6. **Final:** T-3.2 (CLI maintain, needs full maintain() implementation)

**Critical Path:** T-1.1 → T-2.1 → T-2.2 → T-2.3 → T-2.4 → T-2.5 → T-3.2

## Progress Tracking

| Task | Status | Started | Completed | Notes |
|------|--------|---------|-----------|-------|
| T-1.1 | pending | - | - | Types for maintenance |
| T-1.2 | pending | - | - | Export types |
| T-2.1 | pending | - | - | getDiagnostics() |
| T-2.2 | pending | - | - | maintain() compaction |
| T-2.3 | pending | - | - | maintain() index |
| T-2.4 | pending | - | - | maintain() cleanup |
| T-2.5 | pending | - | - | maintain() skip flags |
| T-3.1 | pending | - | - | CLI stats command |
| T-3.2 | pending | - | - | CLI maintain command |

## TDD Reminder

For each task marked [T]:

1. **RED:** Write failing test first
2. **GREEN:** Write minimal implementation to pass
3. **BLUE:** Refactor while keeping tests green
4. **VERIFY:** Run full test suite (`bun test`)

**DO NOT proceed to next task until:**
- Current task's tests pass
- Full test suite passes (no regressions)

## Test Case Mapping

| Spec Test Case | Task |
|----------------|------|
| TC-1: Maintenance after bulk insert | T-2.2 |
| TC-2: Index rebuild detection | T-2.3 |
| TC-3: Cleanup old versions | T-2.4 |
| TC-4: Skip options respected | T-2.5 |
| TC-5: Diagnostics accuracy | T-2.1 |

## Blockers & Issues

[Track any blockers discovered during implementation]

| Task | Issue | Resolution |
|------|-------|------------|
| - | - | - |
