/**
 * EmbeddingService
 *
 * Core service for managing embeddings with LanceDB.
 * Handles embedding generation, storage, and similarity search.
 */

import * as lancedb from "@lancedb/lancedb";
import type { Table } from "@lancedb/lancedb";
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
 * Schema for LanceDB embeddings table
 */
interface EmbeddingRecord {
  id: string;
  text_hash: string;
  context_text: string;
  model: string;
  dimensions: number;
  metadata: string; // Empty string when no metadata (LanceDB needs non-null for schema inference)
  created_at: number;
  updated_at: number;
  vector: number[];
}

/**
 * Compute SHA256 hash of text for change detection
 */
function hashText(text: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * EmbeddingService - manages embeddings with LanceDB
 */
export class EmbeddingService {
  readonly provider: EmbeddingProvider;
  private db: lancedb.Connection | null = null;
  private table: Table | null = null;
  private dbPath: string;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  /**
   * Create an EmbeddingService
   *
   * @param provider - The embedding provider to use
   * @param dbPath - Path to LanceDB database directory
   */
  constructor(provider: EmbeddingProvider, dbPath: string) {
    this.provider = provider;
    // Convert .db extension to .lance for LanceDB
    this.dbPath = dbPath.replace(/\.db$/, ".lance");
  }

  /**
   * Initialize the database connection and table
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;

    if (this.initPromise) {
      await this.initPromise;
      return;
    }

    this.initPromise = this.initialize();
    await this.initPromise;
  }

  private async initialize(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);

    // Check if table exists
    const tables = await this.db.tableNames();
    if (tables.includes("embeddings")) {
      this.table = await this.db.openTable("embeddings");
      // Ensure scalar index exists on id column for fast deletes
      await this.ensureIdIndex();
    }
    // Table will be created on first insert with correct schema

    this.initialized = true;
  }

  /**
   * Ensure scalar index exists on id column
   * This dramatically speeds up delete operations
   */
  private async ensureIdIndex(): Promise<void> {
    if (!this.table) return;

    try {
      // Check if index already exists by listing indices
      const indices = await this.table.listIndices();
      const hasIdIndex = indices.some((idx: { columns: string[] }) =>
        idx.columns.includes("id")
      );

      if (!hasIdIndex) {
        await this.table.createIndex("id");
      }
    } catch {
      // Index creation might fail if already exists or other issues
      // Silently continue - queries will still work, just slower
    }
  }

  /**
   * Create the embeddings table with initial data
   */
  private async createTable(record: EmbeddingRecord): Promise<void> {
    if (!this.db) throw new Error("Database not initialized");

    this.table = await this.db.createTable("embeddings", [record], {
      mode: "overwrite",
    });

    // Create scalar index on id column for fast lookups and deletes
    await this.ensureIdIndex();
  }

  /**
   * Embed a single item
   *
   * @param item - Item to embed
   * @returns Whether a new embedding was created (false if skipped)
   */
  async embed(item: ItemToEmbed): Promise<boolean> {
    await this.ensureInitialized();

    const textToEmbed = item.contextText || item.text;
    const textHash = hashText(textToEmbed);

    // Check if unchanged
    if (this.table) {
      try {
        const existing = await this.table
          .query()
          .where(`id = '${item.id.replace(/'/g, "''")}'`)
          .limit(1)
          .toArray();

        if (existing.length > 0 && existing[0].text_hash === textHash) {
          return false; // Skip - unchanged
        }
      } catch {
        // Table might not exist yet or query failed, continue with embedding
      }
    }

    // Generate embedding
    const embedding = await this.provider.embedSingle(textToEmbed);

    // Store in database
    await this.storeEmbedding(
      item.id,
      embedding,
      textHash,
      textToEmbed,
      item.metadata
    );

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
    await this.ensureInitialized();

    const { onProgress, progressInterval = 100, forceAll = false } = options;

    const result: BatchEmbedResult = {
      processed: 0,
      skipped: 0,
      errors: 0,
      errorSamples: [],
    };

    // Build hash map for change detection
    const hashMap = new Map<string, string>();
    if (!forceAll && this.table) {
      try {
        const existingRecords = await this.table
          .query()
          .select(["id", "text_hash"])
          .toArray();
        for (const row of existingRecords) {
          hashMap.set(row.id as string, row.text_hash as string);
        }
      } catch {
        // Table might not exist yet, continue
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

    // Track timing for rate calculation
    const startTime = Date.now();

    // Process in batches
    const batchSize = this.provider.maxBatchSize;
    for (let i = 0; i < itemsToEmbed.length; i += batchSize) {
      const batchItems = itemsToEmbed.slice(i, i + batchSize);
      const batchHashes = itemHashes.slice(i, i + batchSize);
      const texts = batchItems.map((item) => item.contextText || item.text);

      try {
        const embeddings = await this.provider.embed(texts);

        // Build records for batch storage
        const records: EmbeddingRecord[] = [];
        const now = Date.now();

        for (let j = 0; j < batchItems.length; j++) {
          const item = batchItems[j];
          const embedding = embeddings[j];
          const textHash = batchHashes[j];
          const textToEmbed = item.contextText || item.text;
          const metadataJson = item.metadata ? JSON.stringify(item.metadata) : "";

          // Skip items with empty or invalid IDs
          if (!item.id || item.id.length === 0) {
            result.errors++;
            if (result.errorSamples!.length < 5) {
              result.errorSamples!.push(`Skipped item with empty ID`);
            }
            continue;
          }

          records.push({
            id: item.id,
            text_hash: textHash,
            context_text: textToEmbed,
            model: this.provider.model,
            dimensions: this.provider.dimensions,
            metadata: metadataJson,
            created_at: now,
            updated_at: now,
            vector: Array.from(embedding),
          });
        }

        // Batch store: delete existing and add new in bulk
        try {
          await this.storeEmbeddingsBatch(records);
          result.processed += records.length;
        } catch (error) {
          result.errors += records.length;
          if (result.errorSamples!.length < 5) {
            result.errorSamples!.push(
              `Batch store error: ${error instanceof Error ? error.message : String(error)}`
            );
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
      const totalProcessed = result.processed + result.skipped + result.errors;
      if (onProgress && totalProcessed % progressInterval === 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = result.processed > 0 ? result.processed / elapsed : 0;

        onProgress({
          processed: result.processed,
          skipped: result.skipped,
          errors: result.errors,
          total: items.length,
          currentItem:
            batchItems[batchItems.length - 1]?.text.substring(0, 50),
          rate,
        });
      }
    }

    // Final progress report
    if (onProgress) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = result.processed > 0 ? result.processed / elapsed : 0;

      onProgress({
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        total: items.length,
        rate,
      });
    }

    return result;
  }

  /**
   * Store an embedding in the database
   */
  private async storeEmbedding(
    id: string,
    embedding: Float32Array,
    textHash: string,
    contextText: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    const now = Date.now();
    // Use empty string instead of null - LanceDB can't infer schema from null values
    const metadataJson = metadata ? JSON.stringify(metadata) : "";

    const record: EmbeddingRecord = {
      id,
      text_hash: textHash,
      context_text: contextText,
      model: this.provider.model,
      dimensions: this.provider.dimensions,
      metadata: metadataJson,
      created_at: now,
      updated_at: now,
      vector: Array.from(embedding),
    };

    if (!this.table) {
      // Create table with first record
      await this.createTable(record);
    } else {
      // Delete existing record if any, then add new one
      try {
        await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
      } catch {
        // Record might not exist, that's fine
      }
      await this.table.add([record]);
    }
  }

  /**
   * Store multiple embeddings in batch
   * Uses mergeInsert (upsert) for efficient updates without delete+add
   */
  private async storeEmbeddingsBatch(records: EmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;

    if (!this.table) {
      // Create table with first record, then add the rest
      await this.createTable(records[0]);
      if (records.length > 1) {
        await this.table!.add(records.slice(1));
      }
    } else {
      // Use mergeInsert (upsert) - updates existing, inserts new
      // This is more efficient than delete+add with large tables
      await this.table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(records);
    }
  }

  /**
   * Search for similar items
   *
   * @param query - Query text to search for
   * @param k - Number of results to return
   * @returns Search results sorted by similarity (descending)
   */
  async search(query: string, k: number = 10): Promise<SearchResult[]> {
    await this.ensureInitialized();

    if (!this.table) {
      return []; // No embeddings yet
    }

    // Generate query embedding
    const queryEmbedding = await this.provider.embedSingle(query);

    // Search using LanceDB
    const results = await this.table
      .vectorSearch(Array.from(queryEmbedding))
      .limit(k)
      .toArray();

    // Map to SearchResult format
    return results.map((row) => {
      const metadataStr = row.metadata as string;
      return {
        id: row.id as string,
        distance: row._distance as number,
        similarity: 1 - (row._distance as number),
        contextText: row.context_text as string,
        metadata: metadataStr && metadataStr.length > 0
          ? JSON.parse(metadataStr)
          : undefined,
      };
    });
  }

  /**
   * Get a stored embedding by ID
   *
   * @param id - Item ID
   * @returns Stored embedding or null if not found
   */
  async getEmbedding(id: string): Promise<StoredEmbedding | null> {
    await this.ensureInitialized();

    if (!this.table) {
      return null;
    }

    try {
      const rows = await this.table
        .query()
        .where(`id = '${id.replace(/'/g, "''")}'`)
        .limit(1)
        .toArray();

      if (rows.length === 0) {
        return null;
      }

      const row = rows[0];
      const metadataStr = row.metadata as string;
      return {
        id: row.id as string,
        embedding: new Float32Array(row.vector as number[]),
        textHash: row.text_hash as string,
        contextText: row.context_text as string,
        model: row.model as string,
        dimensions: row.dimensions as number,
        metadata: metadataStr && metadataStr.length > 0
          ? JSON.parse(metadataStr)
          : undefined,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    } catch {
      return null;
    }
  }

  /**
   * Delete an embedding by ID
   *
   * @param id - Item ID to delete
   */
  async delete(id: string): Promise<void> {
    await this.ensureInitialized();

    if (this.table) {
      try {
        await this.table.delete(`id = '${id.replace(/'/g, "''")}'`);
      } catch {
        // Record might not exist
      }
    }
  }

  /**
   * Remove embeddings not in the provided ID list
   *
   * @param keepIds - List of IDs to keep
   * @returns Number of embeddings removed
   */
  async cleanup(keepIds: string[]): Promise<number> {
    await this.ensureInitialized();

    if (!this.table) {
      return 0;
    }

    // Get all current IDs
    const currentIds = await this.getEmbeddedIds();
    const keepSet = new Set(keepIds);
    const toRemove = currentIds.filter((id) => !keepSet.has(id));

    for (const id of toRemove) {
      await this.delete(id);
    }

    return toRemove.length;
  }

  /**
   * Get list of all embedded item IDs
   *
   * @returns Array of item IDs
   */
  async getEmbeddedIds(): Promise<string[]> {
    await this.ensureInitialized();

    if (!this.table) {
      return [];
    }

    try {
      const rows = await this.table.query().select(["id"]).toArray();
      return rows.map((r) => r.id as string);
    } catch {
      return [];
    }
  }

  /**
   * Get statistics about stored embeddings
   *
   * @returns Embedding statistics
   */
  async getStats(): Promise<EmbeddingStats> {
    await this.ensureInitialized();

    if (!this.table) {
      return {
        totalEmbeddings: 0,
        model: this.provider.model,
        dimensions: this.provider.dimensions,
      };
    }

    try {
      const rows = await this.table
        .query()
        .select(["created_at", "updated_at"])
        .toArray();

      const count = rows.length;
      let oldest: number | undefined;
      let newest: number | undefined;

      for (const row of rows) {
        const created = row.created_at as number;
        const updated = row.updated_at as number;

        if (oldest === undefined || created < oldest) {
          oldest = created;
        }
        if (newest === undefined || updated > newest) {
          newest = updated;
        }
      }

      return {
        totalEmbeddings: count,
        model: this.provider.model,
        dimensions: this.provider.dimensions,
        oldestEmbedding: oldest ? new Date(oldest) : undefined,
        newestEmbedding: newest ? new Date(newest) : undefined,
      };
    } catch {
      return {
        totalEmbeddings: 0,
        model: this.provider.model,
        dimensions: this.provider.dimensions,
      };
    }
  }

  /**
   * Close the database connection
   */
  close(): void {
    // LanceDB connections don't need explicit closing
    this.db = null;
    this.table = null;
    this.initialized = false;
    this.initPromise = null;
  }
}
