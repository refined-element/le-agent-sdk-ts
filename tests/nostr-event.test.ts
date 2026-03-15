/**
 * Tests for Nostr event building, serialization, and ID computation.
 */

import { describe, it, expect } from "vitest";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import { NostrEvent } from "../src/index.js";

describe("NostrEvent serialization", () => {
  it("serializes for ID in NIP-01 format", () => {
    const event = {
      pubkey: "aabbccdd",
      created_at: 1700000000,
      kind: 1,
      tags: [["t", "test"]],
      content: "hello world",
    };
    const serialized = NostrEvent.serializeForId(event);
    const parsed = JSON.parse(serialized);
    expect(parsed[0]).toBe(0);
    expect(parsed[1]).toBe("aabbccdd");
    expect(parsed[2]).toBe(1700000000);
    expect(parsed[3]).toBe(1);
    expect(parsed[4]).toEqual([["t", "test"]]);
    expect(parsed[5]).toBe("hello world");
  });

  it("serializes without whitespace (compact JSON)", () => {
    const event = {
      pubkey: "ab",
      created_at: 1,
      kind: 1,
      tags: [],
      content: "",
    };
    const serialized = NostrEvent.serializeForId(event);
    // JSON.stringify without space arg produces compact output
    expect(serialized).not.toContain("\n");
  });

  it("computes deterministic ID", () => {
    const event = {
      pubkey: "aabbccdd",
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: "test",
    };
    const id1 = NostrEvent.computeId(event);
    const id2 = NostrEvent.computeId(event);
    expect(id1).toBe(id2);
  });

  it("computes ID as SHA-256", () => {
    const event = {
      pubkey: "aabbccdd",
      created_at: 1700000000,
      kind: 1,
      tags: [],
      content: "test",
    };
    const serialized = NostrEvent.serializeForId(event);
    const expected = bytesToHex(
      sha256(new TextEncoder().encode(serialized))
    );
    expect(NostrEvent.computeId(event)).toBe(expected);
  });

  it("produces different IDs for different content", () => {
    const base = { pubkey: "ab", created_at: 1, kind: 1, tags: [] as string[][] };
    const a = { ...base, content: "hello" };
    const b = { ...base, content: "world" };
    expect(NostrEvent.computeId(a)).not.toBe(NostrEvent.computeId(b));
  });

  it("produces different IDs for different kinds", () => {
    const base = { pubkey: "ab", created_at: 1, tags: [] as string[][], content: "same" };
    const a = { ...base, kind: 1 };
    const b = { ...base, kind: 38400 };
    expect(NostrEvent.computeId(a)).not.toBe(NostrEvent.computeId(b));
  });

  it("tags affect ID", () => {
    const base = { pubkey: "ab", created_at: 1, kind: 1, content: "same" };
    const a = { ...base, tags: [] as string[][] };
    const b = { ...base, tags: [["t", "tag1"]] };
    expect(NostrEvent.computeId(a)).not.toBe(NostrEvent.computeId(b));
  });
});

describe("NostrEvent create", () => {
  it("creates unsigned event", async () => {
    const event = await NostrEvent.createUnsigned({
      kind: 38400,
      content: "test content",
      tags: [["d", "svc-1"]],
      pubkey: "aabbccdd",
      createdAt: 1700000000,
    });
    expect(event.kind).toBe(38400);
    expect(event.content).toBe("test content");
    expect(event.tags).toEqual([["d", "svc-1"]]);
    expect(event.pubkey).toBe("aabbccdd");
    expect(event.created_at).toBe(1700000000);
    expect(event.sig).toBe("");
    expect(event.id).toHaveLength(64);
  });

  it("sets correct ID on create", async () => {
    const event = await NostrEvent.createUnsigned({
      kind: 1,
      content: "hello",
      tags: [],
      pubkey: "ff",
      createdAt: 1,
    });
    const expectedId = NostrEvent.computeId(event);
    expect(event.id).toBe(expectedId);
  });

  it("creates with undefined privateKey and explicit pubkey", async () => {
    const event = await NostrEvent.create({
      kind: 1,
      content: "test",
      tags: [],
      pubkey: "mypub",
      createdAt: 100,
    });
    expect(event.pubkey).toBe("mypub");
    expect(event.sig).toBe("");
  });

  it("handles unicode content", async () => {
    const event = await NostrEvent.createUnsigned({
      kind: 1,
      content: "Hello world",
      tags: [],
      pubkey: "ab",
      createdAt: 1,
    });
    expect(event.content).toBe("Hello world");
    expect(event.id).toHaveLength(64);
  });
});

describe("NostrEvent signing", () => {
  // Use a known test private key (32 bytes hex)
  const testPrivateKey =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  it("derives pubkey from private key", () => {
    const pubkey = NostrEvent.pubkeyFromPrivateKey(testPrivateKey);
    expect(pubkey).toHaveLength(64);
    // pubkey should be deterministic
    expect(pubkey).toBe(NostrEvent.pubkeyFromPrivateKey(testPrivateKey));
  });

  it("throws on invalid private key length", () => {
    expect(() => NostrEvent.pubkeyFromPrivateKey("aabb")).toThrow(
      "32 bytes"
    );
  });

  it("creates signed event", async () => {
    const event = await NostrEvent.create({
      kind: 1,
      content: "signed test",
      tags: [],
      privateKey: testPrivateKey,
      createdAt: 1700000000,
    });
    expect(event.sig).toHaveLength(128); // 64 bytes hex
    expect(event.pubkey).toHaveLength(64);
    expect(event.id).toHaveLength(64);
  });

  it("signed event verifies", async () => {
    const event = await NostrEvent.create({
      kind: 1,
      content: "verify me",
      tags: [["t", "test"]],
      privateKey: testPrivateKey,
      createdAt: 1700000000,
    });
    const valid = await NostrEvent.verify(event);
    expect(valid).toBe(true);
  });

  it("tampered content fails verification", async () => {
    const event = await NostrEvent.create({
      kind: 1,
      content: "original",
      tags: [],
      privateKey: testPrivateKey,
      createdAt: 1700000000,
    });
    // Tamper with the content but keep same ID
    const tampered = { ...event, content: "tampered" };
    const valid = await NostrEvent.verify(tampered);
    expect(valid).toBe(false);
  });
});
