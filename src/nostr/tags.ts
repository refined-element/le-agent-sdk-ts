/**
 * Tag parsing and building utilities for Nostr events.
 */

export class TagParser {
  /**
   * Get the first value for a given tag key.
   * Returns the first value (index 1) for the matching tag, or undefined.
   */
  static getTagValue(
    tags: string[][],
    key: string
  ): string | undefined {
    for (const tag of tags) {
      if (tag.length >= 2 && tag[0] === key) {
        return tag[1];
      }
    }
    return undefined;
  }

  /**
   * Get all values for a given tag key.
   * Returns list of values (index 1) for all matching tags.
   */
  static getTagValues(tags: string[][], key: string): string[] {
    return tags.filter((t) => t.length >= 2 && t[0] === key).map((t) => t[1]);
  }

  /**
   * Get all complete tags matching a key.
   * Returns list of complete tag arrays matching the key.
   */
  static getFullTags(tags: string[][], key: string): string[][] {
    return tags.filter((t) => t.length > 0 && t[0] === key);
  }

  /**
   * Check if a tag exists, optionally matching a specific value.
   */
  static hasTag(
    tags: string[][],
    key: string,
    value?: string
  ): boolean {
    for (const tag of tags) {
      if (!tag || tag.length === 0) continue;
      if (tag[0] === key) {
        if (value === undefined) return true;
        if (tag.length >= 2 && tag[1] === value) return true;
      }
    }
    return false;
  }

  /**
   * Build a Nostr filter dict for REQ subscriptions.
   */
  static buildFilter(options?: {
    kinds?: number[];
    authors?: string[];
    ids?: string[];
    since?: number;
    until?: number;
    limit?: number;
    tags?: Record<string, string[]>;
  }): Record<string, unknown> {
    const f: Record<string, unknown> = {};
    if (!options) return f;

    if (options.kinds !== undefined) f.kinds = options.kinds;
    if (options.authors !== undefined) f.authors = options.authors;
    if (options.ids !== undefined) f.ids = options.ids;
    if (options.since !== undefined) f.since = options.since;
    if (options.until !== undefined) f.until = options.until;
    if (options.limit !== undefined) f.limit = options.limit;

    if (options.tags) {
      for (const [key, values] of Object.entries(options.tags)) {
        const filterKey = key.startsWith("#") ? key : `#${key}`;
        f[filterKey] = values;
      }
    }

    return f;
  }

  /**
   * Merge two tag lists, avoiding exact duplicates.
   */
  static mergeTags(
    base: string[][],
    additions: string[][]
  ): string[][] {
    const seen = new Set<string>();
    const result: string[][] = [];

    for (const tag of [...base, ...additions]) {
      const key = JSON.stringify(tag);
      if (!seen.has(key)) {
        seen.add(key);
        result.push(tag);
      }
    }

    return result;
  }
}
