/**
 * Tests for the Agent Capability client: invoke (402 -> pay -> retry), issue/delegate, and protect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CapabilityClient, ApprovalRequiredError, protect } from "../src/index.js";

const PREIMAGE = "a".repeat(64);

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("CapabilityClient.invoke", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns output directly on 200", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ invocationId: 1, output: "ok" }));
    const client = new CapabilityClient({ apiKey: "k" });

    const result = await client.invoke("company.enrich", 7);

    expect(result.output).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pays the invoice on 402 and retries with the L402 token", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ macaroon: "mac", invoice: "lnbc1" }, 402))
      .mockResolvedValueOnce(jsonResponse({ invocationId: 2, output: "enriched" }));
    const payInvoice = vi.fn().mockResolvedValue(PREIMAGE);
    const client = new CapabilityClient({ apiKey: "k", payInvoice });

    const result = await client.invoke("company.enrich", 7, { domain: "example.com" });

    expect(result.output).toBe("enriched");
    expect(payInvoice).toHaveBeenCalledWith("lnbc1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const retryInit = fetchMock.mock.calls[1][1] as RequestInit;
    expect((retryInit.headers as Record<string, string>).Authorization).toBe(`L402 mac:${PREIMAGE}`);
  });

  it("throws when a 402 arrives but no payInvoice is configured", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ macaroon: "mac", invoice: "lnbc1" }, 402));
    const client = new CapabilityClient({ apiKey: "k" });

    await expect(client.invoke("company.enrich", 7)).rejects.toThrow(/payInvoice/);
  });

  it("throws ApprovalRequiredError on 202", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "approval_required", approvalRequestId: 42 }, 202));
    const client = new CapabilityClient({ apiKey: "k" });

    await expect(client.invoke("company.enrich", 7)).rejects.toMatchObject({
      name: "ApprovalRequiredError",
      approvalRequestId: 42,
    });
  });
});

describe("CapabilityClient credentials", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("issue posts and returns the credential", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ credentialId: 1, macaroon: "rootmac" }));
    const client = new CapabilityClient({ apiKey: "k" });

    const cred = await client.issue({ principalId: "agent-1", capability: "research:read", delegationDepth: 2 });

    expect(cred).toEqual({ credentialId: 1, macaroon: "rootmac" });
    expect(fetchMock.mock.calls[0][0]).toContain("/api/credentials/issue");
  });

  it("delegate maps options to the request body and returns the child", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ credentialId: 2, macaroon: "childmac" }));
    const client = new CapabilityClient({ apiKey: "k" });

    const child = await client.delegate({
      parentCredentialId: 1,
      parentMacaroon: "rootmac",
      to: "subagent",
      capability: "research:read",
      maxSpendSats: 300,
      expiresInSeconds: 600,
      purpose: "parse 10-K",
    });

    expect(child.credentialId).toBe(2);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.delegatePrincipalId).toBe("subagent");
    expect(body.maxTotalSpendSats).toBe(300);
  });
});

describe("protect", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns 402 with a WWW-Authenticate challenge when unpaid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ macaroon: "mac", invoice: "lnbc1", paymentHash: "h" }));
    const handler = protect({ apiKey: "k", capability: "company.enrich", priceSats: 100, handler: async () => ({ ok: true }) });

    const res = await handler(new Request("https://x/enrich", { method: "POST" }));

    expect(res.status).toBe(402);
    expect(res.headers.get("WWW-Authenticate")).toContain("macaroon=\"mac\"");
  });

  it("verifies the token and runs the handler when paid", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, valid: true }));
    const handler = protect<{ domain: string }>({
      apiKey: "k",
      capability: "company.enrich",
      priceSats: 100,
      handler: async (input) => ({ enriched: input.domain }),
    });

    const res = await handler(new Request("https://x/enrich", {
      method: "POST",
      headers: { Authorization: `L402 mac:${PREIMAGE}`, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "example.com" }),
    }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enriched: "example.com" });
  });

  it("returns 402 when verification fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ success: true, valid: false, error: "bad preimage" }));
    const handler = protect({ apiKey: "k", capability: "company.enrich", priceSats: 100, handler: async () => ({ ok: true }) });

    const res = await handler(new Request("https://x/enrich", {
      method: "POST",
      headers: { Authorization: `L402 mac:${PREIMAGE}` },
    }));

    expect(res.status).toBe(402);
  });
});
