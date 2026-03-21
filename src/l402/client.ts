/**
 * L402 HTTP client for agent service settlement (consumer side).
 *
 * Handles automatic L402 challenge parsing and payment retry flow.
 * Supports both L402 and MPP (Machine Payments Protocol) challenges.
 */

/** Parsed L402 challenge from a WWW-Authenticate header. */
export interface L402Challenge {
  macaroon: string;
  invoice: string;
}

/** Parsed MPP (Machine Payments Protocol) challenge from a WWW-Authenticate header. */
export interface MppChallenge {
  invoice: string;
  amount?: string;
  realm?: string;
}

/**
 * Pattern for parsing L402/LSAT challenges from WWW-Authenticate headers.
 * Supports both quoted and unquoted formats, and both L402 and legacy LSAT prefixes.
 */
const CHALLENGE_RE =
  /(?:L402|LSAT)\s+macaroon="?([^",\s]+)"?\s*,\s*invoice="?([^",\s]+)"?/i;

/** Pattern for parsing MPP Payment challenges. Requires method="lightning" and invoice="...". */
const MPP_CHALLENGE_RE =
  /Payment\s+.*?method="lightning".*?invoice="(?<invoice>[^"]+)"/i;
const MPP_AMOUNT_RE = /amount="(?<amount>[^"]+)"/i;
const MPP_REALM_RE = /realm="(?<realm>[^"]+)"/i;

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

/**
 * Parse an MPP (Machine Payments Protocol) challenge from a WWW-Authenticate header string.
 * Expects `Payment method="lightning", invoice="..."` format.
 * Throws if the header is not a valid MPP challenge.
 */
export function parseMppChallenge(header: string): MppChallenge {
  const match = MPP_CHALLENGE_RE.exec(header);
  if (!match?.groups?.invoice) {
    throw new Error(`Invalid MPP challenge: ${header.slice(0, 80)}`);
  }

  const amountMatch = MPP_AMOUNT_RE.exec(header);
  const realmMatch = MPP_REALM_RE.exec(header);

  return {
    invoice: match.groups.invoice,
    amount: amountMatch?.groups?.amount,
    realm: realmMatch?.groups?.realm,
  };
}

/**
 * Parse a payment challenge from a WWW-Authenticate header string.
 * Prefers L402 when both formats could match. Falls back to MPP.
 * Throws if neither format is found.
 */
export function parsePaymentChallenge(
  header: string
): L402Challenge | MppChallenge {
  // Try L402 first (preferred)
  const l402Match = CHALLENGE_RE.exec(header);
  if (l402Match) {
    return {
      macaroon: l402Match[1].trim(),
      invoice: l402Match[2].trim(),
    };
  }

  // Try MPP
  const mppMatch = MPP_CHALLENGE_RE.exec(header);
  if (mppMatch?.groups?.invoice) {
    const amountMatch = MPP_AMOUNT_RE.exec(header);
    const realmMatch = MPP_REALM_RE.exec(header);
    return {
      invoice: mppMatch.groups.invoice,
      amount: amountMatch?.groups?.amount,
      realm: realmMatch?.groups?.realm,
    };
  }

  throw new Error(`No valid L402 or MPP challenge: ${header.slice(0, 80)}`);
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
 * Build the appropriate Authorization header for a challenge.
 * L402 challenges use `L402 <macaroon>:<preimage>`.
 * MPP challenges use `Payment method="lightning", preimage="<hex>"`.
 */
function buildAuthHeader(
  challenge: L402Challenge | MppChallenge,
  preimage: string
): string {
  const isMpp = !("macaroon" in challenge);
  return isMpp
    ? `Payment method="lightning", preimage="${preimage}"`
    : `L402 ${(challenge as L402Challenge).macaroon}:${preimage}`;
}

/**
 * Try to parse a payment challenge (L402 or MPP) from response headers.
 * Checks all WWW-Authenticate headers. Prefers L402 over MPP.
 * Returns null if no valid challenge is found.
 */
function extractChallenge(
  responseHeaders: Record<string, string>
): L402Challenge | MppChallenge | null {
  // Collect all www-authenticate header values
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(responseHeaders)) {
    lowerHeaders[k.toLowerCase()] = v;
  }

  const wwwAuth = lowerHeaders["www-authenticate"] ?? "";
  if (!wwwAuth) return null;

  // Try L402 first (preferred)
  const l402Match = CHALLENGE_RE.exec(wwwAuth);
  if (l402Match) {
    return {
      macaroon: l402Match[1].trim(),
      invoice: l402Match[2].trim(),
    };
  }

  // Try MPP
  const mppMatch = MPP_CHALLENGE_RE.exec(wwwAuth);
  if (mppMatch?.groups?.invoice) {
    const amountMatch = MPP_AMOUNT_RE.exec(wwwAuth);
    const realmMatch = MPP_REALM_RE.exec(wwwAuth);
    return {
      invoice: mppMatch.groups.invoice,
      amount: amountMatch?.groups?.amount,
      realm: realmMatch?.groups?.realm,
    };
  }

  return null;
}

/**
 * Async HTTP client with L402 and MPP payment support.
 *
 * For full auto-payment, configure with a payInvoiceCallback.
 * Otherwise, challenges are returned via the 402 response for external handling.
 *
 * Supports both L402 (macaroon + preimage) and MPP (Machine Payments Protocol,
 * preimage-only) challenges. When both are present, L402 is preferred.
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
   * Access an L402/MPP-protected resource.
   *
   * If a 402 is received and a pay callback is configured, the invoice
   * is paid and the request retried with the appropriate credentials.
   * Prefers L402 when both challenge types are present.
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

    const challenge = extractChallenge(responseHeaders);
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

    // Cache preimage (keyed by macaroon for L402, by invoice for MPP)
    if ("macaroon" in challenge) {
      this.cache.set(challenge.macaroon, preimage);
    } else {
      this.cache.set(challenge.invoice, preimage);
    }

    // Retry with credentials (with retry+backoff)
    headers["Authorization"] = buildAuthHeader(challenge, preimage);
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
   * Full L402/MPP flow: request, get 402, pay invoice, retry with token.
   * Prefers L402 when both challenge types are present.
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

    const challenge = extractChallenge(responseHeaders);
    if (!challenge) return response;

    const preimage = await payInvoiceCallback(challenge.invoice);

    // Cache preimage (keyed by macaroon for L402, by invoice for MPP)
    if ("macaroon" in challenge) {
      this.cache.set(challenge.macaroon, preimage);
    } else {
      this.cache.set(challenge.invoice, preimage);
    }

    headers["Authorization"] = buildAuthHeader(challenge, preimage);
    return fetch(url, { method, headers, body });
  }
}
