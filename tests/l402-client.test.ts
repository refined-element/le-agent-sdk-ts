/**
 * Tests for L402 client -- challenge parsing and utilities.
 */

import { describe, it, expect } from "vitest";
import {
  parseL402Challenge,
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
