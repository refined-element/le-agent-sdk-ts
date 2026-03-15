/**
 * Tests for ASA protocol data models.
 */

import { describe, it, expect } from "vitest";
import {
  AgentPricing,
  AgentCapability,
  AgentServiceRequest,
  AgentServiceAgreement,
  AgentAttestation,
} from "../src/index.js";

// --- AgentPricing ---

describe("AgentPricing", () => {
  it("toTag produces correct array", () => {
    const p = new AgentPricing({ amount: 100, unit: "sats", model: "per-request" });
    expect(p.toTag()).toEqual(["price", "100", "sats", "per-request"]);
  });

  it("fromTag parses full tag", () => {
    const p = AgentPricing.fromTag(["price", "50", "msats", "per-token"]);
    expect(p.amount).toBe(50);
    expect(p.unit).toBe("msats");
    expect(p.model).toBe("per-token");
  });

  it("fromTag parses minimal tag with defaults", () => {
    const p = AgentPricing.fromTag(["price", "10"]);
    expect(p.amount).toBe(10);
    expect(p.unit).toBe("sats");
    expect(p.model).toBe("per-request");
  });

  it("fromTag throws on invalid tag", () => {
    expect(() => AgentPricing.fromTag(["price"])).toThrow();
  });

  it("roundtrips correctly", () => {
    const original = new AgentPricing({ amount: 42, unit: "sats", model: "per-minute" });
    const tag = original.toTag();
    const restored = AgentPricing.fromTag(tag);
    expect(restored.amount).toBe(original.amount);
    expect(restored.unit).toBe(original.unit);
    expect(restored.model).toBe(original.model);
  });
});

// --- AgentCapability ---

