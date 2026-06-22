/**
 * Agent Capability client for the Lightning Enable API.
 *
 * Consumer side: `invoke` a paid capability (handles the 402 -> pay -> retry flow),
 * `issue`/`delegate` scoped credentials. Provider side: `protect` an endpoint so it
 * requires an L402 payment, backed by Lightning Enable for challenge + verification.
 */

import { L402ProducerClient } from "../l402/producer.js";
import type { PayInvoiceCallback } from "../l402/client.js";

const DEFAULT_BASE_URL = "https://api.lightningenable.com";
const USER_AGENT = "LE-Agent-SDK-TS";

export interface CapabilityClientOptions {
  /** Lightning Enable merchant API key. */
  apiKey: string;
  /** API base URL. Defaults to https://api.lightningenable.com. */
  baseUrl?: string;
  /** Pays a BOLT11 invoice and returns the hex preimage. Required for `invoke` to settle a 402. */
  payInvoice?: PayInvoiceCallback;
}

export interface InvokeResult {
  invocationId?: number;
  output?: unknown;
}

export class ApprovalRequiredError extends Error {
  readonly approvalRequestId: number;
  constructor(approvalRequestId: number) {
    super("This spend requires human approval; retry once approved.");
    this.name = "ApprovalRequiredError";
    this.approvalRequestId = approvalRequestId;
  }
}

export interface IssueCredentialOptions {
  principalId: string;
  capability: string;
  path?: string;
  maxTotalSpendSats?: number;
  maxPerCallSats?: number;
  delegationDepth?: number;
  expiresInSeconds?: number;
}

export interface DelegateCredentialOptions {
  parentCredentialId: number;
  parentMacaroon: string;
  /** Principal id of the subagent the narrowed credential is issued to. */
  to: string;
  capability?: string;
  path?: string;
  maxSpendSats?: number;
  expiresInSeconds?: number;
  purpose?: string;
}

export interface CredentialResult {
  credentialId: number;
  macaroon: string;
}

