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
});
