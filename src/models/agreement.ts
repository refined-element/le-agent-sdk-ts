/**
 * Agent Service Agreement model -- Nostr kind 38402.
 *
 * Bilateral contract between requester and provider.
 */

export interface AgentServiceAgreementInit {
  requestEventId?: string;
  capabilityEventId?: string;
  providerPubkey?: string;
  requesterPubkey?: string;
  agreedPriceSats?: number;
  l402Endpoint?: string;
  terms?: string;
  content?: string;
  expiresAt?: number | null;
  invoice?: string | null;
  macaroon?: string | null;
  paymentHash?: string | null;
  settlementMode?: string;
  eventId?: string;
  pubkey?: string;
  createdAt?: number;
}

export class AgentServiceAgreement {
  static readonly KIND = 38402;

  requestEventId: string;
  capabilityEventId: string;
  providerPubkey: string;
  requesterPubkey: string;
  agreedPriceSats: number;
  l402Endpoint: string;
  terms: string;
  content: string;
  expiresAt: number | null;
  invoice: string | null;
  macaroon: string | null;
  paymentHash: string | null;
  settlementMode: string;
  eventId: string;
  pubkey: string;
  createdAt: number;

  constructor(init: AgentServiceAgreementInit = {}) {
    this.requestEventId = init.requestEventId ?? "";
    this.capabilityEventId = init.capabilityEventId ?? "";
    this.providerPubkey = init.providerPubkey ?? "";
    this.requesterPubkey = init.requesterPubkey ?? "";
    this.agreedPriceSats = init.agreedPriceSats ?? 0;
    this.l402Endpoint = init.l402Endpoint ?? "";
    this.terms = init.terms ?? "";
    this.content = init.content ?? "";
    this.expiresAt = init.expiresAt ?? null;
    this.invoice = init.invoice ?? null;
    this.macaroon = init.macaroon ?? null;
    this.paymentHash = init.paymentHash ?? null;
    this.settlementMode = init.settlementMode ?? "proxy";
    this.eventId = init.eventId ?? "";
    this.pubkey = init.pubkey ?? "";
    this.createdAt = init.createdAt ?? 0;
  }

  /** Parse an AgentServiceAgreement from a raw Nostr event object. */
  static fromNostrEvent(
    event: Record<string, unknown>
  ): AgentServiceAgreement {
    const tags = (event.tags as string[][] | undefined) ?? [];
    const agr = new AgentServiceAgreement({
      eventId: (event.id as string) ?? "",
      pubkey: (event.pubkey as string) ?? "",
      createdAt: (event.created_at as number) ?? 0,
      content: (event.content as string) ?? "",
    });

    const eTags: string[][] = [];
    const pTags: string[][] = [];

    for (const tag of tags) {
      if (!tag || tag.length === 0) continue;
      const key = tag[0];
      if (key === "e" && tag.length > 1) {
        eTags.push(tag);
      } else if (key === "p" && tag.length > 1) {
        pTags.push(tag);
      } else if (key === "price" && tag.length > 1) {
        const parsed = parseInt(tag[1], 10);
        agr.agreedPriceSats = isNaN(parsed) ? 0 : parsed;
      } else if (key === "l402" && tag.length > 1) {
        agr.l402Endpoint = tag[1];
      } else if (key === "terms" && tag.length > 1) {
        agr.terms = tag[1];
      } else if (key === "expiration" && tag.length > 1) {
        const parsed = parseInt(tag[1], 10);
        agr.expiresAt = isNaN(parsed) ? null : parsed;
      }
    }

    // Parse e-tags: prefer marker hints (e.g. ["e", "<id>", "", "request"])
    let requestFound = false;
    let capabilityFound = false;
    for (const etag of eTags) {
      const marker = etag.length > 3 ? etag[3] : "";
      if (marker === "request") {
        agr.requestEventId = etag[1];
        requestFound = true;
      } else if (marker === "capability") {
        agr.capabilityEventId = etag[1];
        capabilityFound = true;
      }
    }

    if (!requestFound && !capabilityFound) {
      if (eTags.length > 0) agr.requestEventId = eTags[0][1];
      if (eTags.length > 1) agr.capabilityEventId = eTags[1][1];
    }

    // Parse p-tags: prefer marker hints
    let providerFound = false;
    let requesterFound = false;
    for (const ptag of pTags) {
      const marker = ptag.length > 3 ? ptag[3] : "";
      if (marker === "provider") {
        agr.providerPubkey = ptag[1];
        providerFound = true;
      } else if (marker === "requester") {
        agr.requesterPubkey = ptag[1];
        requesterFound = true;
      }
    }

    if (!providerFound && !requesterFound) {
      if (pTags.length > 0) agr.providerPubkey = pTags[0][1];
      if (pTags.length > 1) agr.requesterPubkey = pTags[1][1];
    }

    return agr;
  }

  /** Convert to Nostr event tags. */
  toNostrTags(): string[][] {
    const tags: string[][] = [];

    if (this.requestEventId)
      tags.push(["e", this.requestEventId, "", "request"]);
    if (this.capabilityEventId)
      tags.push(["e", this.capabilityEventId, "", "capability"]);
    if (this.providerPubkey)
      tags.push(["p", this.providerPubkey, "", "provider"]);
    if (this.requesterPubkey)
      tags.push(["p", this.requesterPubkey, "", "requester"]);
    if (this.agreedPriceSats > 0)
      tags.push(["price", String(this.agreedPriceSats)]);
    if (this.l402Endpoint) tags.push(["l402", this.l402Endpoint]);
    if (this.terms) tags.push(["terms", this.terms]);
    if (this.expiresAt !== null)
      tags.push(["expiration", String(this.expiresAt)]);

    return tags;
  }
}
