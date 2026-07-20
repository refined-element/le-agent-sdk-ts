/**
 * Port-drift conformance tests (typescript port).
 *
 * Runs the shared golden vectors in `conformance/vectors/` through THIS port's
 * own implementation. The same vectors run in the python and .NET ports; any
 * port that diverges from the golden fails its own CI, so drift between the
 * three ports is caught automatically instead of by manual cross-reading.
 *
 * See `conformance/README.md` for the design, the sync mechanism, and how to
 * extend the suite.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { AgentCapability, AgentManager, NostrEvent } from "../src/index.js";

// --- Vector loading ---------------------------------------------------------

const confPath = (...parts: string[]): string =>
  fileURLToPath(new URL("../conformance/" + parts.join("/"), import.meta.url));

const loadVectors = (file: string): any =>
  JSON.parse(readFileSync(confPath("vectors", file), "utf8"));

const price = loadVectors("price-tag.json");
const floor = loadVectors("negotiable-floor.json");
const discover = loadVectors("discover-resilience.json");

/** Parse a capability through the entrypoint the vectors target. */
function parseCapability(tags: string[][]): AgentCapability {
  return AgentCapability.fromNostrEvent({
    id: "conformance",
    pubkey: "p",
    created_at: 1,
    kind: AgentCapability.KIND,
    content: "",
    tags,
  });
}

// --- Sync guard -------------------------------------------------------------

describe("conformance: sync guard", () => {
  it("local vectors match the shared CHECKSUMS", () => {
    // CHECKSUMS is identical across all three repos, so this transitively pins
    // the typescript copy to the python and .NET copies. Hashing is over
    // LF-normalized bytes so a CRLF checkout does not spuriously fail.
    const expected: Record<string, string> = {};
    for (const line of readFileSync(confPath("CHECKSUMS"), "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [digest, name] = trimmed.split(/\s+/);
      expected[name] = digest;
    }
    expect(Object.keys(expected).length).toBeGreaterThan(0);

    for (const name of ["price-tag.json", "negotiable-floor.json", "discover-resilience.json"]) {
      const normalized = readFileSync(confPath("vectors", name), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/\r/g, "\n");
      const got = createHash("sha256").update(normalized, "utf8").digest("hex");
      expect(got, `${name} does not match shared CHECKSUMS`).toBe(expected[name]);
    }
  });
});

// --- price-tag parsing ------------------------------------------------------

describe("conformance: price-tag", () => {
  it.each(price.vectors)("$name", (vector: any) => {
    const { outcome } = vector.expect;

    if (outcome === "reject") {
      expect(() => parseCapability(vector.tags)).toThrow();
      return;
    }

    const cap = parseCapability(vector.tags);

    if (outcome === "no-price") {
      expect(cap.pricing).toHaveLength(0);
      return;
    }

    expect(outcome).toBe("ok");
    expect(cap.pricing[0].amount).toBe(vector.expect.priceSats);
    if (vector.expect.unit !== undefined) expect(cap.pricing[0].unit).toBe(vector.expect.unit);
    if (vector.expect.model !== undefined) expect(cap.pricing[0].model).toBe(vector.expect.model);
  });
});

// --- negotiable-floor parsing ----------------------------------------------

describe("conformance: negotiable-floor", () => {
  it.each(floor.vectors)("$name", (vector: any) => {
    const { outcome } = vector.expect;

    if (outcome === "reject") {
      expect(() => parseCapability(vector.tags)).toThrow();
      return;
    }

    expect(outcome).toBe("ok");
    const cap = parseCapability(vector.tags);
    expect(cap.negotiable).toBe(vector.expect.negotiable);
    expect(cap.minPriceSats).toBe(vector.expect.minPriceSats);
  });
});

// --- discover() batch resilience (ledger #41) -------------------------------

const PRIV_A = "1111111111111111111111111111111111111111111111111111111111111111";
const PRIV_B = "2222222222222222222222222222222222222222222222222222222222222222";
const PRIV_POISON = "3333333333333333333333333333333333333333333333333333333333333333";

const signedCap = (dTag: string, priceAmount: string, priv: string) =>
  NostrEvent.create({
    kind: AgentCapability.KIND,
    content: "valid",
    tags: [
      ["d", dTag],
      ["price", priceAmount],
    ],
    privateKey: priv,
  });

/** Inject a raw per-relay payload list and run the real discover pipeline. */
async function runDiscover(payloads: unknown[]): Promise<AgentCapability[]> {
  const mgr = new AgentManager();
  vi.spyOn(mgr as any, "queryRelay").mockResolvedValue(payloads);
  return mgr.discover();
}

describe("conformance: discover resilience", () => {
  it("shared manifest scenarios are all covered", () => {
    const names = new Set(discover.scenarios.map((s: any) => s.name));
    expect(names).toEqual(
      new Set(["bad-price", "missing-committed-field", "non-dict-payload"])
    );
    expect(discover.expectedSurvivors).toBe(2);
  });

  const survivors = discover.expectedSurvivors;

  it("bad-price: one unparseable price does not abort the batch (loud skip)", async () => {
    // Dropped at the per-event capability parse. The poison event is genuinely
    // signed so it passes authenticity and reaches the parse that throws.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const [a, poison, b] = await Promise.all([
        signedCap("svc-a", "100", PRIV_A),
        signedCap("svc-poison", "abc", PRIV_POISON),
        signedCap("svc-b", "200", PRIV_B),
      ]);
      const caps = await runDiscover([a, poison, b]);
      expect(caps).toHaveLength(survivors);
      expect(caps.map((c) => c.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
      // Fail closed, LOUDLY: the parse skip is warned.
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("missing-committed-field: an unauthenticatable payload does not abort the batch", async () => {
    // Dropped at the authenticity check in queryRelays (missing pubkey/sig etc.),
    // before it is ever trusted. The two valid events are genuinely signed.
    const [a, b] = await Promise.all([
      signedCap("svc-a", "100", PRIV_A),
      signedCap("svc-b", "200", PRIV_B),
    ]);
    const poison = { id: "bad-missing", kind: AgentCapability.KIND };
    const caps = await runDiscover([a, poison, b]);
    expect(caps).toHaveLength(survivors);
    expect(caps.map((c) => c.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
  });

  it("non-dict-payload: a non-object relay payload does not abort the batch", async () => {
    // Dropped at the relay merge in queryRelays (a bare string has no usable id).
    const [a, b] = await Promise.all([
      signedCap("svc-a", "100", PRIV_A),
      signedCap("svc-b", "200", PRIV_B),
    ]);
    const caps = await runDiscover([a, "not-a-dict", b]);
    expect(caps).toHaveLength(survivors);
    expect(caps.map((c) => c.serviceId).sort()).toEqual(["svc-a", "svc-b"]);
  });
});
