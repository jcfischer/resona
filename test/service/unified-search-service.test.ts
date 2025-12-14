/**
 * UnifiedSearchService Tests
 *
 * TDD: Tests written first, implementation follows.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { UnifiedSearchService } from "../../src/service/unified-search-service";
import type { SearchSource, SearchResult, SourceId } from "../../src/types";

// Mock search source for testing
class MockSearchSource implements SearchSource {
  readonly sourceId: SourceId;
  readonly description?: string;
  private items: Map<string, { text: string; similarity: number }> = new Map();

  constructor(sourceId: SourceId, description?: string) {
    this.sourceId = sourceId;
    this.description = description;
  }

  addItem(id: string, text: string, relevance: number): void {
    this.items.set(id, { text, similarity: relevance });
  }

  async search(query: string, k: number): Promise<SearchResult[]> {
    // Return items sorted by relevance, limited to k
    const results = Array.from(this.items.entries())
      .sort((a, b) => b[1].similarity - a[1].similarity)
      .slice(0, k)
      .map(([id, data]) => ({
        id,
        distance: 1 - data.similarity,
        similarity: data.similarity,
        contextText: data.text,
      }));
    return results;
  }

  async getItem(
    id: string
  ): Promise<{ preview: string; url?: string } | null> {
    const item = this.items.get(id);
    if (!item) return null;
    return { preview: item.text, url: `https://example.com/${id}` };
  }
}

describe("UnifiedSearchService", () => {
  let unifiedSearch: UnifiedSearchService;

  beforeEach(() => {
    unifiedSearch = new UnifiedSearchService();
  });

  describe("registerSource", () => {
    it("should register a search source", () => {
      const source = new MockSearchSource("tana/main", "Tana main workspace");

      unifiedSearch.registerSource(source);

      const sources = unifiedSearch.listSources();
      expect(sources).toHaveLength(1);
      expect(sources[0].sourceId).toBe("tana/main");
    });

    it("should register multiple sources", () => {
      const tana = new MockSearchSource("tana/main");
      const email = new MockSearchSource("email/work");

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const sources = unifiedSearch.listSources();
      expect(sources).toHaveLength(2);
    });

    it("should replace source with same ID", () => {
      const source1 = new MockSearchSource("tana/main", "Old description");
      const source2 = new MockSearchSource("tana/main", "New description");

      unifiedSearch.registerSource(source1);
      unifiedSearch.registerSource(source2);

      const sources = unifiedSearch.listSources();
      expect(sources).toHaveLength(1);
      expect(sources[0].description).toBe("New description");
    });
  });

  describe("unregisterSource", () => {
    it("should unregister a source", () => {
      const source = new MockSearchSource("tana/main");
      unifiedSearch.registerSource(source);

      unifiedSearch.unregisterSource("tana/main");

      expect(unifiedSearch.listSources()).toHaveLength(0);
    });

    it("should not throw when unregistering non-existent source", () => {
      expect(() => unifiedSearch.unregisterSource("non-existent")).not.toThrow();
    });
  });

  describe("search", () => {
    it("should search across all registered sources", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node1", "Meeting notes about AI", 0.9);
      tana.addItem("node2", "Project planning", 0.5);

      const email = new MockSearchSource("email/work");
      email.addItem("email1", "AI research paper attached", 0.85);
      email.addItem("email2", "Lunch plans", 0.3);

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const results = await unifiedSearch.search("AI", 10);

      expect(results.length).toBeGreaterThan(0);
      // Should have results from both sources
      const sources = new Set(results.map((r) => r.source));
      expect(sources.has("tana/main")).toBe(true);
      expect(sources.has("email/work")).toBe(true);
    });

    it("should return results sorted by similarity (descending)", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node1", "Low relevance", 0.3);

      const email = new MockSearchSource("email/work");
      email.addItem("email1", "High relevance", 0.95);

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const results = await unifiedSearch.search("query", 10);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].similarity).toBeGreaterThanOrEqual(
          results[i].similarity
        );
      }
    });

    it("should respect k parameter across all sources", async () => {
      const tana = new MockSearchSource("tana/main");
      for (let i = 0; i < 5; i++) {
        tana.addItem(`node${i}`, `Tana item ${i}`, 0.5 + i * 0.1);
      }

      const email = new MockSearchSource("email/work");
      for (let i = 0; i < 5; i++) {
        email.addItem(`email${i}`, `Email item ${i}`, 0.5 + i * 0.1);
      }

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const results = await unifiedSearch.search("query", 3);
      expect(results).toHaveLength(3);
    });

    it("should filter by source type pattern", async () => {
      const tanaMain = new MockSearchSource("tana/main");
      tanaMain.addItem("node1", "Tana main item", 0.9);

      const tanaBooks = new MockSearchSource("tana/books");
      tanaBooks.addItem("book1", "Tana books item", 0.8);

      const email = new MockSearchSource("email/work");
      email.addItem("email1", "Email item", 0.85);

      unifiedSearch.registerSource(tanaMain);
      unifiedSearch.registerSource(tanaBooks);
      unifiedSearch.registerSource(email);

      // Filter to only tana sources
      const results = await unifiedSearch.search("item", 10, {
        sourceTypes: ["tana"],
      });

      expect(results.length).toBe(2);
      results.forEach((r) => {
        expect(r.source.startsWith("tana/")).toBe(true);
      });
    });

    it("should filter by specific source IDs", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node1", "Tana item", 0.9);

      const email = new MockSearchSource("email/work");
      email.addItem("email1", "Email item", 0.85);

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const results = await unifiedSearch.search("item", 10, {
        sources: ["tana/main"],
      });

      expect(results.length).toBe(1);
      expect(results[0].source).toBe("tana/main");
    });

    it("should include preview in results", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node1", "This is the preview text", 0.9);

      unifiedSearch.registerSource(tana);

      const results = await unifiedSearch.search("preview", 10);

      expect(results[0].preview).toBe("This is the preview text");
    });

    it("should include source and id for routing", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node123", "Some content", 0.9);

      unifiedSearch.registerSource(tana);

      const results = await unifiedSearch.search("content", 10);

      expect(results[0]).toMatchObject({
        source: "tana/main",
        id: "node123",
      });
    });

    it("should handle empty results gracefully", async () => {
      const tana = new MockSearchSource("tana/main");
      // No items added

      unifiedSearch.registerSource(tana);

      const results = await unifiedSearch.search("query", 10);
      expect(results).toEqual([]);
    });

    it("should handle search with no registered sources", async () => {
      const results = await unifiedSearch.search("query", 10);
      expect(results).toEqual([]);
    });
  });

  describe("listSources", () => {
    it("should return list of registered sources with metadata", () => {
      const tana = new MockSearchSource("tana/main", "Main Tana workspace");
      const email = new MockSearchSource("email/work", "Work email");

      unifiedSearch.registerSource(tana);
      unifiedSearch.registerSource(email);

      const sources = unifiedSearch.listSources();

      expect(sources).toEqual([
        { sourceId: "tana/main", description: "Main Tana workspace" },
        { sourceId: "email/work", description: "Work email" },
      ]);
    });
  });

  describe("getItem", () => {
    it("should fetch item details from the correct source", async () => {
      const tana = new MockSearchSource("tana/main");
      tana.addItem("node123", "Node content", 0.9);

      unifiedSearch.registerSource(tana);

      const item = await unifiedSearch.getItem("tana/main", "node123");

      expect(item).toEqual({
        preview: "Node content",
        url: "https://example.com/node123",
      });
    });

    it("should return null for unknown source", async () => {
      const item = await unifiedSearch.getItem("unknown/source", "id");
      expect(item).toBeNull();
    });

    it("should return null for unknown item", async () => {
      const tana = new MockSearchSource("tana/main");
      unifiedSearch.registerSource(tana);

      const item = await unifiedSearch.getItem("tana/main", "nonexistent");
      expect(item).toBeNull();
    });
  });
});
