/**
 * Voyage AI Provider Tests
 * TDD: RED phase - tests written first
 */

import { describe, it, expect, mock } from "bun:test";
import { VoyageProvider } from "../../src/providers/voyage";

describe("VoyageProvider", () => {
  describe("construction", () => {
    it("should create provider with default model", () => {
      const provider = new VoyageProvider("test-api-key");
      expect(provider.name).toBe("voyage");
      expect(provider.model).toBe("voyage-3");
      expect(provider.dimensions).toBe(1024);
    });

    it("should allow specifying model", () => {
      const provider = new VoyageProvider("test-key", "voyage-3-large");
      expect(provider.model).toBe("voyage-3-large");
      expect(provider.dimensions).toBe(1024);
    });

    it("should use voyage-3-lite dimensions", () => {
      const provider = new VoyageProvider("test-key", "voyage-3-lite");
      expect(provider.dimensions).toBe(512);
    });

    it("should throw if unknown model without dimensions", () => {
      expect(() => new VoyageProvider("test-key", "unknown-model")).toThrow(
        /Unknown model/
      );
    });

    it("should allow custom dimensions", () => {
      const provider = new VoyageProvider("test-key", "voyage-3", {
        dimensions: 512,
      });
      expect(provider.dimensions).toBe(512);
    });

    it("should implement EmbeddingProvider interface", () => {
      const provider = new VoyageProvider("test-key");
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
    const mockEmbedding = new Array(1024).fill(0.1);

    it("should embed single text", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.model).toBe("voyage-3");
        expect(body.input).toEqual(["test text"]);

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
            model: "voyage-3",
            usage: { total_tokens: 2 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("test-key");
        const result = await provider.embedSingle("test text");

        expect(result).toBeInstanceOf(Float32Array);
        expect(result.length).toBe(1024);
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
            model: "voyage-3",
            usage: { total_tokens: 6 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("test-key");
        const results = await provider.embed(["text 1", "text 2", "text 3"]);

        expect(results.length).toBe(3);
        results.forEach((result) => {
          expect(result).toBeInstanceOf(Float32Array);
          expect(result.length).toBe(1024);
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should handle empty batch", async () => {
      const provider = new VoyageProvider("test-key");
      const results = await provider.embed([]);
      expect(results).toEqual([]);
    });

    it("should support input_type for queries", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.input_type).toBe("query");

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
            model: "voyage-3",
            usage: { total_tokens: 2 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("test-key", "voyage-3", {
          inputType: "query",
        });
        await provider.embedSingle("search query");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should support input_type for documents", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async (url: string, options: RequestInit) => {
        const body = JSON.parse(options.body as string);
        expect(body.input_type).toBe("document");

        return new Response(
          JSON.stringify({
            object: "list",
            data: [{ object: "embedding", embedding: mockEmbedding, index: 0 }],
            model: "voyage-3",
            usage: { total_tokens: 10 },
          })
        );
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("test-key", "voyage-3", {
          inputType: "document",
        });
        await provider.embedSingle("document content");
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it("should throw on API error", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(
          JSON.stringify({
            error: { message: "Invalid API key" },
          }),
          { status: 401 }
        );
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("bad-key");
        await expect(provider.embedSingle("test")).rejects.toThrow(/401/);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe("healthCheck", () => {
    it("should return true when API is accessible (mocked)", async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = mock(async () => {
        return new Response(JSON.stringify({}));
      }) as typeof fetch;

      try {
        const provider = new VoyageProvider("test-key");
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
        const provider = new VoyageProvider("test-key");
        const healthy = await provider.healthCheck?.();
        expect(healthy).toBe(false);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