describe("AgentCapability", () => {
  const sampleEvent = () => ({
    id: "abc123",
    pubkey: "deadbeef",
    created_at: 1700000000,
    kind: 38400,
    content: "A translation service",
    tags: [
      ["d", "translate-v1"],
      ["s", "ai"],
      ["s", "translation"],
      ["price", "10", "sats", "per-request"],
      ["price", "1", "sats", "per-token"],
      ["l402", "https://api.example.com/l402/translate"],
      ["api_endpoint", "https://api.example.com/translate"],
      ["api_method", "POST"],
      ["schema", "https://api.example.com/schema.json"],
      ["t", "translation"],
      ["t", "ai"],
    ],
    sig: "sig123",
  });

  it("parses from Nostr event", () => {
    const cap = AgentCapability.fromNostrEvent(sampleEvent());
    expect(cap.eventId).toBe("abc123");
    expect(cap.pubkey).toBe("deadbeef");
    expect(cap.createdAt).toBe(1700000000);
    expect(cap.serviceId).toBe("translate-v1");
    expect(cap.categories).toEqual(["ai", "translation"]);
    expect(cap.content).toBe("A translation service");
    expect(cap.pricing).toHaveLength(2);
    expect(cap.pricing[0].amount).toBe(10);
    expect(cap.pricing[1].model).toBe("per-token");
    expect(cap.l402Endpoint).toBe("https://api.example.com/l402/translate");
    expect(cap.apiEndpoint).toBe("https://api.example.com/translate");
    expect(cap.apiMethod).toBe("POST");
    expect(cap.schemaUrl).toBe("https://api.example.com/schema.json");
    expect(cap.hashtags).toEqual(["translation", "ai"]);
  });

  it("converts to Nostr tags", () => {
    const cap = new AgentCapability({
      serviceId: "test-svc",
      categories: ["ai"],
      pricing: [new AgentPricing({ amount: 5, unit: "sats", model: "per-request" })],
      l402Endpoint: "https://example.com/l402",
      hashtags: ["test"],
    });
    const tags = cap.toNostrTags();
    expect(tags).toContainEqual(["d", "test-svc"]);
    expect(tags).toContainEqual(["s", "ai"]);
    expect(tags).toContainEqual(["price", "5", "sats", "per-request"]);
    expect(tags).toContainEqual(["l402", "https://example.com/l402"]);
    expect(tags).toContainEqual(["t", "test"]);
  });

  it("roundtrips correctly", () => {
    const cap = new AgentCapability({
      serviceId: "round-trip",
      categories: ["ml", "vision"],
      content: "Image recognition service",
      pricing: [new AgentPricing({ amount: 25, unit: "sats", model: "per-request" })],
      l402Endpoint: "https://api.example.com/l402",
      apiEndpoint: "https://api.example.com/recognize",
      apiMethod: "POST",
      schemaUrl: "https://api.example.com/schema.json",
      hashtags: ["vision", "ml"],
    });
    const tags = cap.toNostrTags();
    const event = {
      id: "roundtrip-id",
      pubkey: "roundtrip-pub",
      created_at: 1700000001,
      kind: 38400,
      content: cap.content,
      tags,
      sig: "",
    };
    const restored = AgentCapability.fromNostrEvent(event);
    expect(restored.serviceId).toBe(cap.serviceId);
    expect(restored.categories).toEqual(cap.categories);
    expect(restored.content).toBe(cap.content);
    expect(restored.l402Endpoint).toBe(cap.l402Endpoint);
    expect(restored.apiEndpoint).toBe(cap.apiEndpoint);
    expect(restored.apiMethod).toBe(cap.apiMethod);
    expect(restored.schemaUrl).toBe(cap.schemaUrl);
    expect(restored.hashtags).toEqual(cap.hashtags);
    expect(restored.pricing).toHaveLength(cap.pricing.length);
  });

  it("handles empty event", () => {
    const cap = AgentCapability.fromNostrEvent({ tags: [] });
    expect(cap.serviceId).toBe("");
    expect(cap.categories).toEqual([]);
    expect(cap.pricing).toEqual([]);
  });

  it("has correct KIND constant", () => {
    expect(AgentCapability.KIND).toBe(38400);
  });

  it("defaults to negotiable true", () => {
    const cap = new AgentCapability();
    expect(cap.negotiable).toBe(true);
    expect(cap.minPriceSats).toBeNull();
    const tags = cap.toNostrTags();
    expect(tags).toContainEqual(["negotiable", "true"]);
  });

  it("emits negotiable false", () => {
    const cap = new AgentCapability({ negotiable: false });
    const tags = cap.toNostrTags();
    expect(tags).toContainEqual(["negotiable", "false"]);
  });

  it("emits negotiable floor", () => {
    const cap = new AgentCapability({ negotiable: true, minPriceSats: 30000 });
    const tags = cap.toNostrTags();
    expect(tags).toContainEqual(["negotiable", "floor", "30000"]);
  });

  it("parses negotiable false from event", () => {
    const cap = AgentCapability.fromNostrEvent({
      tags: [["d", "svc"], ["negotiable", "false"]],
    });
    expect(cap.negotiable).toBe(false);
    expect(cap.minPriceSats).toBeNull();
  });

  it("parses negotiable floor from event", () => {
    const cap = AgentCapability.fromNostrEvent({
      tags: [["d", "svc"], ["negotiable", "floor", "10000"]],
    });
    expect(cap.negotiable).toBe(true);
    expect(cap.minPriceSats).toBe(10000);
  });

  it("roundtrips negotiable floor", () => {
    const cap = new AgentCapability({
      serviceId: "floor-rt",
      negotiable: true,
      minPriceSats: 5000,
    });
    const tags = cap.toNostrTags();
    const restored = AgentCapability.fromNostrEvent({
      id: "rt",
      pubkey: "pk",
      created_at: 1,
      kind: 38400,
      content: "",
      tags,
    });
    expect(restored.negotiable).toBe(true);
    expect(restored.minPriceSats).toBe(5000);
  });
});

// --- AgentServiceRequest ---

