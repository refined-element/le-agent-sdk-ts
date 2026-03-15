/**
 * L402 HTTP client for agent service settlement (consumer side).
 *
 * Handles automatic L402 challenge parsing and payment retry flow.
 */

/** Parsed L402 challenge from a WWW-Authenticate header. */
export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/**
 * Pattern for parsing L402/LSAT challenges from WWW-Authenticate headers.
 * Supports both quoted and unquoted formats, and both L402 and legacy LSAT prefixes.
 */
const CHALLENGE_RE =
  /(?:L402|LSAT)\s+macaroon="?([^",\s]+)"?\s*,\s*invoice="?([^",\s]+)"?/i;

/**
 * Extract an L402 challenge from response headers.
 * Returns the parsed challenge or null if not found.
 */
export function parseL402Challenge(
  headers: Record<string, string>
): L402Challenge | null {
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v;
  }

  const wwwAuth = lowerHeaders["www-authenticate"] ?? "";
  if (!wwwAuth) return null;

  const match = CHALLENGE_RE.exec(wwwAuth);
  if (!match) return null;

  return {
    macaroon: match[1].trim(),
    invoice: match[2].trim(),
  };
}

/** Callback type for paying a Lightning invoice. Returns the preimage hex. */
export type PayInvoiceCallback = (invoice: string) => Promise<string>;

export interface L402ClientOptions {
  /** Async function to pay an invoice. Returns hex preimage. */
  payInvoiceCallback?: PayInvoiceCallback;
  /** Cache of macaroon -> preimage for reuse. */
  preimageCache?: Map<string, string>;
  /** Maximum payment amount in satoshis. */
  maxAmountSats?: number;
}

/**
 * Decode the amount in satoshis from a BOLT-11 invoice string.
 * Returns undefined if the amount cannot be parsed.
 */
export function decodeInvoiceAmountSats(invoice: string): number | undefined {
  let inv = invoice.toLowerCase();
  if (inv.startsWith("lightning:")) inv = inv.substring(10);

  const match = /^ln\w+?(\d+)([munp])1/.exec(inv);
  if (!match) return undefined;

  const amountNum = parseInt(match[1], 10);
  const multiplier = match[2];

  const btcMultipliers: Record<string, number> = {
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
  };

  const btcAmount = amountNum * btcMultipliers[multiplier];
  return Math.round(btcAmount * 1e8);
}

/**
 * Validate that a preimage is a 64-character hex string.
 */
export function validatePreimage(preimage: string): boolean {
  if (typeof preimage !== "string" || preimage.length !== 64) return false;
  return /^[0-9a-f]{64}$/i.test(preimage);
}

/**
 * Async HTTP client with L402 payment support.
 *
 * For full auto-payment, configure with a payInvoiceCallback.
 * Otherwise, challenges are returned via the 402 response for external handling.
 */
export class L402Client {
  private payCallback?: PayInvoiceCallback;
  private cache: Map<string, string>;
  private maxAmountSats?: number;

  constructor(options: L402ClientOptions = {}) {
    this.payCallback = options.payInvoiceCallback;
    this.cache = options.preimageCache ?? new Map();
    this.maxAmountSats = options.maxAmountSats;
  }

  /**
   * Access an L402-protected resource.
   *
   * If a 402 is received and a pay callback is configured, the invoice
   * is paid and the request retried with L402 credentials.
   */
  async access(
    url: string,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
      maxAmountSats?: number;
    }
  ): Promise<Response> {
    const method = options?.method ?? "GET";
    const headers = { ...(options?.headers ?? {}) };
    const body = options?.body;

    const response = await fetch(url, { method, headers, body });

    if (response.status !== 402) return response;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const challenge = parseL402Challenge(responseHeaders);
    if (!challenge) return response;

    if (!this.payCallback) return response;

    // Check invoice amount against limit
    const effectiveMax = options?.maxAmountSats ?? this.maxAmountSats;
    if (effectiveMax !== undefined) {
      const invoiceSats = decodeInvoiceAmountSats(challenge.invoice);
      if (invoiceSats !== undefined && invoiceSats > effectiveMax) {
        throw new Error(
          `Invoice amount (${invoiceSats} sats) exceeds maximum allowed ` +
            `(${effectiveMax} sats). Invoice: ${challenge.invoice.substring(0, 40)}...`
        );
      }
    }

    // Pay the invoice
    let preimage: string;
    try {
      preimage = await this.payCallback(challenge.invoice);
    } catch (err) {
      throw new Error(
        `Payment callback failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    // Validate preimage format
    if (!validatePreimage(preimage)) {
      throw new Error(
        `Invalid preimage from payment callback: expected 64-character hex string, ` +
          `got length ${typeof preimage === "string" ? preimage.length : "N/A"}`
      );
    }

    this.cache.set(challenge.macaroon, preimage);

    // Retry with L402 credentials (with retry+backoff)
    headers["Authorization"] = `L402 ${challenge.macaroon}:${preimage}`;
    const maxRetries = 3;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const retryResponse = await fetch(url, { method, headers, body });
        return retryResponse;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        if (attempt < maxRetries - 1) {
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
    }

    throw new Error(
      `Payment succeeded (preimage: ${preimage}) but all ${maxRetries} ` +
        `authenticated retries failed: ${lastErr?.message}`
    );
  }

  /**
   * Full L402 flow: request, get 402, pay invoice, retry with token.
   */
  async payAndAccess(
    url: string,
    payInvoiceCallback: PayInvoiceCallback,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<Response> {
    const method = options?.method ?? "GET";
    const headers = { ...(options?.headers ?? {}) };
    const body = options?.body;

    const response = await fetch(url, { method, headers, body });

    if (response.status !== 402) return response;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });

    const challenge = parseL402Challenge(responseHeaders);
    if (!challenge) return response;

    const preimage = await payInvoiceCallback(challenge.invoice);
    this.cache.set(challenge.macaroon, preimage);

    headers["Authorization"] = `L402 ${challenge.macaroon}:${preimage}`;
    return fetch(url, { method, headers, body });
  }
}
