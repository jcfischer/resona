/**
 * Types Tests
 *
 * TDD: Verify new type fields for LanceDB batch optimization
 */

import { describe, it, expect } from "bun:test";
import type { BatchEmbedOptions, BatchEmbedProgress } from "../src/types";

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
