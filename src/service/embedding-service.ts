/**
 * EmbeddingService
 *
 * Core service for managing embeddings with sqlite-vec.
 * Handles embedding generation, storage, and similarity search.
 */

import { Database } from "bun:sqlite";
import { createVecDatabase } from "../sqlite-vec-loader";
import type {
  EmbeddingProvider,
  ItemToEmbed,
  StoredEmbedding,
  SearchResult,
  BatchEmbedOptions,
  BatchEmbedResult,
  EmbeddingStats,
} from "../types";

/**
 * Compute SHA256 hash of text for change detection
 */
function hashText(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Convert Float32Array to Buffer for storage
 */
function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Convert Buffer back to Float32Array
 */
function bufferToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * EmbeddingService - manages embeddings with sqlite-vec
 */
export class EmbeddingService {
  readonly provider: EmbeddingProvider;
  private db: Database;
  private dbPath: string;

  /**
   * Create an EmbeddingService
   *
   * @param provider - The embedding provider to use
   * @param dbPath - Path to SQLite database file
   */
  constructor(provider: EmbeddingProvider, dbPath: string) {
    this.provider = provider;
    this.dbPath = dbPath;

    // Open database with sqlite-vec loaded
    this.db = createVecDatabase(dbPath);

    this.initSchema();
  }

  /**
   * Initialize database schema
   */
  private initSchema(): void {
    // Main embeddings metadata table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS embeddings (
        id TEXT PRIMARY KEY,
        text_hash TEXT NOT NULL,
        context_text TEXT NOT NULL,
        model TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        metadata TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Create index on text_hash for fast change detection
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_embeddings_hash ON embeddings(text_hash)
    `);

    // Virtual table for vector storage and search
    // Using vec0 extension from sqlite-vec
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${this.provider.dimensions}]
      )
    `);
  }

  /**
   * Embed a single item
   *
   * @param item - Item to embed
   * @returns Whether a new embedding was created (false if skipped)
   */
  async embed(item: ItemToEmbed): Promise<boolean> {
    const textToEmbed = item.contextText || item.text;
    const textHash = hashText(textToEmbed);

    // Check if unchanged
    const existing = this.db
      .query<{ text_hash: string }, [string]>(
        "SELECT text_hash FROM embeddings WHERE id = ?"
      )
      .get(item.id);

    if (existing && existing.text_hash === textHash) {
      return false; // Skip - unchanged
    }

    // Generate embedding
    const embedding = await this.provider.embedSingle(textToEmbed);

    // Store in database
    this.storeEmbedding(item.id, embedding, textHash, textToEmbed, item.metadata);

    return true;
  }

  /**
   * Embed multiple items with progress tracking
   *
   * @param items - Items to embed
   * @param options - Batch options (progress callback, etc.)
   * @returns Batch result statistics
   */
  async embedBatch(
    items: ItemToEmbed[],
    options: BatchEmbedOptions = {}
  ): Promise<BatchEmbedResult> {
    const { onProgress, progressInterval = 100, forceAll = false } = options;

    const result: BatchEmbedResult = {
      processed: 0,
      skipped: 0,
      errors: 0,
      errorSamples: [],
    };

    // Build hash map for change detection
    const hashMap = new Map<string, string>();
    if (!forceAll) {
      const existingHashes = this.db
        .query<{ id: string; text_hash: string }, []>(
          "SELECT id, text_hash FROM embeddings"
        )
        .all();
      for (const row of existingHashes) {
        hashMap.set(row.id, row.text_hash);
      }
    }

    // Filter items that need embedding
    const itemsToEmbed: ItemToEmbed[] = [];
    const itemHashes: string[] = [];

    for (const item of items) {
      const textToEmbed = item.contextText || item.text;
      const textHash = hashText(textToEmbed);

      if (forceAll || hashMap.get(item.id) !== textHash) {
        itemsToEmbed.push(item);
        itemHashes.push(textHash);
      } else {
        result.skipped++;
      }
    }

    // Process in batches
    const batchSize = this.provider.maxBatchSize;
    for (let i = 0; i < itemsToEmbed.length; i += batchSize) {
      const batchItems = itemsToEmbed.slice(i, i + batchSize);
      const batchHashes = itemHashes.slice(i, i + batchSize);
      const texts = batchItems.map((item) => item.contextText || item.text);

      try {
        const embeddings = await this.provider.embed(texts);

        for (let j = 0; j < batchItems.length; j++) {
          const item = batchItems[j];
          const embedding = embeddings[j];
          const textHash = batchHashes[j];
          const textToEmbed = item.contextText || item.text;

          try {
            this.storeEmbedding(
              item.id,
              embedding,
              textHash,
              textToEmbed,
              item.metadata
            );
            result.processed++;
          } catch (error) {
            result.errors++;
            if (result.errorSamples!.length < 5) {
              result.errorSamples!.push(
                `${item.id}: ${error instanceof Error ? error.message : String(error)}`
              );
            }
          }
        }
      } catch (error) {
        // Batch failed - count all as errors
        result.errors += batchItems.length;
        if (result.errorSamples!.length < 5) {
          result.errorSamples!.push(
            `Batch error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Report progress
      if (onProgress && (i + batchSize) % progressInterval === 0) {
        onProgress({
          processed: result.processed,
          skipped: result.skipped,
          errors: result.errors,
          total: items.length,
          currentItem:
            batchItems[batchItems.length - 1]?.text.substring(0, 50),
        });
      }
    }

    // Final progress report
    if (onProgress) {
      onProgress({
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        total: items.length,
      });
    }

    return result;
  }

  /**
   * Store an embedding in the database
   */
  private storeEmbedding(
    id: string,
    embedding: Float32Array,
    textHash: string,
    contextText: string,
    metadata?: Record<string, unknown>
  ): void {
    const now = Date.now();
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    const embeddingBuffer = float32ToBuffer(embedding);

    // Upsert metadata
    this.db.run(
      `
      INSERT INTO embeddings (id, text_hash, context_text, model, dimensions, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        text_hash = excluded.text_hash,
        context_text = excluded.context_text,
        model = excluded.model,
        dimensions = excluded.dimensions,
        metadata = excluded.metadata,
        updated_at = excluded.updated_at
      `,
      [
        id,
        textHash,
        contextText,
        this.provider.model,
        this.provider.dimensions,
        metadataJson,
        now,
        now,
      ]
    );

    // Upsert vector
    this.db.run(`DELETE FROM vec_embeddings WHERE id = ?`, [id]);
    this.db.run(`INSERT INTO vec_embeddings (id, embedding) VALUES (?, ?)`, [
      id,
      embeddingBuffer,
    ]);
  }

  /**
   * Search for similar items
   *
   * @param query - Query text to search for
   * @param k - Number of results to return
   * @returns Search results sorted by similarity (descending)
   */
  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    // Generate query embedding
    const queryEmbedding = await this.provider.embedSingle(query);
    const queryBuffer = float32ToBuffer(queryEmbedding);

    // Search using sqlite-vec
    const vecResults = this.db
      .query<{ id: string; distance: number }, [Buffer, number]>(
        `
        SELECT id, distance
        FROM vec_embeddings
        WHERE embedding MATCH ?
        ORDER BY distance
        LIMIT ?
        `
      )
      .all(queryBuffer, k);

    // Fetch metadata for results
    const results: SearchResult[] = [];
    for (const row of vecResults) {
      const meta = this.db
        .query<{ context_text: string; metadata: string | null }, [string]>(
          "SELECT context_text, metadata FROM embeddings WHERE id = ?"
        )
        .get(row.id);

      results.push({
        id: row.id,
        distance: row.distance,
        similarity: 1 - row.distance, // Convert distance to similarity
        contextText: meta?.context_text,
        metadata: meta?.metadata ? JSON.parse(meta.metadata) : undefined,
      });
    }

    return results;
  }

  /**
   * Get a stored embedding by ID
   *
   * @param id - Item ID
   * @returns Stored embedding or null if not found
   */
  getEmbedding(id: string): StoredEmbedding | null {
    const row = this.db
      .query<
        {
          id: string;
          text_hash: string;
          context_text: string;
          model: string;
          dimensions: number;
          metadata: string | null;
          created_at: number;
          updated_at: number;
        },
        [string]
      >("SELECT * FROM embeddings WHERE id = ?")
      .get(id);

    if (!row) {
      return null;
    }

    // Get the embedding vector
    const vecRow = this.db
      .query<{ embedding: Buffer }, [string]>(
        "SELECT embedding FROM vec_embeddings WHERE id = ?"
      )
      .get(id);

    return {
      id: row.id,
      embedding: vecRow ? bufferToFloat32(vecRow.embedding) : new Float32Array(0),
      textHash: row.text_hash,
      contextText: row.context_text,
      model: row.model,
      dimensions: row.dimensions,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Delete an embedding by ID
   *
   * @param id - Item ID to delete
   */
  delete(id: string): void {
    this.db.run("DELETE FROM embeddings WHERE id = ?", [id]);
    this.db.run("DELETE FROM vec_embeddings WHERE id = ?", [id]);
  }

  /**
   * Remove embeddings not in the provided ID list
   *
   * @param keepIds - List of IDs to keep
   * @returns Number of embeddings removed
   */
  cleanup(keepIds: string[]): number {
    // Get all current IDs
    const currentIds = this.db
      .query<{ id: string }, []>("SELECT id FROM embeddings")
      .all()
      .map((r) => r.id);

    const keepSet = new Set(keepIds);
    const toRemove = currentIds.filter((id) => !keepSet.has(id));

    for (const id of toRemove) {
      this.delete(id);
    }

    return toRemove.length;
  }

  /**
   * Get statistics about stored embeddings
   *
   * @returns Embedding statistics
   */
  getStats(): EmbeddingStats {
    const count = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) as count FROM embeddings")
      .get();

    const timestamps = this.db
      .query<{ oldest: number | null; newest: number | null }, []>(
        "SELECT MIN(created_at) as oldest, MAX(updated_at) as newest FROM embeddings"
      )
      .get();

    return {
      totalEmbeddings: count?.count || 0,
      model: this.provider.model,
      dimensions: this.provider.dimensions,
      oldestEmbedding: timestamps?.oldest
        ? new Date(timestamps.oldest)
        : undefined,
      newestEmbedding: timestamps?.newest
        ? new Date(timestamps.newest)
        : undefined,
    };
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }
}
