/**
 * Tests for AgentManager -- basic flows with mocked relay/HTTP.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentManager,
  AgentCapability,
  AgentPricing,
  AgentServiceAgreement,
  NostrEvent,
} from "../src/index.js";

describe("AgentManager init", () => {
  it("uses default relay URL", () => {
    const mgr = new AgentManager();
    expect(mgr.relayUrls).toEqual(["wss://agents.lightningenable.com"]);
  });

  it("accepts custom relay URLs", () => {
    const mgr = new AgentManager({
      relayUrls: ["wss://relay1.example.com"],
    });
    expect(mgr.relayUrls).toEqual(["wss://relay1.example.com"]);
  });

  it("has no private key by default", () => {
    const mgr = new AgentManager();
    expect(mgr.privateKey).toBeUndefined();
  });

  it("throws when accessing pubkey without private key", () => {
    const mgr = new AgentManager();
    expect(() => mgr.pubkey).toThrow("No private key");
  });
});

describe("AgentManager discover", () => {
  it("returns parsed capabilities from relay events", async () => {
    const sampleEvents = [
      {
        id: "ev1",
        pubkey: "pub1",
        created_at: 1700000000,
        kind: 38400,
        content: "Service A",
        tags: [["d", "svc-a"], ["s", "ai"]],
        sig: "",
      },
      {
        id: "ev2",
        pubkey: "pub2",
        created_at: 1700000001,
        kind: 38400,
        content: "Service B",
        tags: [["d", "svc-b"], ["s", "translation"]],
        sig: "",
      },
    ];

    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue(sampleEvents);

    const caps = await mgr.discover({ categories: ["ai"] });
    expect(caps).toHaveLength(2);
    expect(caps[0].serviceId).toBe("svc-a");
    expect(caps[1].serviceId).toBe("svc-b");
  });

  it("returns empty array when no results", async () => {
    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue([]);

    const caps = await mgr.discover();
    expect(caps).toEqual([]);
  });

  it("passes hashtag filters to relay query", async () => {
    const mgr = new AgentManager();
    const spy = vi.spyOn(mgr, "queryRelays").mockResolvedValue([]);

    await mgr.discover({ hashtags: ["ml", "vision"] });

    const callArgs = spy.mock.calls[0][0];
    expect(callArgs[0]["#t"]).toEqual(["ml", "vision"]);
  });

  it("skips a single malformed-price event without aborting the batch", async () => {
    // Ledger #41 DoS vector: one hostile relay publishing one capability event
    // with an unparseable price tag must not take down discovery for everyone.
    // The batch must parse each event independently, drop the bad one, LOUDLY
    // (warn), and still return every valid capability.
    const events = [
      {
        id: "good-1",
        pubkey: "pub1",
        created_at: 1700000000,
        kind: 38400,
        content: "Service A",
        tags: [["d", "svc-a"], ["price", "100", "sats", "per-request"]],
        sig: "",
      },
      {
        id: "poison",
        pubkey: "pub-evil",
        created_at: 1700000001,
        kind: 38400,
        content: "Poison service",
        tags: [["d", "svc-poison"], ["price", "abc"]],
        sig: "",
      },
      {
        id: "good-2",
        pubkey: "pub2",
        created_at: 1700000002,
        kind: 38400,
        content: "Service B",
        tags: [["d", "svc-b"], ["price", "200", "sats", "per-request"]],
        sig: "",
      },
    ];

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const mgr = new AgentManager();
      vi.spyOn(mgr, "queryRelays").mockResolvedValue(events);

      const caps = await mgr.discover();

      // The malformed event is skipped; both valid capabilities survive.
      expect(caps).toHaveLength(2);
      expect(caps.map((c) => c.serviceId)).toEqual(["svc-a", "svc-b"]);

      // Fail closed, LOUDLY: the skip is warned and names the offending event id.
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0].join(" ")).toContain("poison");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("AgentManager settle", () => {
  it("throws when agreement has no L402 endpoint", async () => {
    const mgr = new AgentManager();
    const agreement = new AgentServiceAgreement({ l402Endpoint: "" });

    await expect(mgr.settle(agreement)).rejects.toThrow(
      "no L402 endpoint"
    );
  });

  it("throws when capability has no L402 endpoint", async () => {
    const mgr = new AgentManager();
    const cap = new AgentCapability({ l402Endpoint: null });

    await expect(mgr.settleViaL402(cap)).rejects.toThrow(
      "no L402 endpoint"
    );
  });
});

describe("AgentManager producer", () => {
  it("throws when creating challenge without API key", async () => {
    const mgr = new AgentManager();
    const agreement = new AgentServiceAgreement({ agreedPriceSats: 100 });

    await expect(
      mgr.createChallenge(agreement)
    ).rejects.toThrow("API key");
  });

  it("throws when verifying payment without API key", async () => {
    const mgr = new AgentManager();

    await expect(
      mgr.verifyPayment("mac", "pre")
    ).rejects.toThrow("API key");
  });
});

describe("AgentManager queryRelays", () => {
  // queryRelays() verifies signatures, so these fixtures must be genuinely
  // signed for the dedup/failure behaviour under test to be reachable.
  const QUERY_PRIVKEY =
    "3333333333333333333333333333333333333333333333333333333333333333";

  it("deduplicates events from multiple relays", async () => {
    const sameEvent = await NostrEvent.create({
      kind: 38400,
      content: "",
      tags: [],
      privateKey: QUERY_PRIVKEY,
    });

    const mgr = new AgentManager({
      relayUrls: ["wss://r1", "wss://r2"],
    });

    // Mock the internal queryRelay method by providing the same event from both relays
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([sameEvent]);

    const events = await mgr.queryRelays([{}]);
    expect(events).toHaveLength(1);
  });

  it("handles relay failures gracefully", async () => {
    const mgr = new AgentManager({
      relayUrls: ["wss://r1", "wss://r2"],
    });

    const goodEvent = await NostrEvent.create({
      kind: 1,
      content: "",
      tags: [],
      privateKey: QUERY_PRIVKEY,
    });

    vi.spyOn(mgr as any, "queryRelay").mockImplementation(
      async (url: string) => {
        if (url.includes("r1")) throw new Error("fail");
        return [goodEvent];
      }
    );

    const events = await mgr.queryRelays([{}]);
    expect(events).toHaveLength(1);
  });
});

describe("AgentManager getReputation rating range", () => {
  /** Build a raw attestation event carrying an arbitrary rating tag. */
  const attestationEvent = (id: string, rating: string) => ({
    id,
    pubkey: "subject",
    created_at: 1700000000,
    kind: 38403,
    content: "",
    tags: [
      ["p", "subject"],
      ["e", "agreement"],
      ["rating", rating],
    ],
    sig: "",
  });

  it("ignores out-of-range ratings when averaging", async () => {
    // Publishing enforces 1-5, but nothing stops a hostile agent from putting
    // any integer on the wire. A single rating=999999 must not skew the average.
    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue([
      attestationEvent("a1", "5"),
      attestationEvent("a2", "999999"),
    ]);

    const rep = await mgr.getReputation("subject");
    expect(rep.average).toBe(5);
    expect(rep.count).toBe(1);
  });

  it("ignores ratings below the valid range", async () => {
    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue([
      attestationEvent("a1", "4"),
      attestationEvent("a2", "0"),
      attestationEvent("a3", "-100"),
    ]);

    const rep = await mgr.getReputation("subject");
    expect(rep.average).toBe(4);
    expect(rep.count).toBe(1);
  });

  it("reports zero reputation when every rating is out of range", async () => {
    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue([
      attestationEvent("a1", "999999"),
    ]);

    const rep = await mgr.getReputation("subject");
    expect(rep.average).toBe(0);
    expect(rep.count).toBe(0);
    expect(rep.attestations).toEqual([]);
  });

  it("averages in-range ratings normally", async () => {
    const mgr = new AgentManager();
    vi.spyOn(mgr, "queryRelays").mockResolvedValue([
      attestationEvent("a1", "5"),
      attestationEvent("a2", "3"),
    ]);

    const rep = await mgr.getReputation("subject");
    expect(rep.average).toBe(4);
    expect(rep.count).toBe(2);
  });
});

