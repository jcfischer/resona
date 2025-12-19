/**
 * EmbeddingService Tests
 *
 * TDD: Tests written first, implementation follows.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { EmbeddingService } from "../../src/service/embedding-service";
import type { EmbeddingProvider, ItemToEmbed } from "../../src/types";
import { rmSync, existsSync } from "fs";

// Mock provider for testing
class MockProvider implements EmbeddingProvider {
  readonly name = "mock";
  readonly model = "mock-model";
  readonly dimensions = 4; // Small for testing
  readonly maxBatchSize = 10;
  readonly supportsAsync = false;

  private callCount = 0;

  async embedSingle(text: string): Promise<Float32Array> {
    this.callCount++;
    // Return deterministic embedding based on text
    const hash = this.simpleHash(text);
    return new Float32Array([
      Math.sin(hash),
      Math.cos(hash),
      Math.sin(hash * 2),
      Math.cos(hash * 2),
    ]);
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return Promise.all(texts.map((t) => this.embedSingle(t)));
  }

  getCallCount(): number {
    return this.callCount;
  }

  resetCallCount(): void {
    this.callCount = 0;
  }

  private simpleHash(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = (hash << 5) - hash + str.charCodeAt(i);
      hash |= 0;
    }
    return hash / 1000000;
  }
}

// LanceDB uses directory, not single file
const TEST_DB_PATH = "/tmp/resona-test.lance";

function cleanupTestDb() {
  if (existsSync(TEST_DB_PATH)) {
    rmSync(TEST_DB_PATH, { recursive: true, force: true });
  }
}

describe("EmbeddingService", () => {
  let provider: MockProvider;
  let service: EmbeddingService;

  beforeAll(() => {
    cleanupTestDb();
  });

  beforeEach(() => {
    cleanupTestDb();
    provider = new MockProvider();
  });

  afterAll(() => {
    cleanupTestDb();
  });

  describe("constructor", () => {
    it("should create service with provider and database path", () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      expect(service).toBeDefined();
      expect(service.provider).toBe(provider);
    });

    it("should initialize LanceDB on first operation", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Trigger initialization by getting stats
      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(0);

      // LanceDB directory should exist after first operation
      expect(existsSync(TEST_DB_PATH)).toBe(true);
    });
  });

  describe("embed", () => {
    it("should embed a single item", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const item: ItemToEmbed = {
        id: "test-1",
        text: "Hello world",
      };

      await service.embed(item);

      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(1);
    });

    it("should use contextText if provided", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const item: ItemToEmbed = {
        id: "test-1",
        text: "Short text",
        contextText: "This is the enriched context that will be embedded",
      };

      await service.embed(item);

      const stored = await service.getEmbedding("test-1");
      expect(stored?.contextText).toBe(
        "This is the enriched context that will be embedded"
      );
    });

    it("should store metadata alongside embedding", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const item: ItemToEmbed = {
        id: "test-1",
        text: "Hello world",
        metadata: { tags: ["test", "example"], priority: 1 },
      };

      await service.embed(item);

      const stored = await service.getEmbedding("test-1");
      expect(stored?.metadata).toEqual({ tags: ["test", "example"], priority: 1 });
    });

    it("should skip unchanged items based on text hash", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const item: ItemToEmbed = {
        id: "test-1",
        text: "Hello world",
      };

      // First embed
      await service.embed(item);
      const initialCallCount = provider.getCallCount();

      // Second embed with same text - should skip
      await service.embed(item);
      expect(provider.getCallCount()).toBe(initialCallCount); // No additional calls
    });

    it("should re-embed when text changes", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const item: ItemToEmbed = {
        id: "test-1",
        text: "Hello world",
      };

      await service.embed(item);
      const initialCallCount = provider.getCallCount();

      // Update text
      item.text = "Hello universe";
      await service.embed(item);

      expect(provider.getCallCount()).toBe(initialCallCount + 1);
    });
  });

  describe("embedBatch", () => {
    describe("storeBatchSize option", () => {
      it("should buffer writes until threshold", async () => {
        // T-2.1: Buffer writes until storeBatchSize threshold
        service = new EmbeddingService(provider, TEST_DB_PATH);

        // Create 250 items - with storeBatchSize=100, expect 3 writes:
        // 100 + 100 + 50 (final flush)
        const items: ItemToEmbed[] = Array.from({ length: 250 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i} with some text`,
        }));

        // Track storeEmbeddingsBatch calls by checking stats at intervals
        // Since provider.maxBatchSize is 10, we process 25 Ollama batches
        // Without storeBatchSize, this would be 25 LanceDB writes
        // With storeBatchSize=100, it should be 3 LanceDB writes

        const result = await service.embedBatch(items, { storeBatchSize: 100 });

        expect(result.processed).toBe(250);
        expect(result.errors).toBe(0);

        // Verify all items are in the database
        const stats = await service.getStats();
        expect(stats.totalEmbeddings).toBe(250);
      });

      it("should use default storeBatchSize of 5000", async () => {
        // T-2.1: Default behavior buffers up to 5000
        service = new EmbeddingService(provider, TEST_DB_PATH);

        // With 100 items and default storeBatchSize=5000:
        // All items buffered, single flush at end
        const items: ItemToEmbed[] = Array.from({ length: 100 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i}`,
        }));

        const result = await service.embedBatch(items);

        expect(result.processed).toBe(100);

        const stats = await service.getStats();
        expect(stats.totalEmbeddings).toBe(100);
      });

      it("should report stored count in progress", async () => {
        // T-2.2: Progress callback includes stored and bufferSize fields
        service = new EmbeddingService(provider, TEST_DB_PATH);

        const items: ItemToEmbed[] = Array.from({ length: 150 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i} with text`,
        }));

        const progressSnapshots: Array<{
          processed: number;
          stored: number;
          bufferSize: number;
        }> = [];

        await service.embedBatch(items, {
          storeBatchSize: 100,
          onProgress: (progress) => {
            progressSnapshots.push({
              processed: progress.processed,
              stored: progress.stored,
              bufferSize: progress.bufferSize,
            });
          },
          progressInterval: 10,
        });

        // Should have progress callbacks
        expect(progressSnapshots.length).toBeGreaterThan(0);

        // stored should lag behind processed (buffering happening)
        // At some point, stored should be less than processed
        const hasBuffering = progressSnapshots.some(
          (p) => p.stored < p.processed
        );
        expect(hasBuffering).toBe(true);

        // bufferSize should be defined in all callbacks
        for (const p of progressSnapshots) {
          expect(typeof p.bufferSize).toBe("number");
          expect(typeof p.stored).toBe("number");
        }
      });

      it("should increment stored counter after flush", async () => {
        // Regression test: stored counter must become > 0 after first flush
        service = new EmbeddingService(provider, TEST_DB_PATH);

        // 250 items with storeBatchSize=100, progressInterval=10
        // First flush at 100 items, second at 200 items, 50 remain at end
        const items: ItemToEmbed[] = Array.from({ length: 250 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i} with text`,
        }));

        const progressSnapshots: Array<{
          processed: number;
          stored: number;
          bufferSize: number;
        }> = [];

        await service.embedBatch(items, {
          storeBatchSize: 100,
          progressInterval: 10,
          onProgress: (progress) => {
            progressSnapshots.push({
              processed: progress.processed,
              stored: progress.stored,
              bufferSize: progress.bufferSize,
            });
          },
        });

        // CRITICAL: stored must become > 0 at some point after first flush
        const hasStoredData = progressSnapshots.some((p) => p.stored > 0);
        expect(hasStoredData).toBe(true);

        // After processing 100+ items, stored should equal 100 (first flush happened)
        const afterFirstFlush = progressSnapshots.find((p) => p.processed >= 110);
        expect(afterFirstFlush).toBeDefined();
        expect(afterFirstFlush!.stored).toBe(100);

        // After processing 200+ items, stored should equal 200 (second flush happened)
        const afterSecondFlush = progressSnapshots.find((p) => p.processed >= 210);
        expect(afterSecondFlush).toBeDefined();
        expect(afterSecondFlush!.stored).toBe(200);
      });

      it("should flush remaining buffer at end", async () => {
        // T-2.3: Remaining buffer flushed when processing completes
        service = new EmbeddingService(provider, TEST_DB_PATH);

        // 150 items with storeBatchSize=100
        // Should write 100 at threshold, then 50 at end
        const items: ItemToEmbed[] = Array.from({ length: 150 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i} with some text`,
        }));

        const result = await service.embedBatch(items, { storeBatchSize: 100 });

        expect(result.processed).toBe(150);

        // ALL 150 items should be in the database (including the 50 flushed at end)
        const stats = await service.getStats();
        expect(stats.totalEmbeddings).toBe(150);
      });
    });

    it("should embed multiple items", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const items: ItemToEmbed[] = [
        { id: "item-1", text: "First item" },
        { id: "item-2", text: "Second item" },
        { id: "item-3", text: "Third item" },
      ];

      const result = await service.embedBatch(items);

      expect(result.processed).toBe(3);
      expect(result.skipped).toBe(0);
      expect(result.errors).toBe(0);

      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(3);
    });

    it("should skip unchanged items in batch", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const items: ItemToEmbed[] = [
        { id: "item-1", text: "First item" },
        { id: "item-2", text: "Second item" },
      ];

      // First batch
      await service.embedBatch(items);

      // Add one new item
      const newItems: ItemToEmbed[] = [
        { id: "item-1", text: "First item" }, // unchanged
        { id: "item-2", text: "Second item" }, // unchanged
        { id: "item-3", text: "Third item" }, // new
      ];

      const result = await service.embedBatch(newItems);

      expect(result.processed).toBe(1);
      expect(result.skipped).toBe(2);
    });

    it("should call progress callback", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const items: ItemToEmbed[] = Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        text: `Item number ${i}`,
      }));

      const progressCalls: number[] = [];

      await service.embedBatch(items, {
        onProgress: (progress) => {
          progressCalls.push(progress.processed + progress.skipped);
        },
        progressInterval: 2,
      });

      expect(progressCalls.length).toBeGreaterThan(0);
    });

    it("should support forceAll option", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const items: ItemToEmbed[] = [
        { id: "item-1", text: "First item" },
        { id: "item-2", text: "Second item" },
      ];

      // First embed
      await service.embedBatch(items);
      provider.resetCallCount();

      // Force re-embed all
      const result = await service.embedBatch(items, { forceAll: true });

      expect(result.processed).toBe(2);
      expect(result.skipped).toBe(0);
      expect(provider.getCallCount()).toBe(2);
    });

    describe("backward compatibility", () => {
      it("should work without storeBatchSize option", async () => {
        // T-3.1: Existing callers without new option should work unchanged
        service = new EmbeddingService(provider, TEST_DB_PATH);

        const items: ItemToEmbed[] = [
          { id: "item-1", text: "First item" },
          { id: "item-2", text: "Second item" },
          { id: "item-3", text: "Third item" },
        ];

        // Call without storeBatchSize - should use default
        const result = await service.embedBatch(items);

        expect(result.processed).toBe(3);
        expect(result.skipped).toBe(0);
        expect(result.errors).toBe(0);

        const stats = await service.getStats();
        expect(stats.totalEmbeddings).toBe(3);
      });

      it("should not break existing progress callbacks", async () => {
        // T-3.1: Old-style callbacks that don't use new fields should still work
        service = new EmbeddingService(provider, TEST_DB_PATH);

        const items: ItemToEmbed[] = Array.from({ length: 20 }, (_, i) => ({
          id: `item-${i}`,
          text: `Item number ${i}`,
        }));

        let callbackCount = 0;

        // Old-style callback that only uses existing fields
        await service.embedBatch(items, {
          onProgress: ({ processed, total, skipped, errors }) => {
            // Destructuring without new fields should work
            expect(typeof processed).toBe("number");
            expect(typeof total).toBe("number");
            expect(typeof skipped).toBe("number");
            expect(typeof errors).toBe("number");
            callbackCount++;
          },
          progressInterval: 5,
        });

        expect(callbackCount).toBeGreaterThan(0);
      });
    });
  });

  describe("search", () => {
    it("should find similar items by query text", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Embed some items
      await service.embedBatch([
        { id: "item-1", text: "The quick brown fox" },
        { id: "item-2", text: "A lazy dog sleeps" },
        { id: "item-3", text: "The fast brown fox jumps" },
      ]);

      const results = await service.search("quick fox", 2);

      expect(results.length).toBe(2);
      expect(results[0]).toHaveProperty("id");
      expect(results[0]).toHaveProperty("similarity");
      expect(results[0]).toHaveProperty("distance");
      expect(results[0].similarity).toBeGreaterThanOrEqual(0);
      expect(results[0].similarity).toBeLessThanOrEqual(1);
    });

    it("should return results sorted by similarity (descending)", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "item-1", text: "Hello world" },
        { id: "item-2", text: "Goodbye universe" },
        { id: "item-3", text: "Hello everyone" },
      ]);

      const results = await service.search("Hello", 3);

      // Results should be sorted by similarity (highest first)
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(
          results[i].similarity
        );
      }
    });

    it("should respect k parameter", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "item-1", text: "First" },
        { id: "item-2", text: "Second" },
        { id: "item-3", text: "Third" },
        { id: "item-4", text: "Fourth" },
        { id: "item-5", text: "Fifth" },
      ]);

      const results = await service.search("query", 3);
      expect(results.length).toBe(3);
    });

    it("should include contextText in results", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embed({
        id: "item-1",
        text: "Short",
        contextText: "This is the full context text",
      });

      const results = await service.search("context", 1);
      expect(results[0].contextText).toBe("This is the full context text");
    });
  });

  describe("delete", () => {
    it("should delete an embedding by id", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embed({ id: "test-1", text: "Hello" });
      expect((await service.getStats()).totalEmbeddings).toBe(1);

      await service.delete("test-1");
      expect((await service.getStats()).totalEmbeddings).toBe(0);
    });

    it("should not throw when deleting non-existent id", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Should not throw
      await service.delete("non-existent");
    });
  });

  describe("getStats", () => {
    it("should return correct statistics", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "item-1", text: "First" },
        { id: "item-2", text: "Second" },
      ]);

      const stats = await service.getStats();

      expect(stats.totalEmbeddings).toBe(2);
      expect(stats.model).toBe("mock-model");
      expect(stats.dimensions).toBe(4);
    });
  });

  describe("cleanup", () => {
    it("should remove embeddings not in provided id list", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "keep-1", text: "Keep this" },
        { id: "keep-2", text: "Keep this too" },
        { id: "remove-1", text: "Remove this" },
      ]);

      expect((await service.getStats()).totalEmbeddings).toBe(3);

      const removed = await service.cleanup(["keep-1", "keep-2"]);

      expect(removed).toBe(1);
      expect((await service.getStats()).totalEmbeddings).toBe(2);
      expect(await service.getEmbedding("remove-1")).toBeNull();
    });
  });

  describe("getEmbeddedIds", () => {
    it("should return all embedded item IDs", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "item-1", text: "First" },
        { id: "item-2", text: "Second" },
        { id: "item-3", text: "Third" },
      ]);

      const ids = await service.getEmbeddedIds();

      expect(ids).toHaveLength(3);
      expect(ids).toContain("item-1");
      expect(ids).toContain("item-2");
      expect(ids).toContain("item-3");
    });
  });

  describe("chunked embeddings", () => {
    it("should split long text into multiple chunks", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Create text that exceeds chunk size (100 chars for testing)
      const longText = "A".repeat(250); // Will create 3 chunks with size 100, overlap 20

      const result = await service.embedBatch(
        [{ id: "long-item", text: longText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      expect(result.processed).toBe(1); // 1 item processed

      // Should have 3 chunks stored: long-item#0, long-item#1, long-item#2
      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(3);

      // All chunks should be searchable
      const ids = await service.getEmbeddedIds();
      expect(ids).toContain("long-item#0");
      expect(ids).toContain("long-item#1");
      expect(ids).toContain("long-item#2");
    });

    it("should not chunk short text", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const shortText = "Short text under chunk size";

      const result = await service.embedBatch(
        [{ id: "short-item", text: shortText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      expect(result.processed).toBe(1);

      // Should have 1 embedding with original ID (no suffix)
      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(1);

      const ids = await service.getEmbeddedIds();
      expect(ids).toContain("short-item");
      expect(ids).not.toContain("short-item#0");
    });

    it("should deduplicate search results by base node ID", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Create a long text that will be chunked
      const longText = "The quick brown fox jumps over the lazy dog. ".repeat(10);

      await service.embedBatch(
        [{ id: "chunked-node", text: longText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      // Search should return deduplicated results
      const results = await service.search("quick brown fox", 10);

      // Should only return ONE result for the base node ID
      const baseIds = results.map((r) => r.id.replace(/#\d+$/, ""));
      const uniqueBaseIds = [...new Set(baseIds)];
      expect(uniqueBaseIds).toHaveLength(1);
      expect(uniqueBaseIds[0]).toBe("chunked-node");
    });

    it("should update all chunks when text changes", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const originalText = "A".repeat(250);
      const updatedText = "B".repeat(250);

      // First embed
      await service.embedBatch(
        [{ id: "update-item", text: originalText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      let stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(3);

      // Update with new text (same length, so same number of chunks)
      await service.embedBatch(
        [{ id: "update-item", text: updatedText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      // Should still have 3 embeddings (updated, not added)
      stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(3);
    });

    it("should handle chunk count changes on update", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // First: long text with 3 chunks
      const longText = "A".repeat(250);
      await service.embedBatch(
        [{ id: "shrink-item", text: longText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      let stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(3);

      // Update: shorter text with only 1 chunk (or no chunking)
      const shortText = "Short now";
      await service.embedBatch(
        [{ id: "shrink-item", text: shortText }],
        { chunkSize: 100, chunkOverlap: 20 }
      );

      // Old chunks should be deleted, only 1 embedding remains
      stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(1);

      const ids = await service.getEmbeddedIds();
      expect(ids).toContain("shrink-item");
      expect(ids).not.toContain("shrink-item#0");
      expect(ids).not.toContain("shrink-item#1");
      expect(ids).not.toContain("shrink-item#2");
    });

    it("should use default chunk settings from provider maxChars", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Without explicit chunkSize, should use provider's limit
      // For this test, we use a very long text
      const veryLongText = "Word ".repeat(10000); // ~50k chars

      const result = await service.embedBatch([
        { id: "auto-chunk", text: veryLongText },
      ]);

      expect(result.processed).toBe(1);
      expect(result.errors).toBe(0);

      // Should have multiple chunks
      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBeGreaterThan(1);
    });
  });

  // ============================================
  // TC-5: Database Diagnostics (T-2.1)
  // ============================================

  describe("getDiagnostics", () => {
    it("should return diagnostics for empty database", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const diagnostics = await service.getDiagnostics();

      expect(diagnostics.totalRows).toBe(0);
      expect(diagnostics.version).toBeGreaterThanOrEqual(0);
      expect(diagnostics.index).toBeNull();
      expect(diagnostics.dbPath).toBe(TEST_DB_PATH.replace(/\.db$/, ".lance"));
    });

    it("should return row count and version after embeddings", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Add some embeddings
      await service.embedBatch([
        { id: "diag-1", text: "First diagnostic item" },
        { id: "diag-2", text: "Second diagnostic item" },
        { id: "diag-3", text: "Third diagnostic item" },
      ]);

      const diagnostics = await service.getDiagnostics();

      expect(diagnostics.totalRows).toBe(3);
      expect(diagnostics.version).toBeGreaterThanOrEqual(1);
      expect(diagnostics.dbPath).toContain("resona-test");
    });

    it("should include dbPath in diagnostics", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const diagnostics = await service.getDiagnostics();

      expect(diagnostics.dbPath).toBeDefined();
      expect(typeof diagnostics.dbPath).toBe("string");
    });

    it("should detect index after maintain() creates it", async () => {
      // T-BUG-INDEX: Regression test for index detection bug
      // maintain() creates index with createIndex("vector", ...)
      // getDiagnostics() must find it using listIndices() to get actual index name
      //
      // Requirements for IVF-PQ index:
      // - At least 256 rows (PQ training requirement)
      // - dimensions >= 16 (numSubVectors = floor(dims/16) must be > 0)
      //
      // The MockProvider has 4 dimensions, which is too small for IVF-PQ.
      // Create a provider with sufficient dimensions for testing.
      class HighDimProvider implements EmbeddingProvider {
        readonly name = "high-dim";
        readonly model = "high-dim-model";
        readonly dimensions = 64; // Enough for numSubVectors = 4
        readonly maxBatchSize = 10;
        readonly supportsAsync = false;

        async embedSingle(_text: string): Promise<Float32Array> {
          return new Float32Array(64).fill(0.1);
        }

        async embed(texts: string[]): Promise<Float32Array[]> {
          return texts.map(() => new Float32Array(64).fill(0.1));
        }
      }

      const highDimProvider = new HighDimProvider();
      service = new EmbeddingService(highDimProvider, TEST_DB_PATH);

      // Add enough data for IVF-PQ index (requires 256+ rows)
      const items = Array.from({ length: 300 }, (_, i) => ({
        id: `idx-${i}`,
        text: `Test item number ${i} with some content for indexing`,
      }));
      await service.embedBatch(items);

      // Create index via maintain()
      const maintainResult = await service.maintain();
      expect(maintainResult.indexRebuilt).toBe(true);

      // getDiagnostics should now detect the index
      const diagnostics = await service.getDiagnostics();

      // THIS IS THE BUG: index should NOT be null after successful creation
      expect(diagnostics.index).not.toBeNull();
      expect(diagnostics.index?.numIndexedRows).toBeGreaterThan(0);
      expect(diagnostics.index?.stalePercent).toBe(0);
      expect(diagnostics.index?.needsRebuild).toBe(false);
    });
  });

  // ============================================
  // T-2.2 through T-2.5: maintain() method tests
  // ============================================
  describe("maintain", () => {
    it("should return MaintenanceResult with duration", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      const result = await service.maintain();

      expect(result).toBeDefined();
      expect(typeof result.durationMs).toBe("number");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
      expect(typeof result.indexRebuilt).toBe("boolean");
    });

    it("should run compaction on database with data", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Add some data to compact
      await service.embedBatch([
        { id: "compact-1", text: "Item for compaction test one" },
        { id: "compact-2", text: "Item for compaction test two" },
        { id: "compact-3", text: "Item for compaction test three" },
      ]);

      const result = await service.maintain();

      // Compaction should run (may or may not create new files depending on state)
      expect(result.compaction).toBeDefined();
      expect(typeof result.compaction?.fragmentsRemoved).toBe("number");
      expect(typeof result.compaction?.filesCreated).toBe("number");
    });

    it("should call progress callback during maintenance", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Add data
      await service.embedBatch([
        { id: "progress-1", text: "Item for progress callback test" },
      ]);

      const progressSteps: string[] = [];
      const result = await service.maintain({
        onProgress: (step) => progressSteps.push(step),
      });

      expect(progressSteps.length).toBeGreaterThan(0);
      // Should include at least compaction step
      expect(progressSteps.some((s) => s.toLowerCase().includes("compact"))).toBe(true);
    });

    it("should skip compaction when skipCompaction is true", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "skip-1", text: "Item for skip compaction test" },
      ]);

      const result = await service.maintain({ skipCompaction: true });

      expect(result.compaction).toBeUndefined();
    });

    it("should skip index rebuild when skipIndex is true", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "skip-idx-1", text: "Item for skip index test" },
      ]);

      const result = await service.maintain({ skipIndex: true });

      // Index should not be rebuilt when skipIndex is true
      expect(result.indexRebuilt).toBe(false);
    });

    it("should skip cleanup when skipCleanup is true", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      await service.embedBatch([
        { id: "skip-clean-1", text: "Item for skip cleanup test" },
      ]);

      const result = await service.maintain({ skipCleanup: true });

      expect(result.cleanup).toBeUndefined();
    });

    it("should run cleanup and report bytes removed", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Add and modify data to create versions
      await service.embedBatch([
        { id: "cleanup-1", text: "Original text for cleanup test" },
      ]);
      await service.embedBatch([
        { id: "cleanup-1", text: "Modified text for cleanup test" },
      ], { forceAll: true });

      const result = await service.maintain({ retentionDays: 0 });

      expect(result.cleanup).toBeDefined();
      expect(typeof result.cleanup?.bytesRemoved).toBe("number");
      expect(typeof result.cleanup?.versionsRemoved).toBe("number");
    });
  });

  describe("change detection - streaming regression test", () => {
    /**
     * T-1.1: Regression test for paginated-hash-loading spec.
     *
     * This test verifies that change detection correctly identifies which items
     * need re-embedding vs which can be skipped. It MUST pass both before AND
     * after the streaming refactor to ensure behavioral equivalence.
     */
    it("should correctly skip unchanged items and re-embed changed items", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Step 1: Create 100 items and embed them
      const items: ItemToEmbed[] = Array.from({ length: 100 }, (_, i) => ({
        id: `regression-${i}`,
        text: `Original text for item ${i} - this is unique content`,
      }));

      const firstResult = await service.embedBatch(items);
      expect(firstResult.processed).toBe(100);
      expect(firstResult.skipped).toBe(0);

      // Step 2: Modify 20 items (indices 10-29)
      const modifiedItems: ItemToEmbed[] = items.map((item, i) => ({
        id: item.id,
        text: i >= 10 && i < 30
          ? `Modified text for item ${i} - this is NEW content`
          : item.text,
      }));

      // Step 3: Re-embed all 100 items
      const secondResult = await service.embedBatch(modifiedItems);

      // Step 4: Verify: exactly 20 processed (changed), 80 skipped (unchanged)
      expect(secondResult.processed).toBe(20);
      expect(secondResult.skipped).toBe(80);

      // Step 5: Verify total count is still 100 (no duplicates)
      const stats = await service.getStats();
      expect(stats.totalEmbeddings).toBe(100);
    });

    it("should handle large batch with mixed changes", async () => {
      service = new EmbeddingService(provider, TEST_DB_PATH);

      // Create 500 items
      const items: ItemToEmbed[] = Array.from({ length: 500 }, (_, i) => ({
        id: `large-batch-${i}`,
        text: `Content for large batch item ${i} with some padding text`,
      }));

      await service.embedBatch(items);

      // Modify every 5th item (100 items total)
      const mixedItems: ItemToEmbed[] = items.map((item, i) => ({
        id: item.id,
        text: i % 5 === 0
          ? `UPDATED: ${item.text}`
          : item.text,
      }));

      const result = await service.embedBatch(mixedItems);

      expect(result.processed).toBe(100);  // Every 5th = 100 items
      expect(result.skipped).toBe(400);    // Remaining 400
    });
  });
});
