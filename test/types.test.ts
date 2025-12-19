/**
 * Types Tests
 *
 * TDD: Verify new type fields for LanceDB batch optimization
 */

import { describe, it, expect } from "bun:test";
import type {
  BatchEmbedOptions,
  BatchEmbedProgress,
  MaintenanceOptions,
  MaintenanceResult,
  DatabaseDiagnostics,
} from "../src/types";

describe("BatchEmbedOptions", () => {
  it("should accept storeBatchSize option", () => {
    // T-1.1: storeBatchSize should be optional
    const options: BatchEmbedOptions = {};
    expect(options.storeBatchSize).toBeUndefined();

    const optionsWithStore: BatchEmbedOptions = { storeBatchSize: 5000 };
    expect(optionsWithStore.storeBatchSize).toBe(5000);
  });

  it("should allow all existing options alongside storeBatchSize", () => {
    const options: BatchEmbedOptions = {
      onProgress: () => {},
      progressInterval: 100,
      forceAll: true,
      storeBatchSize: 10000,
    };
    expect(options.storeBatchSize).toBe(10000);
    expect(options.forceAll).toBe(true);
  });
});

describe("BatchEmbedProgress", () => {
  it("should include stored field", () => {
    // T-1.2: stored field for LanceDB write count
    const progress: BatchEmbedProgress = {
      processed: 100,
      skipped: 10,
      errors: 0,
      total: 200,
      stored: 50,
      bufferSize: 50,
    };
    expect(progress.stored).toBe(50);
  });

  it("should include bufferSize field", () => {
    // T-1.2: bufferSize field for current buffer occupancy
    const progress: BatchEmbedProgress = {
      processed: 100,
      skipped: 10,
      errors: 0,
      total: 200,
      stored: 50,
      bufferSize: 50,
    };
    expect(progress.bufferSize).toBe(50);
  });

  it("should work with existing optional fields", () => {
    const progress: BatchEmbedProgress = {
      processed: 100,
      skipped: 10,
      errors: 0,
      total: 200,
      stored: 100,
      bufferSize: 0,
      currentItem: "Test item",
      rate: 50.5,
    };
    expect(progress.currentItem).toBe("Test item");
    expect(progress.rate).toBe(50.5);
    expect(progress.stored).toBe(100);
  });
});

// ============================================
// T-1.1: Database Maintenance Types
// ============================================

describe("MaintenanceOptions", () => {
  it("should accept all maintenance options", () => {
    const options: MaintenanceOptions = {
      skipCompaction: true,
      skipIndex: false,
      skipCleanup: false,
      retentionDays: 7,
      targetRowsPerFragment: 500000,
      indexStaleThreshold: 0.1,
      onProgress: (step, details) => console.log(step, details),
    };
    expect(options.retentionDays).toBe(7);
    expect(options.indexStaleThreshold).toBe(0.1);
    expect(options.skipCompaction).toBe(true);
  });

  it("should allow empty options object", () => {
    const options: MaintenanceOptions = {};
    expect(options.skipCompaction).toBeUndefined();
    expect(options.retentionDays).toBeUndefined();
  });
});

describe("MaintenanceResult", () => {
  it("should include all result fields", () => {
    const result: MaintenanceResult = {
      compaction: {
        fragmentsRemoved: 5,
        filesCreated: 1,
      },
      indexRebuilt: true,
      indexStats: {
        numIndexedRows: 1000,
        numUnindexedRows: 0,
      },
      cleanup: {
        bytesRemoved: 1024,
        versionsRemoved: 3,
      },
      durationMs: 5000,
    };
    expect(result.indexRebuilt).toBe(true);
    expect(result.durationMs).toBe(5000);
    expect(result.compaction?.fragmentsRemoved).toBe(5);
    expect(result.cleanup?.bytesRemoved).toBe(1024);
  });

  it("should allow optional compaction and cleanup fields", () => {
    const result: MaintenanceResult = {
      indexRebuilt: false,
      durationMs: 100,
    };
    expect(result.compaction).toBeUndefined();
    expect(result.cleanup).toBeUndefined();
  });
});

describe("DatabaseDiagnostics", () => {
  it("should include all diagnostic fields", () => {
    const diagnostics: DatabaseDiagnostics = {
      totalRows: 10000,
      version: 5,
      index: {
        numIndexedRows: 9000,
        numUnindexedRows: 1000,
        stalePercent: 10,
        needsRebuild: true,
      },
      dbPath: "/path/to/db",
    };
    expect(diagnostics.totalRows).toBe(10000);
    expect(diagnostics.version).toBe(5);
    expect(diagnostics.index?.stalePercent).toBe(10);
    expect(diagnostics.index?.needsRebuild).toBe(true);
  });

  it("should allow null index when no index exists", () => {
    const diagnostics: DatabaseDiagnostics = {
      totalRows: 0,
      version: 1,
      index: null,
      dbPath: "/path/to/db",
    };
    expect(diagnostics.index).toBeNull();
  });
});
