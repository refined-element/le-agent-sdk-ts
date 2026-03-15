/**
 * Tests for Nostr tag parsing and building utilities.
 */

import { describe, it, expect } from "vitest";
import { TagParser } from "../src/index.js";

describe("TagParser.getTagValue", () => {
  it("finds existing tag", () => {
    const tags = [["d", "svc-1"], ["t", "ai"]];
    expect(TagParser.getTagValue(tags, "d")).toBe("svc-1");
  });

  it("returns undefined for missing tag", () => {
    const tags = [["d", "svc-1"]];
    expect(TagParser.getTagValue(tags, "t")).toBeUndefined();
  });

  it("returns undefined for empty tags", () => {
    expect(TagParser.getTagValue([], "d")).toBeUndefined();
  });

  it("returns first match", () => {
    const tags = [["t", "first"], ["t", "second"]];
    expect(TagParser.getTagValue(tags, "t")).toBe("first");
  });

  it("skips short tags", () => {
    const tags = [["d"]];
    expect(TagParser.getTagValue(tags, "d")).toBeUndefined();
  });
});

describe("TagParser.getTagValues", () => {
  it("returns multiple values", () => {
    const tags = [["s", "ai"], ["s", "ml"], ["d", "svc"]];
    expect(TagParser.getTagValues(tags, "s")).toEqual(["ai", "ml"]);
  });

  it("returns empty array when none found", () => {
    const tags = [["d", "svc"]];
    expect(TagParser.getTagValues(tags, "s")).toEqual([]);
  });
});

describe("TagParser.getFullTags", () => {
  it("returns full tag arrays", () => {
    const tags = [
      ["price", "10", "sats", "per-request"],
      ["d", "svc"],
    ];
    const priceTags = TagParser.getFullTags(tags, "price");
    expect(priceTags).toHaveLength(1);
    expect(priceTags[0]).toEqual(["price", "10", "sats", "per-request"]);
  });

  it("returns empty array when none found", () => {
    expect(TagParser.getFullTags([], "price")).toEqual([]);
  });
});

describe("TagParser.hasTag", () => {
  it("checks key only", () => {
    const tags = [["d", "svc"]];
    expect(TagParser.hasTag(tags, "d")).toBe(true);
    expect(TagParser.hasTag(tags, "t")).toBe(false);
  });

  it("checks key and value", () => {
    const tags = [["t", "ai"], ["t", "ml"]];
    expect(TagParser.hasTag(tags, "t", "ai")).toBe(true);
    expect(TagParser.hasTag(tags, "t", "vision")).toBe(false);
  });

  it("returns false for empty tags", () => {
    expect(TagParser.hasTag([], "d")).toBe(false);
  });

  it("handles empty tag in list", () => {
    const tags = [[], ["d", "svc"]];
    expect(TagParser.hasTag(tags, "d")).toBe(true);
  });
});

describe("TagParser.buildFilter", () => {
  it("builds kinds-only filter", () => {
    const f = TagParser.buildFilter({ kinds: [38400] });
    expect(f).toEqual({ kinds: [38400] });
  });

  it("builds full filter", () => {
    const f = TagParser.buildFilter({
      kinds: [38400, 38401],
      authors: ["pub1"],
      limit: 10,
      since: 1700000000,
      tags: { s: ["ai"] },
    });
    expect(f.kinds).toEqual([38400, 38401]);
    expect(f.authors).toEqual(["pub1"]);
    expect(f.limit).toBe(10);
    expect(f.since).toBe(1700000000);
    expect(f["#s"]).toEqual(["ai"]);
  });

  it("auto-prefixes tag keys with #", () => {
    const f = TagParser.buildFilter({ tags: { t: ["test"] } });
    expect(f["#t"]).toEqual(["test"]);
  });

  it("preserves existing # prefix", () => {
    const f = TagParser.buildFilter({ tags: { "#t": ["test"] } });
    expect(f["#t"]).toEqual(["test"]);
  });

  it("builds empty filter when no options", () => {
    expect(TagParser.buildFilter()).toEqual({});
  });

  it("includes ids filter", () => {
    const f = TagParser.buildFilter({ ids: ["abc123"] });
    expect(f.ids).toEqual(["abc123"]);
  });
});

describe("TagParser.mergeTags", () => {
  it("merges without duplicates", () => {
    const result = TagParser.mergeTags([["d", "svc"]], [["t", "ai"]]);
    expect(result).toHaveLength(2);
  });

  it("deduplicates exact duplicates", () => {
    const base = [["t", "ai"], ["d", "svc"]];
    const additions = [["t", "ai"], ["t", "ml"]];
    const result = TagParser.mergeTags(base, additions);
    expect(result).toHaveLength(3);
    const tValues = result.filter((t) => t[0] === "t").map((t) => t[1]);
    expect(tValues).toEqual(["ai", "ml"]);
  });

  it("handles empty inputs", () => {
    expect(TagParser.mergeTags([], [])).toEqual([]);
  });
});
