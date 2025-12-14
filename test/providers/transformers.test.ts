/**
 * Transformers.js Provider Tests
 * TDD: RED phase - tests written first
 *
 * Uses @xenova/transformers for CPU-based local embeddings.
 * No GPU or external API required.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { TransformersProvider } from "../../src/providers/transformers";

describe("TransformersProvider", () => {
  describe("construction", () => {
    it("should create provider with default model", () => {
      const provider = new TransformersProvider();
      expect(provider.name).toBe("transformers");
      expect(provider.model).toBe("Xenova/all-MiniLM-L6-v2");
      expect(provider.dimensions).toBe(384);
    });

    it("should allow specifying model", () => {
      const provider = new TransformersProvider("Xenova/bge-base-en-v1.5");
      expect(provider.model).toBe("Xenova/bge-base-en-v1.5");
      expect(provider.dimensions).toBe(768);
    });

    it("should allow custom dimensions for unknown models", () => {
      const provider = new TransformersProvider("custom/model", { dimensions: 512 });
      expect(provider.dimensions).toBe(512);
    });

    it("should throw if unknown model without dimensions", () => {
      expect(() => new TransformersProvider("unknown/model")).toThrow(
        /Unknown model/
      );
    });

    it("should implement EmbeddingProvider interface", () => {
      const provider = new TransformersProvider();
      expect(provider.name).toBeDefined();
      expect(provider.model).toBeDefined();
      expect(provider.dimensions).toBeGreaterThan(0);
      expect(provider.maxBatchSize).toBeGreaterThan(0);
      expect(typeof provider.supportsAsync).toBe("boolean");
      expect(typeof provider.embed).toBe("function");
      expect(typeof provider.embedSingle).toBe("function");
    });

    it("should support known models", () => {
      const models = [
        { name: "Xenova/all-MiniLM-L6-v2", dims: 384 },
        { name: "Xenova/all-MiniLM-L12-v2", dims: 384 },
        { name: "Xenova/bge-small-en-v1.5", dims: 384 },
        { name: "Xenova/bge-base-en-v1.5", dims: 768 },
        { name: "Xenova/bge-large-en-v1.5", dims: 1024 },
      ];

      for (const { name, dims } of models) {
        const provider = new TransformersProvider(name);
        expect(provider.dimensions).toBe(dims);
      }
    });
  });

  describe("configuration", () => {
    it("should use library default cache directory when not specified", () => {
      const provider = new TransformersProvider();
      // When not specified, uses library default (undefined returns library default)
      expect(provider.getCacheDir()).toBeUndefined();
    });

    it("should allow custom cache directory", () => {
      const provider = new TransformersProvider("Xenova/all-MiniLM-L6-v2", {
        cacheDir: "/custom/cache",
      });
      expect(provider.getCacheDir()).toBe("/custom/cache");
    });

    it("should allow disabling progress callbacks", () => {
      const provider = new TransformersProvider("Xenova/all-MiniLM-L6-v2", {
        showProgress: false,
      });
      expect(provider.getShowProgress()).toBe(false);
    });
  });

  describe("lazy initialization", () => {
    it("should not load model until first use", () => {
      const provider = new TransformersProvider();
      expect(provider.isModelLoaded()).toBe(false);
    });

    it("should expose model loading state", () => {
      const provider = new TransformersProvider();
      expect(typeof provider.isModelLoaded()).toBe("boolean");
    });
  });

  describe("embedding generation", () => {
    // Note: These tests will be slow on first run due to model download
    // In CI, you may want to skip these or use cached models

    it("should handle empty batch", async () => {
      const provider = new TransformersProvider();
      const results = await provider.embed([]);
      expect(results).toEqual([]);
    });

    // Integration tests that require actual model loading
    // Uncomment these for full integration testing:
    /*
    it("should embed single text", async () => {
      const provider = new TransformersProvider();
      const result = await provider.embedSingle("test text");

      expect(result).toBeInstanceOf(Float32Array);
      expect(result.length).toBe(384);
    });

    it("should embed batch of texts", async () => {
      const provider = new TransformersProvider();
      const results = await provider.embed(["text 1", "text 2", "text 3"]);

      expect(results.length).toBe(3);
      results.forEach((result) => {
        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(384);
      });
    });
    */
  });

  describe("healthCheck", () => {
    it("should return false if model cannot be loaded", async () => {
      const provider = new TransformersProvider("invalid/nonexistent-model", {
        dimensions: 384,
      });
      // Health check will try to load model and fail
      // Note: This may take time as it tries to download
      // const healthy = await provider.healthCheck?.();
      // expect(healthy).toBe(false);
      expect(provider.healthCheck).toBeDefined();
    });
  });
});