export class CapabilityClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly payInvoice?: PayInvoiceCallback;

  constructor(options: CapabilityClientOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.payInvoice = options.payInvoice;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "X-API-Key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...extra,
    };
  }

  /**
   * Invoke a paid capability as the given agent. Handles the L402 flow: an unpaid request gets a
   * 402 + invoice, which is paid via the `payInvoice` callback, then retried with the L402 token.
   * Throws {@link ApprovalRequiredError} when the spend is gated on human approval (HTTP 202).
   */
  async invoke(slug: string, agentId: number, input?: unknown): Promise<InvokeResult> {
    const url = `${this.baseUrl}/api/capabilities/${encodeURIComponent(slug)}/invoke?agentId=${agentId}`;
    const body = input === undefined ? undefined : JSON.stringify(input);

    const first = await fetch(url, { method: "POST", headers: this.headers(), body });

    if (first.status === 200) {
      return (await first.json()) as InvokeResult;
    }
    if (first.status === 202) {
      const data = (await safeJson(first)) ?? {};
      throw new ApprovalRequiredError(Number((data as Record<string, unknown>).approvalRequestId ?? 0));
    }
    if (first.status !== 402) {
      throw new Error(await errorMessage(first));
    }

    // 402: settle the invoice and retry with the L402 token.
    const challenge = (await first.json()) as { macaroon?: string; invoice?: string };
    if (!challenge.macaroon || !challenge.invoice) {
      throw new Error("Malformed 402 challenge: missing macaroon or invoice.");
    }
    if (!this.payInvoice) {
      throw new Error("invoke() received a 402 but no payInvoice callback was configured.");
    }

    const preimage = await this.payInvoice(challenge.invoice);
    const retry = await fetch(url, {
      method: "POST",
      headers: this.headers({ Authorization: `L402 ${challenge.macaroon}:${preimage}` }),
      body,
    });

    if (retry.status === 200) {
      return (await retry.json()) as InvokeResult;
    }
    throw new Error(await errorMessage(retry));
  }

  /** Issue a fresh scoped credential for a principal (the merchant's authority backs it). */
  async issue(options: IssueCredentialOptions): Promise<CredentialResult> {
    const res = await fetch(`${this.baseUrl}/api/credentials/issue`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        principalId: options.principalId,
        capability: options.capability,
        path: options.path,
        maxTotalSpendSats: options.maxTotalSpendSats,
        maxPerCallSats: options.maxPerCallSats,
        delegationDepth: options.delegationDepth ?? 0,
        expiresInSeconds: options.expiresInSeconds ?? 3600,
      }),
    });
    if (res.status !== 200) throw new Error(await errorMessage(res));
    return (await res.json()) as CredentialResult;
  }

  /**
   * Delegate a strictly narrower credential to a subagent. The server enforces that the result can
   * only restrict the parent's authority — appended caveats can never widen it.
   */
  async delegate(options: DelegateCredentialOptions): Promise<CredentialResult> {
    const res = await fetch(`${this.baseUrl}/api/credentials/delegate`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        parentCredentialId: options.parentCredentialId,
        parentMacaroon: options.parentMacaroon,
        delegatePrincipalId: options.to,
        capability: options.capability,
        path: options.path,
        maxTotalSpendSats: options.maxSpendSats,
        expiresInSeconds: options.expiresInSeconds,
        purpose: options.purpose,
      }),
    });
    if (res.status !== 200) throw new Error(await errorMessage(res));
    return (await res.json()) as CredentialResult;
  }

  /** Revoke a credential server-side; takes effect at the next verification. */
  async revoke(credentialId: number): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/credentials/${credentialId}/revoke`, {
      method: "POST",
      headers: this.headers(),
    });
    if (res.status !== 200) throw new Error(await errorMessage(res));
  }
}

export interface ProtectOptions<TInput> {
  apiKey: string;
  baseUrl?: string;
  /** Capability slug / resource identifier used as the L402 challenge resource. */
  capability: string;
  priceSats: number;
  /** Runs once payment is verified; its return value is JSON-serialized as the response body. */
  handler: (input: TInput) => Promise<unknown> | unknown;
}

/**
 * Wrap a handler so the resulting Web `fetch` handler requires an L402 payment: an unpaid request
 * returns 402 + invoice + macaroon; a request carrying `Authorization: L402 <macaroon>:<preimage>`
 * is verified with Lightning Enable and, if valid, runs the handler. Works in any Web-standard
 * runtime (Next.js route handlers, Deno, Bun, workers).
 */
export function protect<TInput = unknown>(
  options: ProtectOptions<TInput>
): (request: Request) => Promise<Response> {
  const producer = new L402ProducerClient({ leApiKey: options.apiKey, leApiBaseUrl: options.baseUrl });

  return async (request: Request): Promise<Response> => {
    const auth = request.headers.get("authorization") ?? "";
    const match = /^L402\s+([^:\s]+):([0-9a-f]{64})$/i.exec(auth.trim());

    if (!match) {
      const challenge = await producer.createChallenge(options.capability, options.priceSats);
      if (!challenge.success || !challenge.macaroon || !challenge.invoice) {
        return json({ error: challenge.error ?? "Failed to create challenge." }, 502);
      }
      return new Response(
        JSON.stringify({ error: "payment_required", amount_sats: options.priceSats, invoice: challenge.invoice }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `L402 macaroon="${challenge.macaroon}", invoice="${challenge.invoice}"`,
          },
        }
      );
    }

    const macaroon = match[1];
    const preimage = match[2];
    const verification = await producer.verifyPayment(macaroon, preimage);
    if (!verification.success || !verification.valid) {
      return json({ error: verification.error ?? "Payment verification failed." }, 402);
    }

    let input: TInput;
    try {
      input = (request.body ? await request.json() : undefined) as TInput;
    } catch {
      input = undefined as TInput;
    }

    const output = await options.handler(input);
    return json(output ?? {}, 200);
  };
}

async function safeJson(res: Response): Promise<unknown | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function errorMessage(res: Response): Promise<string> {
  const data = (await safeJson(res)) as Record<string, unknown> | null;
  return (
    (data?.error as string) ??
    (data?.message as string) ??
    `Lightning Enable API returned ${res.status}`
  );
}

function json(payload: unknown, status: number): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
