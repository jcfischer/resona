/**
 * OpenAI Provider Tests
 * TDD: RED phase - tests written first
 */

import { describe, it, expect, beforeAll, mock } from "bun:test";
import { OpenAIProvider } from "../../src/providers/openai";
import type { EmbeddingProvider } from "../../src/types";

describe("OpenAIProvider", () => {
  describe("construction", () => {
    it("should create provider with default model", () => {
      const provider = new OpenAIProvider("test-api-key");
      expect(provider.name).toBe("openai");
      expect(provider.model).toBe("text-embedding-3-small");
      expect(provider.dimensions).toBe(1536);
    });

    it("should allow specifying model", () => {
      const provider = new OpenAIProvider("test-key", "text-embedding-3-large");
      expect(provider.model).toBe("text-embedding-3-large");
      expect(provider.dimensions).toBe(3072);
    });

    it("should allow custom dimensions for known models", () => {
      // text-embedding-3-large supports dimension reduction
      const provider = new OpenAIProvider("test-key", "text-embedding-3-large", {
        dimensions: 1024,
      });
      expect(provider.dimensions).toBe(1024);
    });

    it("should throw if unknown model without dimensions", () => {
      expect(() => new OpenAIProvider("test-key", "unknown-model")).toThrow(
        /Unknown model/
      );
    });

    it("should implement EmbeddingProvider interface", () => {
      const provider = new OpenAIProvider("test-key");
      expect(provider.name).toBeDefined();
      expect(provider.model).toBeDefined();
      expect(provider.dimensions).toBeGreaterThan(0);
      expect(provider.maxBatchSize).toBeGreaterThan(0);
      expect(typeof provider.supportsAsync).toBe("boolean");
      expect(typeof provider.embed).toBe("function");
      expect(typeof provider.embedSingle).toBe("function");
    });
  });

  describe("embedding generation (mocked)", () => {
    // These tests use mocked fetch to avoid actual API calls
    const mockEmbedding = new Array(1536).fill(0.1);

    it("should embed single text", async () => {
      // Mock fetch for OpenAI API
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("text-embedding-3-small");
        expect(body.input).toEqual(["test text"]); // Always sent as array

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 2, total_tokens: 2 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key");
        const result = await provider.embedSingle("test text");

        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(1536);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should embed batch of texts", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.input).toEqual(["text 1", "text 2", "text 3"]);

        return new Response(
          JSON.stringify({
            object: "list",
            data: [
              { object: "embedding", embedding: mockEmbedding, index: 0 },
              { object: "embedding", embedding: mockEmbedding, index: 1 },
              { object: "embedding", embedding: mockEmbedding, index: 2 },
            ],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 6, total_tokens: 6 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key");
        const results = await provider.embed(["text 1", "text 2", "text 3"]);

        expect(results.length).toBe(3);
        results.forEach((result) => {
          expect(result).toBeInstanceOf(Float32Array);
          expect(result.length).toBe(1536);
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should handle empty batch", async () => {
      const provider = new OpenAIProvider("test-key");
      const results = await provider.embed([]);
      expect(results).toEqual([]);
    });

    it("should include custom dimensions in request", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.dimensions).toBe(1024);

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: new Array(1024).fill(0.1), index: 0 }],
            model: "text-embedding-3-large",
            usage: { prompt_tokens: 2, total_tokens: 2 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key", "text-embedding-3-large", {
          dimensions: 1024,
        });
        const result = await provider.embedSingle("test");
        expect(result.length).toBe(1024);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on API error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid API key", type: "invalid_request_error" },
          }),
          { status: 401 }
        );
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("bad-key");
        await expect(provider.embedSingle("test")).rejects.toThrow(/401/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should use custom endpoint", async () => {
      const originalFetch = globalThis.fetch;
      let calledUrl = "";
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        calledUrl = url;
        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
            model: "text-embedding-3-small",
            usage: { prompt_tokens: 2, total_tokens: 2 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key", "text-embedding-3-small", {
          endpoint: "https://custom.openai.azure.com/v1",
        });
        await provider.embedSingle("test");
        expect(calledUrl).toContain("custom.openai.azure.com");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("healthCheck", () => {
    it("should return true when API is accessible (mocked)", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({ models: [] }));
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key");
        const healthy = await provider.healthCheck?.();
        expect(healthy).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should return false when API is not accessible", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        throw new Error("Network error");
      }) as typeof fetch;

      try {
        const provider = new OpenAIProvider("test-key");
        const healthy = await provider.healthCheck?.();
        expect(healthy).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
