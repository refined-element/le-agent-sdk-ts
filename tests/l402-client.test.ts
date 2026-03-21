/**
 * Tests for L402 client -- challenge parsing, MPP support, and utilities.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseL402Challenge,
  parseMppChallenge,
  parsePaymentChallenge,
  decodeInvoiceAmountSats,
  validatePreimage,
  L402Client,
} from "../src/index.js";

describe("parseL402Challenge", () => {
  it("parses quoted format", () => {
    const headers = {
      "WWW-Authenticate": 'L402 macaroon="mac123", invoice="lnbc1..."',
    };
    const challenge = parseL402Challenge(headers);
    expect(challenge).not.toBeNull();
    expect(challenge!.macaroon).toBe("mac123");
    expect(challenge!.invoice).toBe("lnbc1...");
  });

  it("parses unquoted format", () => {
    const headers = {
      "WWW-Authenticate": "L402 macaroon=mac123, invoice=lnbc1...",
    };
    const challenge = parseL402Challenge(headers);
    expect(challenge).not.toBeNull();
    expect(challenge!.macaroon).toBe("mac123");
    expect(challenge!.invoice).toBe("lnbc1...");
  });

  it("parses legacy LSAT format", () => {
    const headers = {
      "WWW-Authenticate": 'LSAT macaroon="mac_legacy", invoice="lnbc_legacy"',
    };
    const challenge = parseL402Challenge(headers);
    expect(challenge).not.toBeNull();
    expect(challenge!.macaroon).toBe("mac_legacy");
    expect(challenge!.invoice).toBe("lnbc_legacy");
  });

  it("handles case-insensitive header names", () => {
    const headers = {
      "www-authenticate": 'L402 macaroon="mac_lower", invoice="lnbc_lower"',
    };
    const challenge = parseL402Challenge(headers);
    expect(challenge).not.toBeNull();
    expect(challenge!.macaroon).toBe("mac_lower");
  });

  it("returns null when no WWW-Authenticate", () => {
    const headers = { "Content-Type": "application/json" };
    expect(parseL402Challenge(headers)).toBeNull();
  });

  it("returns null for empty WWW-Authenticate", () => {
    const headers = { "WWW-Authenticate": "" };
    expect(parseL402Challenge(headers)).toBeNull();
  });

  it("returns null for non-L402 challenge", () => {
    const headers = { "WWW-Authenticate": "Bearer realm=example" };
    expect(parseL402Challenge(headers)).toBeNull();
  });
});

describe("decodeInvoiceAmountSats", () => {
  it("decodes milli-BTC amounts", () => {
    // lnbc1m... = 1 mBTC = 100,000 sats
    expect(decodeInvoiceAmountSats("lnbc1m1rest")).toBe(100000);
  });

  it("decodes micro-BTC amounts", () => {
    // lnbc100u... = 100 uBTC = 10,000 sats
    expect(decodeInvoiceAmountSats("lnbc100u1rest")).toBe(10000);
  });

  it("decodes nano-BTC amounts", () => {
    // lnbc100000n... = 100000 nBTC = 0.0001 BTC = 10,000 sats
    expect(decodeInvoiceAmountSats("lnbc100000n1rest")).toBe(10000);
    // lnbc1000000000n... = 1 BTC = 100,000,000 sats
    expect(decodeInvoiceAmountSats("lnbc1000000000n1rest")).toBe(100000000);
  });

  it("returns undefined for unparseable invoice", () => {
    expect(decodeInvoiceAmountSats("not-an-invoice")).toBeUndefined();
  });

  it("strips lightning: prefix", () => {
    expect(decodeInvoiceAmountSats("lightning:lnbc1m1rest")).toBe(100000);
  });

  it("handles testnet invoices", () => {
    // lntb = testnet
    expect(decodeInvoiceAmountSats("lntb500u1rest")).toBe(50000);
  });
});

describe("validatePreimage", () => {
  it("validates correct 64-char hex", () => {
    const valid = "a".repeat(64);
    expect(validatePreimage(valid)).toBe(true);
  });

  it("rejects wrong length", () => {
    expect(validatePreimage("aabb")).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(validatePreimage("g".repeat(64))).toBe(false);
  });

  it("rejects non-string", () => {
    // @ts-expect-error testing invalid input
    expect(validatePreimage(123)).toBe(false);
  });
});

describe("parseMppChallenge", () => {
  it("parses valid Payment header with all fields", () => {
    const header =
      'Payment realm="api.example.com", method="lightning", invoice="lnbc100n1pjtest", amount="100", currency="sat"';
    const result = parseMppChallenge(header);
    expect(result.invoice).toBe("lnbc100n1pjtest");
    expect(result.amount).toBe("100");
    expect(result.realm).toBe("api.example.com");
  });

  it("rejects non-lightning method", () => {
    expect(() =>
      parseMppChallenge('Payment method="stripe", invoice="lnbc100n1pjtest"')
    ).toThrow();
  });

  it("rejects missing invoice", () => {
    expect(() =>
      parseMppChallenge('Payment method="lightning", amount="100"')
    ).toThrow();
  });

  it("parses minimal header (invoice only, no amount/realm)", () => {
    const result = parseMppChallenge(
      'Payment method="lightning", invoice="lnbc100n1pjtest"'
    );
    expect(result.invoice).toBe("lnbc100n1pjtest");
    expect(result.amount).toBeUndefined();
    expect(result.realm).toBeUndefined();
  });

  it("rejects empty string", () => {
    expect(() => parseMppChallenge("")).toThrow();
  });

  it("rejects Bearer token", () => {
    expect(() => parseMppChallenge("Bearer some-token")).toThrow();
  });
});

describe("parsePaymentChallenge", () => {
  it("prefers L402 when present", () => {
    const header = 'L402 macaroon="abc", invoice="lnbc100n1pjtest"';
    const result = parsePaymentChallenge(header);
    expect("macaroon" in result).toBe(true);
    expect((result as { macaroon: string }).macaroon).toBe("abc");
  });

  it("falls back to MPP when no L402", () => {
    const header =
      'Payment method="lightning", invoice="lnbc100n1pjtest", amount="50"';
    const result = parsePaymentChallenge(header);
    expect("macaroon" in result).toBe(false);
    expect(result.invoice).toBe("lnbc100n1pjtest");
    expect((result as { amount?: string }).amount).toBe("50");
  });

  it("throws on invalid header (neither L402 nor MPP)", () => {
    expect(() => parsePaymentChallenge("Bearer token")).toThrow(
      /No valid L402 or MPP challenge/
    );
  });

  it("throws on empty header", () => {
    expect(() => parsePaymentChallenge("")).toThrow();
  });

  it("parses legacy LSAT as L402", () => {
    const header = 'LSAT macaroon="legacymac", invoice="lnbc_legacy"';
    const result = parsePaymentChallenge(header);
    expect("macaroon" in result).toBe(true);
    expect((result as { macaroon: string }).macaroon).toBe("legacymac");
  });
});

describe("L402Client", () => {
  it("initializes with defaults", () => {
    const client = new L402Client();
    // Should not throw
    expect(client).toBeDefined();
  });

  it("initializes with cache", () => {
    const cache = new Map([["mac1", "preimage1"]]);
    const client = new L402Client({ preimageCache: cache });
    expect(client).toBeDefined();
  });

  it("initializes with maxAmountSats", () => {
    const client = new L402Client({ maxAmountSats: 1000 });
    expect(client).toBeDefined();
  });
});

// --- Integration tests with mocked fetch ---

const VALID_PREIMAGE = "a".repeat(64);
const L402_HEADER =
  'L402 macaroon="testmac123", invoice="lnbc100u1rest"';
const MPP_HEADER =
  'Payment method="lightning", invoice="lnbc100u1rest", amount="100"';

/** Helper: create a mock Response with the given status and headers. */
function mockResponse(
  status: number,
  headersInit?: Record<string, string>,
  bodyText?: string
): Response {
  const h = new Headers(headersInit ?? {});
  return new Response(bodyText ?? "", { status, headers: h });
}

