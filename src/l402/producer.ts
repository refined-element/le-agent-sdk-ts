/**
 * L402 Producer client for the Lightning Enable API.
 *
 * Enables agents to act as service providers by creating L402 challenges
 * (invoices) and verifying payments.
 */

export interface L402ChallengeResponse {
  success: boolean;
  invoice?: string;
  macaroon?: string;
  paymentHash?: string;
  expiresAt?: string;
  error?: string;
}

export interface L402VerifyResponse {
  success: boolean;
  valid: boolean;
  resource?: string;
  error?: string;
}

export interface L402ProducerClientOptions {
  leApiKey: string;
  leApiBaseUrl?: string;
}

export class L402ProducerClient {
  private apiKey: string;
  private baseUrl: string;

  constructor(options: L402ProducerClientOptions) {
    this.apiKey = options.leApiKey;
    this.baseUrl = (options.leApiBaseUrl ?? "https://api.lightningenable.com").replace(/\/$/, "");
  }

  /**
   * Create an L402 challenge (Lightning invoice + macaroon) for a resource.
   *
   * The provider calls this to generate an invoice at the negotiated price.
   */
  async createChallenge(
    resource: string,
    priceSats: number,
    description?: string
  ): Promise<L402ChallengeResponse> {
    if (priceSats <= 0) {
      return { success: false, error: "Price must be greater than 0 sats" };
    }

    const body: Record<string, unknown> = { resource, priceSats };
    if (description) body.description = description;

    try {
      const response = await fetch(`${this.baseUrl}/api/l402/challenges`, {
        method: "POST",
        headers: {
          "X-Api-Key": this.apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
          "User-Agent": "LE-Agent-SDK-TS/0.1.0",
        },
        body: JSON.stringify(body),
      });

      if (response.status !== 200) {
        let errorMsg = `API returned ${response.status}`;
        try {
          const data = (await response.json()) as Record<string, unknown>;
          errorMsg =
            (data.message as string) ??
            (data.error as string) ??
            errorMsg;
        } catch {
          // Ignore JSON parse errors
        }
        return { success: false, error: errorMsg };
      }

      const data = (await response.json()) as Record<string, unknown>;
      return {
        success: true,
        invoice: data.invoice as string | undefined,
        macaroon: data.macaroon as string | undefined,
        paymentHash: data.paymentHash as string | undefined,
        expiresAt: data.expiresAt as string | undefined,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { success: false, error: "Request timed out" };
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verify an L402 or MPP token to confirm payment.
   *
   * For L402: pass both macaroon and preimage.
   * For MPP: pass null for macaroon, preimage only.
   *
   * The provider calls this after receiving a token from the requester
   * to validate that the invoice has been paid.
   */
  async verifyPayment(
    macaroon: string | null,
    preimage: string
  ): Promise<L402VerifyResponse> {
    try {
      const body: Record<string, string> = { preimage: preimage.trim() };
      if (macaroon !== null) {
        const trimmedMacaroon = macaroon.trim();
        if (!trimmedMacaroon) {
          return {
            success: false,
            valid: false,
            error: "Invalid macaroon: value is empty or whitespace only",
          };
        }
        body.macaroon = trimmedMacaroon;
      }

      const response = await fetch(
        `${this.baseUrl}/api/l402/challenges/verify`,
        {
          method: "POST",
          headers: {
            "X-Api-Key": this.apiKey,
            "Content-Type": "application/json",
            Accept: "application/json",
            "User-Agent": "LE-Agent-SDK-TS/0.1.0",
          },
          body: JSON.stringify(body),
        }
      );

      if (response.status !== 200) {
        let errorMsg = `API returned ${response.status}`;
        try {
          const data = (await response.json()) as Record<string, unknown>;
          errorMsg =
            (data.message as string) ??
            (data.error as string) ??
            errorMsg;
        } catch {
          // Ignore JSON parse errors
        }
        return { success: false, valid: false, error: errorMsg };
      }

      const data = (await response.json()) as Record<string, unknown>;
      return {
        success: true,
        valid: (data.valid as boolean) ?? false,
        resource: data.resource as string | undefined,
      };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { success: false, valid: false, error: "Request timed out" };
      }
      return {
        success: false,
        valid: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
