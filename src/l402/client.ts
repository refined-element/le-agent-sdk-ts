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

/**
 * Pattern for parsing MPP Payment challenges. Requires the "Payment" scheme
 * with method="lightning" and invoice="..." parameters in any order.
 * Allows optional whitespace (OWS) around `=` per HTTP auth-param grammar.
 * Detects "Payment" as a distinct scheme anywhere in the header value
 * (e.g., "Bearer ..., Payment ...").
 */
const MPP_METHOD_RE = /method\s*=\s*"lightning"/i;
const MPP_INVOICE_RE = /invoice\s*=\s*"(?<invoice>[^"]+)"/i;
const MPP_AMOUNT_RE = /amount\s*=\s*"(?<amount>[^"]+)"/i;
const MPP_REALM_RE = /realm\s*=\s*"(?<realm>[^"]+)"/i;

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
  // Verify "Payment" scheme anywhere in the header value (may be preceded by
  // other schemes like "Bearer ..., Payment ...") and extract only the
  // Payment segment so parameters from other schemes can't match.
  const schemeMatch = /(?:^\s*|,\s*)(Payment\s+)/i.exec(header);
  if (!schemeMatch) {
    throw new Error(`Invalid MPP challenge: ${header.slice(0, 80)}`);
  }

  // Extract only the Payment segment (from "Payment " to end-of-string or next scheme).
  // A new scheme boundary is detected as `, <Token> ` where <Token> starts with a letter
  // and is followed by whitespace (not `=`), distinguishing schemes from auth-params.
  const segmentStart = schemeMatch.index + schemeMatch[0].length;
  const remaining = header.substring(segmentStart);
  // Match `, <scheme-name> ` where scheme-name is NOT followed by `=` (to distinguish
  // from auth-params like `method="lightning"`).
  const nextScheme = /,\s*[A-Za-z][A-Za-z0-9!#$&\-.^_`|~]*\s+(?!=)/.exec(remaining);
  const paymentSegment = nextScheme
    ? remaining.substring(0, nextScheme.index)
    : remaining;

  if (!MPP_METHOD_RE.test(paymentSegment)) {
    throw new Error(`Invalid MPP challenge: ${header.slice(0, 80)}`);
  }

  const invoiceMatch = MPP_INVOICE_RE.exec(paymentSegment);
  if (!invoiceMatch?.groups?.invoice) {
    throw new Error(`Invalid MPP challenge: ${header.slice(0, 80)}`);
  }

  const invoice = invoiceMatch.groups.invoice.trim();
  if (!invoice) {
    throw new Error(
      `Invalid MPP challenge (empty invoice): ${header.slice(0, 80)}`
    );
  }

  const amountMatch = MPP_AMOUNT_RE.exec(paymentSegment);
  const realmMatch = MPP_REALM_RE.exec(paymentSegment);

  return {
    invoice,
    amount: amountMatch?.groups?.amount?.trim(),
    realm: realmMatch?.groups?.realm?.trim(),
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

  // Fallback to MPP parsing; let parseMppChallenge throw on invalid MPP
  return parseMppChallenge(header);
}

/** Callback type for paying a Lightning invoice. Returns the preimage hex. */
export type PayInvoiceCallback = (invoice: string) => Promise<string>;

export interface L402ClientOptions {
  /** Async function to pay an invoice. Returns hex preimage. */
  payInvoiceCallback?: PayInvoiceCallback;
  /** Cache of challenge key -> preimage for reuse. Keyed by macaroon for L402, by invoice for MPP. */
  preimageCache?: Map<string, string>;
  /** Maximum payment amount in satoshis. */
  maxAmountSats?: number;
}

/**
 * BOLT-11 human-readable part (HRP): "ln" + currency prefix + optional amount
 * + optional multiplier, anchored end-to-end with `$` so a digit run inside the
 * bech32 DATA part can never be mistaken for the amount. Longer currency
 * prefixes precede their own prefixes because JS alternation is ordered.
 */
const BOLT11_HRP_RE = /^ln(?:bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/;

/** BOLT-11 amount multipliers as a fraction of 1 BTC. */
const BTC_MULTIPLIERS: Record<string, number> = {
  m: 1e-3,
  u: 1e-6,
  n: 1e-9,
  p: 1e-12,
};

/**
 * Decode the amount in satoshis from a BOLT-11 invoice string.
 *
 * The amount is read ONLY from the human-readable part — everything before the
 * final bech32 separator ("1"). Per BIP-173 the data charset excludes "1", so
 * the LAST "1" is the true separator and every earlier "1" belongs to the HRP.
 * The old `^ln\w+?(\d+)([munp])1` regex was lazy and scanned forward into the
 * data part, so a crafted invoice such as `lnbc1p5u1foo` (whose real HRP,
 * "lnbc1p5u", encodes no valid amount) surfaced a bogus positive 500 sats from
 * its data part — that fabricated amount then slipped past the #71 budget guard
 * (a fail-open / decoder-disagreement attack, ledger #74).
 *
 * Returns undefined when the invoice encodes no amount or cannot be parsed.
 * undefined means "amount unknown", never "no limit"; a budget-enforcing caller
 * must refuse it.
 */
export function decodeInvoiceAmountSats(invoice: string): number | undefined {
  let inv = invoice.toLowerCase().trim();
  if (inv.startsWith("lightning:")) inv = inv.substring(10);

  // Isolate the HRP: everything before the LAST "1" (the bech32 separator).
  const separator = inv.lastIndexOf("1");
  if (separator < 0) return undefined;
  const hrp = inv.substring(0, separator);

  const match = hrp.match(BOLT11_HRP_RE);
  if (!match) return undefined;

  const amountDigits = match[1];
  if (!amountDigits) return undefined; // amountless invoice: payer chooses => unknown

  const amountNum = parseInt(amountDigits, 10);
  const multiplier = match[2];

  // An absent multiplier means the amount is denominated in whole BTC.
  const btcAmount = amountNum * (multiplier ? BTC_MULTIPLIERS[multiplier] : 1);
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
 * Try to parse a payment challenge (L402 or MPP) from the WWW-Authenticate
 * header value. Prefers L402 over MPP. Returns null if no valid challenge is found.
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

  // Delegate parsing to the shared payment challenge parser to avoid duplication.
  try {
    return parsePaymentChallenge(wwwAuth);
  } catch {
    return null;
  }
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
   * Shared payment logic: enforce amount limits, check cache, pay invoice,
   * validate preimage, and update cache. Used by both access() and payAndAccess()
   * to avoid drift between the two code paths.
   *
   * Returns the validated preimage hex string.
   */
  private async _executePayment(
    challenge: L402Challenge | MppChallenge,
    payFn: PayInvoiceCallback,
    effectiveMax: number | undefined
  ): Promise<string> {
    // Determine the invoice amount in sats (MPP explicit amount, else BOLT-11
    // decode). This runs REGARDLESS of whether a ceiling is configured — the
    // fail-closed rules below are split into two independent checks (ledger #71).
    let amountSats: number | undefined;

    // For MPP challenges with an explicit amount field, use it directly.
    // Only trust the MPP amount if it is strictly base-10 digits (non-negative integer).
    if (!("macaroon" in challenge)) {
      const mppAmount = (challenge as MppChallenge).amount;
      if (typeof mppAmount === "string" && /^[0-9]+$/.test(mppAmount)) {
        const parsed = Number(mppAmount);
        if (
          !Number.isFinite(parsed) ||
          !Number.isSafeInteger(parsed) ||
          parsed < 0
        ) {
          throw new Error(
            `Invalid MPP amount "${mppAmount}" in challenge: must be a non-negative safe integer.`
          );
        }
        amountSats = parsed;
      }
    }

    // Fall back to BOLT-11 invoice decoding
    if (amountSats === undefined) {
      amountSats = decodeInvoiceAmountSats(challenge.invoice);
    }

    // Rule 1 (fail-closed core, ledger #71): an unknown/unbounded amount is
    // ALWAYS refused, whether or not a ceiling is configured. Previously this
    // check lived inside `if (effectiveMax !== undefined)`, so with no max the
    // gate paid ANY invoice — a caller who forgot to set a ceiling delegated an
    // unbounded, unaudited spend. decodeInvoiceAmountSats() returns undefined
    // both for invoices that encode no amount and for invoices we failed to
    // parse; a zero amount is an explicit "payer decides". None can be proven
    // bounded, so all are refused even when no maximum is set.
    if (amountSats === undefined || amountSats <= 0) {
      throw new Error(
        `Invoice has no amount specified (amountless, unparseable, or zero), so ` +
          `it cannot be bounded and is refused — even when no maximum is ` +
          `configured. Paying it would hand the wallet an unbounded amount. ` +
          `Invoice: ${challenge.invoice.substring(0, 40)}...`
      );
    }

    // Rule 2: compare against the ceiling only when one is configured. With no
    // max the caller has opted out of a limit for this KNOWN amount, which is
    // their choice; the unknown-amount hole above is closed regardless.
    if (effectiveMax !== undefined && amountSats > effectiveMax) {
      throw new Error(
        `Invoice amount (${amountSats} sats) exceeds maximum allowed ` +
          `(${effectiveMax} sats). Invoice: ${challenge.invoice.substring(0, 40)}...`
      );
    }

    // Check if we have a cached preimage for this challenge
    const cacheKey =
      "macaroon" in challenge ? challenge.macaroon : challenge.invoice;
    let preimage = this.cache.get(cacheKey);

    // Normalize and validate any cached preimage before use
    if (typeof preimage === "string") {
      const normalized = preimage.trim();
      if (validatePreimage(normalized)) {
        // Update cache with normalized value if it changed
        if (normalized !== preimage) {
          this.cache.set(cacheKey, normalized);
        }
        preimage = normalized;
      } else {
        // Evict invalid cached entry and fall back to paying the invoice
        this.cache.delete(cacheKey);
        preimage = undefined;
      }
    }

    if (!preimage) {
      // Pay the invoice
      let rawPreimage: unknown;
      try {
        rawPreimage = await payFn(challenge.invoice);
      } catch (err) {
        throw new Error(
          `Payment callback failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      // Runtime type check: payment callback must return a string
      if (typeof rawPreimage !== "string") {
        throw new Error(
          `Payment callback must return a string preimage, got ${typeof rawPreimage}`
        );
      }

      // Normalize whitespace before validation
      preimage = rawPreimage.trim();

      // Validate preimage format
      if (!validatePreimage(preimage)) {
        throw new Error(
          `Invalid preimage from payment callback: expected 64-character hex string, ` +
            `got length ${preimage.length}`
        );
      }

      // Cache preimage (keyed by macaroon for L402, by invoice for MPP)
      this.cache.set(cacheKey, preimage);
    }

    return preimage;
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

    const effectiveMax = options?.maxAmountSats ?? this.maxAmountSats;
    const preimage = await this._executePayment(
      challenge,
      this.payCallback,
      effectiveMax
    );

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

    const effectiveMax = options?.maxAmountSats ?? this.maxAmountSats;
    const preimage = await this._executePayment(
      challenge,
      payInvoiceCallback,
      effectiveMax
    );

    headers["Authorization"] = buildAuthHeader(challenge, preimage);
    return fetch(url, { method, headers, body });
  }
}
