/**
 * UnifiedSearchService
 *
 * Aggregates search across multiple sources (tana, email, etc.)
 * and returns results with source identification for routing.
 */

import type {
  SearchSource,
  SearchResult,
  UnifiedSearchResult,
  SourceId,
} from "../types";
import { parseSourceId } from "../types";

/**
 * Options for unified search
 */
export interface UnifiedSearchOptions {
  /**
   * Filter by source types (e.g., ["tana", "email"])
   * Matches the type part of hierarchical source IDs
   */
  sourceTypes?: string[];

  /**
   * Filter by specific source IDs (e.g., ["tana/main", "email/work"])
   * Exact match on full source ID
   */
  sources?: SourceId[];
}

/**
 * Source metadata for listing
 */
export interface SourceInfo {
  sourceId: SourceId;
  description?: string;
}

/**
 * UnifiedSearchService - federated search across multiple sources
 */
export class UnifiedSearchService {
  private sources: Map<SourceId, SearchSource> = new Map();

  /**
   * Register a search source
   *
   * @param source - The search source to register
   */
  registerSource(source: SearchSource): void {
    this.sources.set(source.sourceId, source);
  }

  /**
   * Unregister a search source
   *
   * @param sourceId - The source ID to unregister
   */
  unregisterSource(sourceId: SourceId): void {
    this.sources.delete(sourceId);
  }

  /**
   * List all registered sources
   *
   * @returns Array of source metadata
   */
  listSources(): SourceInfo[] {
    return Array.from(this.sources.values()).map((source) => ({
      sourceId: source.sourceId,
      description: source.description,
    }));
  }

  /**
   * Search across all registered sources
   *
   * @param query - Search query text
   * @param k - Maximum number of results to return
   * @param options - Optional filters
   * @returns Unified search results sorted by similarity
   */
  async search(
    query: string,
    k: number,
    options: UnifiedSearchOptions = {}
  ): Promise<UnifiedSearchResult[]> {
    const { sourceTypes, sources: sourceFilter } = options;

    // Determine which sources to search
    const sourcesToSearch = Array.from(this.sources.values()).filter(
      (source) => {
        // Filter by specific source IDs
        if (sourceFilter && !sourceFilter.includes(source.sourceId)) {
          return false;
        }

        // Filter by source types
        if (sourceTypes) {
          const { type } = parseSourceId(source.sourceId);
          if (!sourceTypes.includes(type)) {
            return false;
          }
        }

        return true;
      }
    );

    if (sourcesToSearch.length === 0) {
      return [];
    }

    // Search all sources in parallel
    const searchPromises = sourcesToSearch.map(async (source) => {
      const results = await source.search(query, k);
      return results.map((result) => ({
        source: source.sourceId,
        id: result.id,
        similarity: result.similarity,
        preview: result.contextText,
        metadata: result.metadata,
      }));
    });

    const resultArrays = await Promise.all(searchPromises);

    // Flatten and sort by similarity
    const allResults = resultArrays.flat();
    allResults.sort((a, b) => b.similarity - a.similarity);

    // Return top k results
    return allResults.slice(0, k);
  }

  /**
   * Get item details from a specific source
   *
   * @param sourceId - The source ID
   * @param itemId - The item ID within the source
   * @returns Item preview and optional URL, or null if not found
   */
  async getItem(
    sourceId: SourceId,
    itemId: string
  ): Promise<{ preview: string; url?: string } | null> {
    const source = this.sources.get(sourceId);
    if (!source || !source.getItem) {
      return null;
    }

    return source.getItem(itemId);
  }
}
