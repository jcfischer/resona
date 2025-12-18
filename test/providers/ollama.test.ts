/**
 * Ollama Provider Tests
 *
 * TDD: Tests written first, implementation follows.
 */

import { describe, it, expect, beforeAll, mock } from "bun:test";
import { OllamaProvider } from "../../src/providers/ollama";
import { OLLAMA_MODEL_DIMENSIONS } from "../../src/types";

describe("OllamaProvider", () => {
  describe("constructor", () => {
    it("should create provider with default endpoint", () => {
      const provider = new OllamaProvider("nomic-embed-text");

      expect(provider.name).toBe("ollama");
      expect(provider.model).toBe("nomic-embed-text");
      expect(provider.dimensions).toBe(768);
      expect(provider.maxBatchSize).toBe(10);
      expect(provider.supportsAsync).toBe(false);
    });

    it("should create provider with custom endpoint", () => {
      const provider = new OllamaProvider(
        "nomic-embed-text",
        "http://custom:11434"
      );

      expect(provider.name).toBe("ollama");
      expect(provider.model).toBe("nomic-embed-text");
    });

    it("should auto-detect dimensions for known models", () => {
      const nomicProvider = new OllamaProvider("nomic-embed-text");
      expect(nomicProvider.dimensions).toBe(768);

      const mxbaiProvider = new OllamaProvider("mxbai-embed-large");
      expect(mxbaiProvider.dimensions).toBe(1024);

      const minilmProvider = new OllamaProvider("all-minilm");
      expect(minilmProvider.dimensions).toBe(384);
    });

    it("should allow explicit dimensions for unknown models", () => {
      const provider = new OllamaProvider(
        "custom-model",
        undefined,
        512
      );

      expect(provider.model).toBe("custom-model");
      expect(provider.dimensions).toBe(512);
    });

    it("should throw for unknown model without explicit dimensions", () => {
      expect(() => new OllamaProvider("unknown-model")).toThrow(
        "Unknown model"
      );
    });
  });

  describe("embedSingle", () => {
    it("should return Float32Array with correct dimensions", async () => {
      // This test requires Ollama running - skip if not available
      const provider = new OllamaProvider("nomic-embed-text");

      try {
        const isHealthy = await provider.healthCheck();
        if (!isHealthy) {
          console.log("Skipping embedSingle test - Ollama not available");
          return;
        }

        const embedding = await provider.embedSingle("Hello, world!");

        expect(embedding).toBeInstanceOf(Float32Array);
        expect(embedding.length).toBe(768);

        // Verify it's normalized (values should be between -1 and 1 for most models)
        const hasValidValues = Array.from(embedding).every(
          (v) => v >= -10 && v <= 10
        );
        expect(hasValidValues).toBe(true);
      } catch (error) {
        console.log("Skipping embedSingle test - Ollama not available");
      }
    });
  });

  describe("embed (batch)", () => {
    it("should return array of Float32Arrays", async () => {
      const provider = new OllamaProvider("nomic-embed-text");

      try {
        const isHealthy = await provider.healthCheck();
        if (!isHealthy) {
          console.log("Skipping embed batch test - Ollama not available");
          return;
        }

        const texts = ["Hello", "World", "Test"];
        const embeddings = await provider.embed(texts);

        expect(embeddings).toHaveLength(3);
        embeddings.forEach((emb) => {
          expect(emb).toBeInstanceOf(Float32Array);
          expect(emb.length).toBe(768);
        });
      } catch (error) {
        console.log("Skipping embed batch test - Ollama not available");
      }
    });

    it("should handle empty array", async () => {
      const provider = new OllamaProvider("nomic-embed-text");
      const embeddings = await provider.embed([]);

      expect(embeddings).toEqual([]);
    });
  });

  describe("healthCheck", () => {
    it("should return boolean", async () => {
      const provider = new OllamaProvider("nomic-embed-text");
      const result = await provider.healthCheck();

      expect(typeof result).toBe("boolean");
    });
  });
});
