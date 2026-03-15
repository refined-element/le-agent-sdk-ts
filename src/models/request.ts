/**
 * Agent Service Request model -- Nostr kind 38401.
 *
 * Sent by a requester to indicate interest in a capability.
 */

export interface AgentServiceRequestInit {
  capabilityEventId?: string;
  providerPubkey?: string;
  budgetSats?: number;
  content?: string;
  params?: Record<string, string>;
  eventId?: string;
  pubkey?: string;
  createdAt?: number;
}

export class AgentServiceRequest {
  static readonly KIND = 38401;

  capabilityEventId: string;
  providerPubkey: string;
  budgetSats: number;
  content: string;
  params: Record<string, string>;
  eventId: string;
  pubkey: string;
  createdAt: number;

  constructor(init: AgentServiceRequestInit = {}) {
    this.capabilityEventId = init.capabilityEventId ?? "";
    this.providerPubkey = init.providerPubkey ?? "";
    this.budgetSats = init.budgetSats ?? 0;
    this.content = init.content ?? "";
    this.params = init.params ?? {};
    this.eventId = init.eventId ?? "";
    this.pubkey = init.pubkey ?? "";
    this.createdAt = init.createdAt ?? 0;
  }

  /** Parse an AgentServiceRequest from a raw Nostr event object. */
  static fromNostrEvent(event: Record<string, unknown>): AgentServiceRequest {
    const tags = (event.tags as string[][] | undefined) ?? [];
    const req = new AgentServiceRequest({
      eventId: (event.id as string) ?? "",
      pubkey: (event.pubkey as string) ?? "",
      createdAt: (event.created_at as number) ?? 0,
      content: (event.content as string) ?? "",
    });

    for (const tag of tags) {
      if (!tag || tag.length === 0) continue;
      const key = tag[0];
      if (key === "e" && tag.length > 1) {
        req.capabilityEventId = tag[1];
      } else if (key === "p" && tag.length > 1) {
        req.providerPubkey = tag[1];
      } else if (key === "budget" && tag.length > 1) {
        const parsed = parseInt(tag[1], 10);
        req.budgetSats = isNaN(parsed) ? 0 : parsed;
      } else if (key === "param" && tag.length > 2) {
        req.params[tag[1]] = tag[2];
      }
    }

    return req;
  }

  /** Convert to Nostr event tags. */
  toNostrTags(): string[][] {
    const tags: string[][] = [];

    if (this.capabilityEventId) tags.push(["e", this.capabilityEventId]);
    if (this.providerPubkey) tags.push(["p", this.providerPubkey]);
    if (this.budgetSats > 0) tags.push(["budget", String(this.budgetSats)]);
    for (const [k, v] of Object.entries(this.params)) {
      tags.push(["param", k, v]);
    }

    return tags;
  }
}
