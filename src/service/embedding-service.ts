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
  DatabaseDiagnostics,
  MaintenanceOptions,
  MaintenanceResult,
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
 * Default chunk settings
 */
const DEFAULT_CHUNK_SIZE = 30000; // ~8k tokens
const DEFAULT_CHUNK_OVERLAP = 500;

/**
 * Split text into overlapping chunks
 *
 * @param text - Text to chunk
 * @param chunkSize - Maximum characters per chunk
 * @param overlap - Character overlap between chunks
 * @returns Array of text chunks
 */
function chunkText(
  text: string,
  chunkSize: number,
  overlap: number
): string[] {
  if (text.length <= chunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let start = 0;

  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.substring(start, end));

    // Move start forward by (chunkSize - overlap)
    start += chunkSize - overlap;

    // Avoid tiny final chunks
    if (text.length - start < overlap && start < text.length) {
      // Just extend the last chunk to include remaining
      break;
    }
  }

  return chunks;
}

/**
 * Extract base node ID from potentially chunked ID
 * "nodeId#2" -> "nodeId"
 * "nodeId" -> "nodeId"
 */
function getBaseId(id: string): string {
  const hashIndex = id.lastIndexOf("#");
  if (hashIndex === -1) return id;
  // Verify it's a chunk suffix (number after #)
  const suffix = id.substring(hashIndex + 1);
  if (/^\d+$/.test(suffix)) {
    return id.substring(0, hashIndex);
  }
  return id;
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

    const {
      onProgress,
      progressInterval = 100,
      forceAll = false,
      storeBatchSize = 5000, // Large batches OK - we use add() for new records, chunk mergeInsert() for updates
      chunkSize = DEFAULT_CHUNK_SIZE,
      chunkOverlap = DEFAULT_CHUNK_OVERLAP,
    } = options;

    const result: BatchEmbedResult = {
      processed: 0,
      skipped: 0,
      errors: 0,
      errorSamples: [],
    };

    // Buffer for batched LanceDB writes
    const buffer: EmbeddingRecord[] = [];
    let stored = 0;

    // Build hash map for change detection (keyed by BASE ID, not chunk ID)
    // Also track existing IDs for batch optimization
    const baseHashMap = new Map<string, string>(); // baseId -> text_hash
    const existingIds = new Set<string>(); // All IDs including chunks
    const existingChunks = new Map<string, string[]>(); // baseId -> [chunkId1, chunkId2, ...]

    if (!forceAll && this.table) {
      try {
        if (process.env.RESONA_DEBUG) {
          console.error("[resona] Loading existing embeddings for change detection...");
        }

        // Stream records using AsyncIterable<RecordBatch> to avoid loading all into memory.
        // This prevents SIGILL crashes in compiled binaries with large datasets (450k+ records).
        const query = this.table.query().select(["id", "text_hash"]);
        let loadedCount = 0;

        for await (const batch of query) {
          const idColumn = batch.getChild("id");
          const hashColumn = batch.getChild("text_hash");

          for (let i = 0; i < batch.numRows; i++) {
            const id = idColumn?.get(i) as string;
            const textHash = hashColumn?.get(i) as string;

            const baseId = getBaseId(id);
            existingIds.add(id);

            // Store hash by base ID (use first chunk's hash as representative)
            if (!baseHashMap.has(baseId)) {
              baseHashMap.set(baseId, textHash);
            }

            // Track which chunks exist for each base ID
            if (!existingChunks.has(baseId)) {
              existingChunks.set(baseId, []);
            }
            existingChunks.get(baseId)!.push(id);

            loadedCount++;
          }

          // Progress logging for large datasets (T-2.2)
          if (process.env.RESONA_DEBUG && loadedCount % 50000 === 0) {
            console.error(`[resona] Loaded ${loadedCount} embeddings...`);
          }
        }

        if (process.env.RESONA_DEBUG) {
          console.error(`[resona] Loaded ${loadedCount} existing embeddings`);
        }
      } catch {
        // Table might not exist yet, continue
      }
    }

    // Filter items that need embedding (using base ID hash comparison)
    const itemsToEmbed: ItemToEmbed[] = [];
    const itemHashes: string[] = [];

    if (process.env.RESONA_DEBUG) {
      console.error(`[resona] Filtering ${items.length} items for changes...`);
    }
    for (const item of items) {
      const textToEmbed = item.contextText || item.text;
      const textHash = hashText(textToEmbed);
      const baseId = getBaseId(item.id);

      if (forceAll || baseHashMap.get(baseId) !== textHash) {
        itemsToEmbed.push(item);
        itemHashes.push(textHash);
      } else {
        result.skipped++;
      }
    }
    if (process.env.RESONA_DEBUG) {
      console.error(`[resona] ${itemsToEmbed.length} items need embedding, ${result.skipped} skipped`);
    }

    // Delete old chunks for items we're about to re-embed
    const baseIdsToUpdate = new Set(itemsToEmbed.map((item) => getBaseId(item.id)));
    const idsToDelete: string[] = [];
    for (const baseId of baseIdsToUpdate) {
      const chunks = existingChunks.get(baseId);
      if (chunks) {
        idsToDelete.push(...chunks);
      }
    }
    if (idsToDelete.length > 0 && this.table) {
      if (process.env.RESONA_DEBUG) {
        console.error(`[resona] Deleting ${idsToDelete.length} old chunks before re-embedding`);
      }
      await this.deleteByIds(idsToDelete);
      // Remove deleted IDs from existingIds
      for (const id of idsToDelete) {
        existingIds.delete(id);
      }
    }

    // Expand items into chunks for embedding
    interface ChunkToEmbed {
      chunkId: string;
      baseId: string;
      text: string;
      textHash: string;
      metadata?: Record<string, unknown>;
    }
    const chunksToEmbed: ChunkToEmbed[] = [];

    for (let i = 0; i < itemsToEmbed.length; i++) {
      const item = itemsToEmbed[i];
      const textHash = itemHashes[i];
      const textToEmbed = item.contextText || item.text;

      const textChunks = chunkText(textToEmbed, chunkSize, chunkOverlap);

      if (textChunks.length === 1) {
        // Single chunk - use original ID (no suffix)
        chunksToEmbed.push({
          chunkId: item.id,
          baseId: item.id,
          text: textChunks[0],
          textHash,
          metadata: item.metadata,
        });
      } else {
        // Multiple chunks - add suffix
        for (let c = 0; c < textChunks.length; c++) {
          chunksToEmbed.push({
            chunkId: `${item.id}#${c}`,
            baseId: item.id,
            text: textChunks[c],
            textHash,
            metadata: item.metadata,
          });
        }
      }
    }

    if (process.env.RESONA_DEBUG && chunksToEmbed.length !== itemsToEmbed.length) {
      console.error(
        `[resona] Expanded ${itemsToEmbed.length} items into ${chunksToEmbed.length} chunks`
      );
    }

    // Track timing for rate calculation
    const startTime = Date.now();

    // Track unique base IDs processed for accurate item count
    const processedBaseIds = new Set<string>();

    // Process chunks in batches
    const batchSize = this.provider.maxBatchSize;
    let batchCount = 0;
    for (let i = 0; i < chunksToEmbed.length; i += batchSize) {
      const batchChunks = chunksToEmbed.slice(i, i + batchSize);
      const texts = batchChunks.map((chunk) => chunk.text);

      try {
        if (process.env.RESONA_DEBUG && batchCount === 0) {
          console.error(`[resona] Calling Ollama for first batch of ${texts.length} chunks...`);
        }
        const embeddings = await this.provider.embed(texts);
        if (process.env.RESONA_DEBUG && batchCount === 0) {
          console.error(`[resona] First Ollama batch complete, starting embedding loop`);
        }
        batchCount++;

        // Build records for batch storage
        const records: EmbeddingRecord[] = [];
        const now = Date.now();

        for (let j = 0; j < batchChunks.length; j++) {
          const chunk = batchChunks[j];
          const embedding = embeddings[j];
          const metadataJson = chunk.metadata ? JSON.stringify(chunk.metadata) : "";

          // Skip chunks with empty or invalid IDs
          if (!chunk.chunkId || chunk.chunkId.length === 0) {
            result.errors++;
            if (result.errorSamples!.length < 5) {
              result.errorSamples!.push(`Skipped chunk with empty ID`);
            }
            continue;
          }

          records.push({
            id: chunk.chunkId,
            text_hash: chunk.textHash,
            context_text: chunk.text,
            model: this.provider.model,
            dimensions: this.provider.dimensions,
            metadata: metadataJson,
            created_at: now,
            updated_at: now,
            vector: Array.from(embedding),
          });

          // Track base ID as processed
          processedBaseIds.add(chunk.baseId);
        }

        // Add records to buffer instead of immediate write
        buffer.push(...records);

        // Flush buffer when it reaches threshold
        if (buffer.length >= storeBatchSize) {
          const flushSize = buffer.length;
          // DEBUG: Log flush attempt
          if (process.env.RESONA_DEBUG) {
            console.error(`[resona] Flushing ${flushSize} records (stored before: ${stored})`);
          }
          try {
            await this.storeEmbeddingsBatch(buffer, existingIds);
            stored += flushSize;  // Use captured size before clearing
            buffer.length = 0; // Clear buffer
            // DEBUG: Log flush success
            if (process.env.RESONA_DEBUG) {
              console.error(`[resona] Flush complete (stored after: ${stored})`);
            }
          } catch (error) {
            result.errors += flushSize;
            if (result.errorSamples!.length < 5) {
              result.errorSamples!.push(
                `Batch store error: ${error instanceof Error ? error.message : String(error)}`
              );
            }
            if (process.env.RESONA_DEBUG) {
              console.error(`[resona] LanceDB flush FAILED for ${flushSize} records: ${error instanceof Error ? error.message : String(error)}`);
            }
            buffer.length = 0; // Clear buffer even on error
          }
        }
      } catch (error) {
        // Batch failed - count all as errors
        result.errors += batchChunks.length;
        if (result.errorSamples!.length < 5) {
          result.errorSamples!.push(
            `Batch error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
      }

      // Update processed count (unique items, not chunks)
      result.processed = processedBaseIds.size;

      // Report progress
      if (onProgress && i % (progressInterval * batchSize) < batchSize) {
        const elapsed = (Date.now() - startTime) / 1000;
        const rate = result.processed > 0 ? result.processed / elapsed : 0;

        onProgress({
          processed: result.processed,
          skipped: result.skipped,
          errors: result.errors,
          total: items.length,
          currentItem: batchChunks[batchChunks.length - 1]?.text.substring(0, 50),
          rate,
          stored,
          bufferSize: buffer.length,
        });
      }
    }

    // Flush remaining buffer at end
    if (buffer.length > 0) {
      const flushSize = buffer.length;
      try {
        await this.storeEmbeddingsBatch(buffer, existingIds);
        stored += flushSize;
      } catch (error) {
        result.errors += flushSize;
        if (result.errorSamples!.length < 5) {
          result.errorSamples!.push(
            `Final flush error: ${error instanceof Error ? error.message : String(error)}`
          );
        }
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
        stored,
        bufferSize: 0, // Buffer should be empty after final flush
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
   * Store multiple embeddings in batch using optimized strategy:
   * - Use add() for new records (fast, supports large batches 10k+)
   * - Use mergeInsert() for updates (slower, use smaller chunks)
   *
   * @param records - Records to store
   * @param existingIds - Set of IDs that already exist in the table (for partitioning)
   */
  private async storeEmbeddingsBatch(
    records: EmbeddingRecord[],
    existingIds?: Set<string>
  ): Promise<void> {
    if (records.length === 0) return;

    if (!this.table) {
      // Create table with first record, then add the rest
      await this.createTable(records[0]);
      if (records.length > 1) {
        await this.table!.add(records.slice(1));
      }
      return;
    }

    // Partition records into new (use add) and updates (use mergeInsert)
    const newRecords: EmbeddingRecord[] = [];
    const updateRecords: EmbeddingRecord[] = [];

    for (const record of records) {
      if (existingIds && existingIds.has(record.id)) {
        updateRecords.push(record);
      } else {
        newRecords.push(record);
      }
    }

    // Add new records in one fast batch (LanceDB prefers large batches for add)
    if (newRecords.length > 0) {
      if (process.env.RESONA_DEBUG) {
        console.error(`[resona] Adding ${newRecords.length} new records`);
      }
      await this.table.add(newRecords);
    }

    // Update existing records using mergeInsert in smaller chunks
    // mergeInsert is slower and may have issues with very large batches
    if (updateRecords.length > 0) {
      const MERGE_CHUNK_SIZE = 500; // Smaller chunks for mergeInsert
      if (process.env.RESONA_DEBUG) {
        console.error(
          `[resona] Updating ${updateRecords.length} existing records in chunks of ${MERGE_CHUNK_SIZE}`
        );
      }

      for (let i = 0; i < updateRecords.length; i += MERGE_CHUNK_SIZE) {
        const chunk = updateRecords.slice(i, i + MERGE_CHUNK_SIZE);
        await this.table
          .mergeInsert("id")
          .whenMatchedUpdateAll()
          .whenNotMatchedInsertAll()
          .execute(chunk);
      }
    }
  }

  /**
   * Search for similar items
   *
   * Deduplicates results by base node ID, returning only the best match
   * for each unique item (handles chunked embeddings).
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

    // Request more results to account for chunk deduplication
    // If we have chunked content, multiple chunks of the same item might match
    const searchLimit = k * 5;

    // Search using LanceDB
    const results = await this.table
      .vectorSearch(Array.from(queryEmbedding))
      .limit(searchLimit)
      .toArray();

    // Deduplicate by base ID, keeping highest similarity match
    const bestByBaseId = new Map<string, SearchResult>();

    for (const row of results) {
      const id = row.id as string;
      const baseId = getBaseId(id);
      const distance = row._distance as number;
      const similarity = 1 - distance;
      const metadataStr = row.metadata as string;

      const result: SearchResult = {
        id: baseId, // Return base ID, not chunk ID
        distance,
        similarity,
        contextText: row.context_text as string,
        metadata:
          metadataStr && metadataStr.length > 0
            ? JSON.parse(metadataStr)
            : undefined,
      };

      const existing = bestByBaseId.get(baseId);
      if (!existing || result.similarity > existing.similarity) {
        bestByBaseId.set(baseId, result);
      }
    }

    // Sort by similarity descending and return top k
    const dedupedResults = Array.from(bestByBaseId.values());
    dedupedResults.sort((a, b) => b.similarity - a.similarity);

    return dedupedResults.slice(0, k);
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
   * Delete multiple embeddings by ID
   *
   * @param ids - Item IDs to delete
   */
  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.ensureInitialized();

    if (this.table) {
      // Build OR condition for all IDs
      const conditions = ids.map((id) => `id = '${id.replace(/'/g, "''")}'`);
      const whereClause = conditions.join(" OR ");
      try {
        await this.table.delete(whereClause);
      } catch {
        // Records might not exist
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
      // Paginate to avoid LanceDB bug with large result sets returning corrupt data
      const BATCH_SIZE = 100;
      const allIds: string[] = [];
      let offset = 0;

      while (true) {
        const rows = await this.table
          .query()
          .select(["id"])
          .limit(BATCH_SIZE)
          .offset(offset)
          .toArray();

        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          allIds.push(row.id as string);
        }

        offset += BATCH_SIZE;
      }

      return allIds;
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
   * Find the vector index name by looking up indices on the "vector" column.
   * createIndex("vector", ...) creates an index on the column, but the index
   * gets an auto-generated name. indexStats() requires the index NAME, not column.
   *
   * @returns The index name or null if no index on vector column
   */
  private async findVectorIndexName(): Promise<string | null> {
    if (!this.table) return null;

    try {
      const indices = await this.table.listIndices();
      // Find index that includes "vector" column
      const vectorIndex = indices.find((idx: { columns: string[] }) =>
        idx.columns.includes("vector")
      );
      return vectorIndex?.name ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Get database diagnostics including row count, version, and index health
   */
  async getDiagnostics(): Promise<DatabaseDiagnostics> {
    await this.initialize();

    const dbPath = this.dbPath.replace(/\.db$/, ".lance");

    if (!this.table) {
      return {
        totalRows: 0,
        version: 0,
        index: null,
        dbPath,
      };
    }

    const totalRows = await this.table.countRows();
    const version = await this.table.version();

    // Get index stats if index exists
    // Note: indexStats() takes the INDEX NAME, not column name
    // We must use listIndices() to find the index on "vector" column first
    let index: DatabaseDiagnostics["index"] = null;
    try {
      const vectorIndexName = await this.findVectorIndexName();
      if (vectorIndexName) {
        const stats = await this.table.indexStats(vectorIndexName);
        if (stats) {
          const numIndexedRows = stats.numIndexedRows ?? 0;
          const numUnindexedRows = stats.numUnindexedRows ?? 0;
          const total = numIndexedRows + numUnindexedRows;
          const stalePercent = total > 0 ? (numUnindexedRows / total) * 100 : 0;

          index = {
            numIndexedRows,
            numUnindexedRows,
            stalePercent,
            needsRebuild: stalePercent > 10, // Default 10% threshold
          };
        }
      }
    } catch {
      // No index exists or indexStats not available
      index = null;
    }

    return {
      totalRows,
      version,
      index,
      dbPath,
    };
  }

  /**
   * Run database maintenance: compaction, index rebuild, and cleanup
   *
   * LanceDB's optimize() handles both compaction and cleanup in one call.
   * The cleanupOlderThan option controls version pruning.
   *
   * @param options - Maintenance options (skip flags, thresholds, progress callback)
   * @returns Maintenance result with metrics
   */
  async maintain(options: MaintenanceOptions = {}): Promise<MaintenanceResult> {
    const startTime = Date.now();
    await this.initialize();

    const {
      skipCompaction = false,
      skipIndex = false,
      skipCleanup = false,
      retentionDays = 7,
      indexStaleThreshold = 0.1,
      onProgress,
    } = options;

    const result: MaintenanceResult = {
      indexRebuilt: false,
      durationMs: 0,
    };

    if (!this.table) {
      result.durationMs = Date.now() - startTime;
      return result;
    }

    // Step 1: Optimize (compaction + optional cleanup)
    // LanceDB's optimize() always does compaction, cleanupOlderThan controls version pruning
    if (!skipCompaction || !skipCleanup) {
      const runCompaction = !skipCompaction;
      const runCleanup = !skipCleanup;

      if (runCompaction && runCleanup) {
        onProgress?.("Optimizing database (compaction + cleanup)...");
      } else if (runCompaction) {
        onProgress?.("Compacting database fragments...");
      } else {
        onProgress?.("Cleaning up old versions...");
      }

      try {
        // Calculate cleanup date if cleanup is enabled
        const cleanupOlderThan = runCleanup
          ? new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000)
          : undefined;

        const optimizeResult = await this.table.optimize({
          cleanupOlderThan,
        });

        // Extract compaction stats
        if (runCompaction) {
          result.compaction = {
            fragmentsRemoved: optimizeResult.compaction?.fragmentsRemoved ?? 0,
            filesCreated: optimizeResult.compaction?.fragmentsAdded ?? 0,
          };
          onProgress?.("Compaction complete", `${result.compaction.fragmentsRemoved} fragments merged`);
        }

        // Extract cleanup stats (prune)
        if (runCleanup) {
          result.cleanup = {
            bytesRemoved: optimizeResult.prune?.bytesRemoved ?? 0,
            versionsRemoved: optimizeResult.prune?.oldVersionsRemoved ?? 0,
          };
          onProgress?.("Cleanup complete", `${result.cleanup.versionsRemoved} versions removed`);
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : "Unknown error";
        onProgress?.("Optimize skipped", errMsg);
        if (!skipCompaction) {
          result.compaction = { fragmentsRemoved: 0, filesCreated: 0 };
        }
        if (!skipCleanup) {
          result.cleanup = { bytesRemoved: 0, versionsRemoved: 0 };
        }
      }
    }

    // Step 2: Index rebuild if stale
    if (!skipIndex) {
      onProgress?.("Checking index status...");
      try {
        // Use listIndices() to find the index by column name, then get its actual name
        // indexStats() requires the INDEX NAME, not column name
        const vectorIndexName = await this.findVectorIndexName();
        const stats = vectorIndexName
          ? await this.table.indexStats(vectorIndexName)
          : null;

        if (stats) {
          const numIndexed = stats.numIndexedRows ?? 0;
          const numUnindexed = stats.numUnindexedRows ?? 0;
          const total = numIndexed + numUnindexed;
          const stalePercent = total > 0 ? numUnindexed / total : 0;

          result.indexStats = {
            numIndexedRows: numIndexed,
            numUnindexedRows: numUnindexed,
          };

          if (stalePercent > indexStaleThreshold) {
            onProgress?.("Rebuilding index...", `${(stalePercent * 100).toFixed(1)}% unindexed`);
            await this.table.createIndex("vector", {
              config: lancedb.Index.ivfPq({
                numPartitions: Math.max(1, Math.floor(total / 5000)),
                numSubVectors: Math.min(16, Math.floor(this.provider.dimensions / 16)),
              }),
            });
            result.indexRebuilt = true;
            onProgress?.("Index rebuilt successfully");
          } else {
            onProgress?.("Index is healthy", `${(stalePercent * 100).toFixed(1)}% unindexed`);
          }
        } else {
          // No index exists yet, create one if we have data
          const rowCount = await this.table.countRows();
          if (rowCount > 0) {
            onProgress?.("Creating index...", `${rowCount} rows`);
            await this.table.createIndex("vector", {
              config: lancedb.Index.ivfPq({
                numPartitions: Math.max(1, Math.floor(rowCount / 5000)),
                numSubVectors: Math.min(16, Math.floor(this.provider.dimensions / 16)),
              }),
            });
            result.indexRebuilt = true;
            result.indexStats = {
              numIndexedRows: rowCount,
              numUnindexedRows: 0,
            };
            onProgress?.("Index created successfully");
          }
        }
      } catch (err) {
        onProgress?.("Index operation skipped", err instanceof Error ? err.message : "Unknown error");
      }
    }

    result.durationMs = Date.now() - startTime;
    return result;
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