describe("AgentServiceRequest", () => {
  const sampleEvent = () => ({
    id: "req123",
    pubkey: "requester_pub",
    created_at: 1700000002,
    kind: 38401,
    content: "Need translation",
    tags: [
      ["e", "cap_event_id"],
      ["p", "provider_pub"],
      ["budget", "500"],
      ["param", "source_lang", "en"],
      ["param", "target_lang", "es"],
    ],
    sig: "sig456",
  });

  it("parses from Nostr event", () => {
    const req = AgentServiceRequest.fromNostrEvent(sampleEvent());
    expect(req.eventId).toBe("req123");
    expect(req.pubkey).toBe("requester_pub");
    expect(req.capabilityEventId).toBe("cap_event_id");
    expect(req.providerPubkey).toBe("provider_pub");
    expect(req.budgetSats).toBe(500);
    expect(req.params).toEqual({ source_lang: "en", target_lang: "es" });
    expect(req.content).toBe("Need translation");
  });

  it("converts to Nostr tags", () => {
    const req = new AgentServiceRequest({
      capabilityEventId: "cap1",
      providerPubkey: "prov1",
      budgetSats: 100,
      params: { key: "val" },
    });
    const tags = req.toNostrTags();
    expect(tags).toContainEqual(["e", "cap1"]);
    expect(tags).toContainEqual(["p", "prov1"]);
    expect(tags).toContainEqual(["budget", "100"]);
    expect(tags).toContainEqual(["param", "key", "val"]);
  });

  it("roundtrips correctly", () => {
    const req = new AgentServiceRequest({
      capabilityEventId: "cap_rt",
      providerPubkey: "prov_rt",
      budgetSats: 250,
      content: "Test request",
      params: { lang: "fr" },
    });
    const tags = req.toNostrTags();
    const event = {
      id: "rt_req",
      pubkey: "rt_pub",
      created_at: 1700000003,
      kind: 38401,
      content: req.content,
      tags,
      sig: "",
    };
    const restored = AgentServiceRequest.fromNostrEvent(event);
    expect(restored.capabilityEventId).toBe(req.capabilityEventId);
    expect(restored.providerPubkey).toBe(req.providerPubkey);
    expect(restored.budgetSats).toBe(req.budgetSats);
    expect(restored.params).toEqual(req.params);
  });

  it("has correct KIND constant", () => {
    expect(AgentServiceRequest.KIND).toBe(38401);
  });
});

// --- AgentServiceAgreement ---

