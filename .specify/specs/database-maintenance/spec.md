# Specification: Database Maintenance for Resona

**Date**: 2025-12-19
**Status**: Draft
**Author**: PAI

## Problem Statement

After bulk embedding operations (e.g., embedding 150k Tana nodes), LanceDB accumulates:
1. **Fragments**: Many small data files from incremental inserts
2. **Stale indexes**: New vectors not covered by the ANN index
3. **Old versions**: Historical snapshots consuming disk space

Without maintenance, query performance degrades over time.

## User Stories

### US-1: Post-Ingestion Optimization
> As a user running `supertag embed generate`, I want the database to be optimized after bulk embedding so that semantic search remains fast.

### US-2: Scheduled Maintenance
> As a system administrator, I want to run periodic maintenance to keep the embedding database healthy.

### US-3: Maintenance Visibility
> As a user, I want to see what maintenance operations are performed and their impact (bytes freed, fragments merged, etc.).

## Functional Requirements

### FR-1: Maintenance Method on EmbeddingService
Add a `maintain()` method to `EmbeddingService` that performs:
1. **Compact fragments** - Merge small files, materialize deletions
2. **Rebuild index if stale** - Check `indexStats()`, rebuild if >10% unindexed
3. **Cleanup old versions** - Remove versions older than retention period

### FR-2: Maintenance Options
```typescript
interface MaintenanceOptions {
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
```

### FR-3: Maintenance Result
```typescript
interface MaintenanceResult {
  /** Compaction metrics from LanceDB */
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
```

### FR-4: Diagnostic Method
Add a `getDiagnostics()` method that returns current health metrics without performing maintenance:
```typescript
interface DatabaseDiagnostics {
  /** Total embeddings stored */
  totalRows: number;

  /** Current table version */
  version: number;

  /** Index health */
  index?: {
    numIndexedRows: number;
    numUnindexedRows: number;
    stalePercent: number;
    needsRebuild: boolean;
  };

  /** Estimated reclaimable space (if available) */
  reclaimableBytes?: number;
}
```

## Non-Functional Requirements

### NFR-1: Performance
- Compaction should not block queries (LanceDB handles this)
- Index rebuild may take minutes for large datasets - provide progress

### NFR-2: Safety
- Never delete current version
- Default retention of 7 days provides rollback window
- Maintenance is idempotent - safe to run multiple times

### NFR-3: Observability
- Debug logging via `RESONA_DEBUG=1`
- Progress callback for CLI integration

## Success Criteria

1. After `embed generate` + `maintain()`, query latency returns to baseline
2. `getDiagnostics()` accurately reports index staleness
3. `maintain()` returns actionable metrics
4. All operations are logged when `RESONA_DEBUG=1`

## Out of Scope

- Automatic scheduled maintenance (caller's responsibility)
- Cross-table optimization (single table per EmbeddingService)
- LanceDB Cloud-specific features (optimize() auto-handling)

## API Design

```typescript
// EmbeddingService additions
class EmbeddingService {
  // ... existing methods ...

  /**
   * Get database health diagnostics without modifying data
   */
  async getDiagnostics(): Promise<DatabaseDiagnostics>;

  /**
   * Run database maintenance: compact, reindex, cleanup
   */
  async maintain(options?: MaintenanceOptions): Promise<MaintenanceResult>;
}
```

## CLI Integration (tana skill)

```bash
# Run maintenance after embedding
supertag embed maintain [--skip-compact] [--skip-index] [--retention-days <n>]

# Show diagnostics only
supertag embed stats
```

## Test Cases

### TC-1: Maintenance after bulk insert
- Insert 1000 embeddings in batches of 10
- Verify fragments > 1
- Run `maintain()`
- Verify compaction occurred

### TC-2: Index rebuild detection
- Create table with 1000 embeddings
- Create index
- Add 200 more embeddings (20% unindexed)
- Run `maintain()` with `indexStaleThreshold: 0.1`
- Verify index was rebuilt

### TC-3: Cleanup old versions
- Create table, add data
- Run `compactFiles()` to create new version
- Run `maintain({ retentionDays: 0 })`
- Verify old versions cleaned up

### TC-4: Skip options respected
- Run `maintain({ skipCompaction: true, skipIndex: true })`
- Verify only cleanup runs

### TC-5: Diagnostics accuracy
- Create table with known state
- Verify `getDiagnostics()` returns accurate metrics
