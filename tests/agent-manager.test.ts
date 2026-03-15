/**
 * Tests for AgentManager -- basic flows with mocked relay/HTTP.
 */

import { describe, it, expect, vi } from "vitest";
import {
  AgentManager,
  AgentCapability,
  AgentPricing,
  AgentServiceAgreement,
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
  it("deduplicates events from multiple relays", async () => {
    const sameEvent = {
      id: "dup1",
      pubkey: "pub",
      created_at: 1,
      kind: 38400,
      content: "",
      tags: [],
    };

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

    vi.spyOn(mgr as any, "queryRelay").mockImplementation(
      async (url: string) => {
        if (url.includes("r1")) throw new Error("fail");
        return [
          {
            id: "ev1",
            pubkey: "p",
            created_at: 1,
            kind: 1,
            content: "",
            tags: [],
          },
        ];
      }
    );

    const events = await mgr.queryRelays([{}]);
    expect(events).toHaveLength(1);
  });
});