describe("AgentManager relay event verification", () => {
  const PRIVKEY_A =
    "1111111111111111111111111111111111111111111111111111111111111111";
  const PRIVKEY_B =
    "2222222222222222222222222222222222222222222222222222222222222222";

  it("drops events whose signature does not verify", async () => {
    // A legitimately signed capability from agent A...
    const genuine = await NostrEvent.create({
      kind: 38400,
      content: "Genuine service",
      tags: [["d", "svc-genuine"]],
      privateKey: PRIVKEY_A,
    });

    // ...and a forgery: a malicious relay claims agent A published this, but
    // the signature is agent B's over a different event, so it cannot verify
    // against A's pubkey.
    const forged = await NostrEvent.create({
      kind: 38400,
      content: "Forged service",
      tags: [["d", "svc-forged"]],
      privateKey: PRIVKEY_B,
    });
    forged.pubkey = NostrEvent.pubkeyFromPrivateKey(PRIVKEY_A);

    const mgr = new AgentManager({ relayUrls: ["wss://hostile"] });
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([genuine, forged]);

    const caps = await mgr.discover();
    expect(caps).toHaveLength(1);
    expect(caps[0].serviceId).toBe("svc-genuine");
  });

  it("drops events whose id does not match their content (tampered)", async () => {
    const tampered = await NostrEvent.create({
      kind: 38400,
      content: "Original content",
      tags: [["d", "svc-tampered"]],
      privateKey: PRIVKEY_A,
    });
    // Relay rewrites the content but keeps the id/sig from the original.
    tampered.content = "Tampered content";

    const mgr = new AgentManager({ relayUrls: ["wss://hostile"] });
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([tampered]);

    const caps = await mgr.discover();
    expect(caps).toEqual([]);
  });

  it("drops unsigned events", async () => {
    const unsigned = await NostrEvent.create({
      kind: 38400,
      content: "Unsigned",
      tags: [["d", "svc-unsigned"]],
      pubkey: NostrEvent.pubkeyFromPrivateKey(PRIVKEY_A),
    });

    const mgr = new AgentManager({ relayUrls: ["wss://hostile"] });
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([unsigned]);

    const caps = await mgr.discover();
    expect(caps).toEqual([]);
  });

  it("keeps genuinely signed events", async () => {
    const genuine = await NostrEvent.create({
      kind: 38400,
      content: "Genuine service",
      tags: [["d", "svc-ok"], ["s", "ai"]],
      privateKey: PRIVKEY_A,
    });

    const mgr = new AgentManager({ relayUrls: ["wss://good"] });
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([genuine]);

    const caps = await mgr.discover();
    expect(caps).toHaveLength(1);
    expect(caps[0].serviceId).toBe("svc-ok");
    expect(caps[0].pubkey).toBe(NostrEvent.pubkeyFromPrivateKey(PRIVKEY_A));
  });

  it("drops forged attestations before they reach reputation scoring", async () => {
    const forged = await NostrEvent.create({
      kind: 38403,
      content: "",
      tags: [
        ["p", "subject"],
        ["e", "agreement"],
        ["rating", "5"],
      ],
      privateKey: PRIVKEY_B,
    });
    // Attribute the 5-star review to someone who never wrote it.
    forged.pubkey = NostrEvent.pubkeyFromPrivateKey(PRIVKEY_A);

    const mgr = new AgentManager({ relayUrls: ["wss://hostile"] });
    vi.spyOn(mgr as any, "queryRelay").mockResolvedValue([forged]);

    const rep = await mgr.getReputation("subject");
    expect(rep.count).toBe(0);
    expect(rep.average).toBe(0);
  });
});