describe("L402Client.access() - L402 vs MPP challenge selection", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("selects L402 challenge and builds correct Authorization header", async () => {
    // First call returns 402 with L402 challenge
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    // Second call (after payment) returns 200
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({ payInvoiceCallback: payCallback });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    expect(payCallback).toHaveBeenCalledWith("lnbc100u1rest");

    // Verify the Authorization header on the retry request
    const retryCall = fetchSpy.mock.calls[1];
    const authHeader = retryCall[1].headers["Authorization"];
    expect(authHeader).toBe(`L402 testmac123:${VALID_PREIMAGE}`);
  });

  it("selects MPP challenge and builds correct Authorization header", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": MPP_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({ payInvoiceCallback: payCallback });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);

    const retryCall = fetchSpy.mock.calls[1];
    const authHeader = retryCall[1].headers["Authorization"];
    expect(authHeader).toBe(
      `Payment method="lightning", preimage="${VALID_PREIMAGE}"`
    );
  });

  it("returns 402 response when no pay callback is configured", async () => {
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );

    const client = new L402Client(); // no payInvoiceCallback
    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(402);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("returns non-402 responses directly without payment", async () => {
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn();
    const client = new L402Client({ payInvoiceCallback: payCallback });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    expect(payCallback).not.toHaveBeenCalled();
  });
});