describe("AgentServiceAgreement", () => {
  const sampleEvent = () => ({
    id: "agr123",
    pubkey: "provider_pub",
    created_at: 1700000004,
    kind: 38402,
    content: "Agreement reached",
    tags: [
      ["e", "req_event_id"],
      ["e", "cap_event_id"],
      ["p", "provider_pub"],
      ["p", "requester_pub"],
      ["price", "100"],
      ["l402", "https://api.example.com/l402/service"],
      ["terms", "Max 10 requests per minute"],
      ["expiration", "1700100000"],
    ],
    sig: "sig789",
  });

  it("parses from Nostr event (fallback order)", () => {
    const agr = AgentServiceAgreement.fromNostrEvent(sampleEvent());
    expect(agr.eventId).toBe("agr123");
    expect(agr.requestEventId).toBe("req_event_id");
    expect(agr.capabilityEventId).toBe("cap_event_id");
    expect(agr.providerPubkey).toBe("provider_pub");
    expect(agr.requesterPubkey).toBe("requester_pub");
    expect(agr.agreedPriceSats).toBe(100);
    expect(agr.l402Endpoint).toBe("https://api.example.com/l402/service");
    expect(agr.terms).toBe("Max 10 requests per minute");
    expect(agr.expiresAt).toBe(1700100000);
  });

  it("parses with marker hints", () => {
    const event = {
      id: "agr_marked",
      pubkey: "pub",
      created_at: 1,
      kind: 38402,
      content: "",
      tags: [
        ["e", "req_id", "", "request"],
        ["e", "cap_id", "", "capability"],
        ["p", "prov_pk", "", "provider"],
        ["p", "req_pk", "", "requester"],
        ["price", "50"],
      ],
      sig: "",
    };
    const agr = AgentServiceAgreement.fromNostrEvent(event);
    expect(agr.requestEventId).toBe("req_id");
    expect(agr.capabilityEventId).toBe("cap_id");
    expect(agr.providerPubkey).toBe("prov_pk");
    expect(agr.requesterPubkey).toBe("req_pk");
  });

  it("converts to Nostr tags", () => {
    const agr = new AgentServiceAgreement({
      requestEventId: "r1",
      capabilityEventId: "c1",
      providerPubkey: "prov",
      requesterPubkey: "req",
      agreedPriceSats: 50,
      l402Endpoint: "https://example.com/l402",
      terms: "Terms here",
      expiresAt: 1800000000,
    });
    const tags = agr.toNostrTags();
    const eTags = tags.filter((t) => t[0] === "e");
    const pTags = tags.filter((t) => t[0] === "p");
    expect(eTags).toHaveLength(2);
    expect(pTags).toHaveLength(2);
    expect(tags).toContainEqual(["price", "50"]);
    expect(tags).toContainEqual(["l402", "https://example.com/l402"]);
    expect(tags).toContainEqual(["terms", "Terms here"]);
    expect(tags).toContainEqual(["expiration", "1800000000"]);
  });

  it("roundtrips correctly", () => {
    const agr = new AgentServiceAgreement({
      requestEventId: "req_rt",
      capabilityEventId: "cap_rt",
      providerPubkey: "prov_rt",
      requesterPubkey: "req_pub_rt",
      agreedPriceSats: 75,
      l402Endpoint: "https://example.com/l402/rt",
      terms: "RT terms",
      content: "RT content",
      expiresAt: 1900000000,
    });
    const tags = agr.toNostrTags();
    const event = {
      id: "rt_agr",
      pubkey: "rt_pub",
      created_at: 1700000005,
      kind: 38402,
      content: agr.content,
      tags,
      sig: "",
    };
    const restored = AgentServiceAgreement.fromNostrEvent(event);
    expect(restored.requestEventId).toBe(agr.requestEventId);
    expect(restored.capabilityEventId).toBe(agr.capabilityEventId);
    expect(restored.providerPubkey).toBe(agr.providerPubkey);
    expect(restored.requesterPubkey).toBe(agr.requesterPubkey);
    expect(restored.agreedPriceSats).toBe(agr.agreedPriceSats);
    expect(restored.l402Endpoint).toBe(agr.l402Endpoint);
    expect(restored.terms).toBe(agr.terms);
    expect(restored.expiresAt).toBe(agr.expiresAt);
  });

  it("has correct KIND constant", () => {
    expect(AgentServiceAgreement.KIND).toBe(38402);
  });

  it("omits expiration tag when null", () => {
    const agr = new AgentServiceAgreement({ agreedPriceSats: 10 });
    const tags = agr.toNostrTags();
    const expTags = tags.filter((t) => t[0] === "expiration");
    expect(expTags).toHaveLength(0);
  });
});

// --- AgentAttestation ---

describe("AgentAttestation", () => {
  it("parses from Nostr event", () => {
    const event = {
      id: "att123",
      pubkey: "reviewer_pub",
      created_at: 1700000010,
      kind: 38403,
      content: "Great service",
      tags: [
        ["p", "subject_pub"],
        ["e", "agreement_id"],
        ["rating", "5"],
      ],
      sig: "",
    };
    const att = AgentAttestation.fromNostrEvent(event);
    expect(att.eventId).toBe("att123");
    expect(att.pubkey).toBe("reviewer_pub");
    expect(att.subjectPubkey).toBe("subject_pub");
    expect(att.agreementEventId).toBe("agreement_id");
    expect(att.rating).toBe(5);
    expect(att.content).toBe("Great service");
  });

  it("converts to Nostr tags", () => {
    const att = new AgentAttestation({
      subjectPubkey: "sub",
      agreementEventId: "agr",
      rating: 4,
    });
    const tags = att.toNostrTags();
    expect(tags).toContainEqual(["p", "sub"]);
    expect(tags).toContainEqual(["e", "agr"]);
    expect(tags).toContainEqual(["rating", "4"]);
  });

  it("has correct KIND constant", () => {
    expect(AgentAttestation.KIND).toBe(38403);
  });

  it("handles empty event", () => {
    const att = AgentAttestation.fromNostrEvent({ tags: [] });
    expect(att.subjectPubkey).toBe("");
    expect(att.rating).toBe(0);
  });
});
