---
feature: "database-maintenance"
spec: "./spec.md"
status: "draft"
---

# Technical Plan: Database Maintenance for Resona

## Architecture Overview

Extend EmbeddingService with maintenance capabilities. The design follows the existing pattern where all LanceDB operations are encapsulated within EmbeddingService.

```
┌─────────────────────────────────────────────────────────────┐
│                    EmbeddingService                         │
├─────────────────────────────────────────────────────────────┤
│  Existing Methods:                                          │
│  ├─ embed()           - Single item embedding               │
│  ├─ embedBatch()      - Batch embedding with chunking       │
│  ├─ search()          - Vector similarity search            │
│  ├─ delete()          - Remove embeddings                   │
│  └─ getStats()        - Basic statistics                    │
│                                                             │
│  NEW Methods:                                               │
│  ├─ getDiagnostics()  - Health check (read-only)           │
│  └─ maintain()        - Compact + reindex + cleanup         │
├─────────────────────────────────────────────────────────────┤
│                    LanceDB Table                            │
│  ├─ compactFiles()                                          │
│  ├─ createIndex()                                           │
│  ├─ indexStats()                                            │
│  ├─ cleanupOldVersions()                                    │
│  ├─ version()                                               │
│  └─ countRows()                                             │
└─────────────────────────────────────────────────────────────┘
```

## Technology Stack

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Language | TypeScript | PAI standard, existing codebase |
| Runtime | Bun | PAI standard, existing codebase |
| Database | LanceDB (@lancedb/lancedb) | Already in use, provides maintenance APIs |
| Testing | bun:test | PAI standard, existing test suite |

No new dependencies required - all APIs available in existing LanceDB package.

## Constitutional Compliance

- [x] **CLI-First:** Exposes `supertag embed maintain` and `supertag embed stats` commands
- [x] **Library-First:** Core logic in EmbeddingService, CLI wraps library
- [x] **Test-First:** TDD with 5 test cases from spec
- [x] **Deterministic:** All operations are deterministic (compaction, indexing, cleanup)
- [x] **Code Before Prompts:** Pure code implementation, no prompts involved

## Data Model

### New Types (add to types.ts)

```typescript
/**
 * Options for database maintenance operations
 */
export interface MaintenanceOptions {
  /** Skip compaction (default: false) */
  skipCompaction?: boolean;

  /** Skip index rebuild even if stale (default: false) */
  skipIndex?: boolean;

  /** Skip version cleanup (default: false) */
  skipCleanup?: boolean;

  /** Days to retain old versions (default: 7) */
  retentionDays?: number;

  /** Target rows per fragment for compaction (default: 500000) */
  targetRowsPerFragment?: number;

  /** Threshold for index staleness (default: 0.1 = 10%) */
  indexStaleThreshold?: number;

  /** Progress callback for long operations */
  onProgress?: (step: string, details?: string) => void;
}

/**
 * Result of maintenance operations
 */
export interface MaintenanceResult {
  /** Compaction metrics */
  compaction?: {
    fragmentsRemoved: number;
    filesCreated: number;
  };

  /** Whether index was rebuilt */
  indexRebuilt: boolean;

  /** Index stats after maintenance */
  indexStats?: {
    numIndexedRows: number;
    numUnindexedRows: number;
  };

  /** Cleanup stats */
  cleanup?: {
    bytesRemoved: number;
    versionsRemoved: number;
  };

  /** Total duration in milliseconds */
  durationMs: number;
}

/**
 * Database health diagnostics
 */
export interface DatabaseDiagnostics {
  /** Total embeddings stored */
  totalRows: number;

  /** Current table version */
  version: number;

  /** Index health (null if no index exists) */
  index: {
    numIndexedRows: number;
    numUnindexedRows: number;
    stalePercent: number;
    needsRebuild: boolean;
  } | null;

  /** Database file path */
  dbPath: string;
}
```

### No Database Schema Changes

LanceDB table schema unchanged. Maintenance operates on existing structures.

## API Contracts

### Internal APIs (EmbeddingService methods)

```typescript
/**
 * Get database health diagnostics without modifying data
 * @returns Diagnostic information about table health
 */
async getDiagnostics(): Promise<DatabaseDiagnostics>

/**
 * Run database maintenance: compact, reindex, cleanup
 * @param options - Maintenance configuration
 * @returns Results of maintenance operations
 */
async maintain(options?: MaintenanceOptions): Promise<MaintenanceResult>
```

### LanceDB APIs Used

```typescript
// From @lancedb/lancedb Table interface
table.compactFiles(options?: CompactionOptions): Promise<CompactionMetrics>
table.createIndex(column: string, options?: IndexOptions): Promise<void>
table.indexStats(column: string): Promise<IndexStats | undefined>
table.cleanupOldVersions(olderThan?: Date): Promise<CleanupStats>
table.version(): Promise<number>
table.countRows(): Promise<number>
```

## Implementation Strategy

### Phase 1: Foundation (Types + Diagnostics)

Build read-only diagnostic capability first.

- [x] Add types to `types.ts` (MaintenanceOptions, MaintenanceResult, DatabaseDiagnostics)
- [ ] Implement `getDiagnostics()` in EmbeddingService
- [ ] Write tests for diagnostics (TC-5)
- [ ] Export new types from index.ts

### Phase 2: Core Maintenance

Implement the three maintenance operations.

- [ ] Implement `maintain()` method structure
- [ ] Add compaction step with progress callback
- [ ] Add index rebuild step with staleness check
- [ ] Add cleanup step with retention policy
- [ ] Write tests for each operation (TC-1, TC-2, TC-3, TC-4)

### Phase 3: CLI Integration (tana skill)

Wire into supertag CLI.

- [ ] Add `embed stats` command
- [ ] Add `embed maintain` command with flags
- [ ] Add progress display for long operations
- [ ] Update embed.ts help text

## File Structure

```
resona/
├── src/
│   ├── types.ts                    # [Modified] Add 3 new interfaces
│   ├── service/
│   │   └── embedding-service.ts    # [Modified] Add getDiagnostics(), maintain()
│   └── index.ts                    # [Modified] Export new types
│
└── test/
    └── service/
        └── embedding-service.test.ts  # [Modified] Add 5 new test cases

tana/
└── src/
    └── commands/
        └── embed.ts                # [Modified] Add stats, maintain subcommands
```

## Risk Assessment

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| LanceDB indexStats() returns undefined | Medium | Low | Handle null case, skip rebuild |
| Compaction fails on large tables | High | Low | Catch error, report in result |
| Index rebuild takes too long | Medium | Medium | Progress callback, document expected time |
| cleanupOldVersions deletes too much | High | Low | 7-day default retention, never delete current |

## Dependencies

### External

- `@lancedb/lancedb` (already installed) - Provides all maintenance APIs

### Internal

- `EmbeddingService` - Extend with new methods
- `types.ts` - Add new interface definitions

## Migration/Deployment

- [ ] **Database migrations needed?** No - operates on existing LanceDB tables
- [ ] **Environment variables?** No new ones (uses existing RESONA_DEBUG)
- [ ] **Breaking changes?** No - purely additive methods

### Recommended Post-Deployment

After releasing, recommend running maintenance on existing databases:
```bash
supertag embed maintain --retention-days 7
```

## Estimated Complexity

- **New files:** 0
- **Modified files:** 4 (types.ts, embedding-service.ts, index.ts, embed.ts)
- **Test files:** 1 modified (add 5 test cases)
- **Estimated tasks:** 8-10
- **Lines of code:** ~150 library, ~50 CLI, ~100 tests