describe("L402Client.access() - cache hit skips payInvoiceCallback", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses cached preimage for L402 (keyed by macaroon) and skips pay", async () => {
    const cache = new Map([["testmac123", VALID_PREIMAGE]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn();
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      preimageCache: cache,
    });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    expect(payCallback).not.toHaveBeenCalled();
  });

  it("uses cached preimage for MPP (keyed by invoice) and skips pay", async () => {
    const cache = new Map([["lnbc100u1rest", VALID_PREIMAGE]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": MPP_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn();
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      preimageCache: cache,
    });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    expect(payCallback).not.toHaveBeenCalled();
  });
});

describe("L402Client.access() - invalid cached preimages are evicted", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("evicts invalid cached preimage and pays fresh", async () => {
    const cache = new Map([["testmac123", "not-valid-hex"]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      preimageCache: cache,
    });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    // Invalid cached value should trigger a fresh payment
    expect(payCallback).toHaveBeenCalledWith("lnbc100u1rest");
    // Cache should now have the valid preimage
    expect(cache.get("testmac123")).toBe(VALID_PREIMAGE);
  });

  it("evicts too-short cached preimage and pays fresh", async () => {
    const cache = new Map([["lnbc100u1rest", "abcd"]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": MPP_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      preimageCache: cache,
    });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    expect(payCallback).toHaveBeenCalled();
  });

  it("normalizes cached preimage with leading/trailing whitespace", async () => {
    const paddedPreimage = `  ${VALID_PREIMAGE}  `;
    const cache = new Map([["testmac123", paddedPreimage]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn();
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      preimageCache: cache,
    });

    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
    // Should NOT have called pay because trimmed value is valid
    expect(payCallback).not.toHaveBeenCalled();
    // Cache should be updated with trimmed value
    expect(cache.get("testmac123")).toBe(VALID_PREIMAGE);
  });
});

describe("L402Client.payAndAccess() - cache validation", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses valid cached preimage and skips payment", async () => {
    const cache = new Map([["testmac123", VALID_PREIMAGE]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn();
    const client = new L402Client({ preimageCache: cache });

    const res = await client.payAndAccess(
      "https://example.com/resource",
      payCallback
    );
    expect(res.status).toBe(200);
    expect(payCallback).not.toHaveBeenCalled();
  });

  it("evicts invalid cached preimage and pays fresh in payAndAccess", async () => {
    const cache = new Map([["testmac123", "invalid"]]);

    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": L402_HEADER })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({ preimageCache: cache });

    const res = await client.payAndAccess(
      "https://example.com/resource",
      payCallback
    );
    expect(res.status).toBe(200);
    expect(payCallback).toHaveBeenCalledWith("lnbc100u1rest");
  });
});

describe("L402Client.access() - MPP amount strict validation", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects MPP amount with non-digit suffix (e.g. '10sat')", async () => {
    const header =
      'Payment method="lightning", invoice="lnbc1rest", amount="10sat"';
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": header })
    );
    // Non-strict amount "10sat" should be ignored; falls back to BOLT-11 decode.
    // lnbc1rest has no valid amount, so maxAmountSats check is skipped.
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      maxAmountSats: 5,
    });

    // Should NOT throw because the malformed amount is ignored (falls back to BOLT-11
    // which returns undefined for "lnbc1rest", so no amount to enforce)
    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
  });

  it("rejects MPP amount with hex prefix (e.g. '0x10')", async () => {
    const header =
      'Payment method="lightning", invoice="lnbc1rest", amount="0x10"';
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": header })
    );
    fetchSpy.mockResolvedValueOnce(mockResponse(200, {}, "ok"));

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      maxAmountSats: 5,
    });

    // "0x10" fails /^[0-9]+$/ test, so it's ignored
    const res = await client.access("https://example.com/resource");
    expect(res.status).toBe(200);
  });

  it("enforces maxAmountSats with valid strict MPP amount", async () => {
    const header =
      'Payment method="lightning", invoice="lnbc1rest", amount="200"';
    fetchSpy.mockResolvedValueOnce(
      mockResponse(402, { "www-authenticate": header })
    );

    const payCallback = vi.fn().mockResolvedValue(VALID_PREIMAGE);
    const client = new L402Client({
      payInvoiceCallback: payCallback,
      maxAmountSats: 100,
    });

    await expect(
      client.access("https://example.com/resource")
    ).rejects.toThrow(/exceeds maximum/);
    expect(payCallback).not.toHaveBeenCalled();
  });
});
