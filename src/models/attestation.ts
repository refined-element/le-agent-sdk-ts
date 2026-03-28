/**
 * Agent Attestation model -- Nostr kind 38403.
 *
 * Reputation attestation for an agent after a completed service agreement.
 */

export interface AgentAttestationInit {
  subjectPubkey?: string;
  agreementEventId?: string;
  rating?: number;
  content?: string;
  eventId?: string;
  pubkey?: string;
  createdAt?: number;
}

export class AgentAttestation {
  static readonly KIND = 38403;

  subjectPubkey: string;
  agreementEventId: string;
  rating: number;
  content: string;
  eventId: string;
  pubkey: string;
  createdAt: number;

  constructor(init: AgentAttestationInit = {}) {
    this.subjectPubkey = init.subjectPubkey ?? "";
    this.agreementEventId = init.agreementEventId ?? "";
    this.rating = init.rating ?? 0;
    this.content = init.content ?? "";
    this.eventId = init.eventId ?? "";
    this.pubkey = init.pubkey ?? "";
    this.createdAt = init.createdAt ?? 0;
  }

  /** Parse an AgentAttestation from a raw Nostr event object. */
  static fromNostrEvent(event: Record<string, unknown>): AgentAttestation {
    const tags = (event.tags as string[][] | undefined) ?? [];
    const att = new AgentAttestation({
      eventId: (event.id as string) ?? "",
      pubkey: (event.pubkey as string) ?? "",
      createdAt: (event.created_at as number) ?? 0,
      content: (event.content as string) ?? "",
    });

    for (const tag of tags) {
      if (!tag || tag.length === 0) continue;
      const key = tag[0];
      if (key === "p" && tag.length > 1) {
        att.subjectPubkey = tag[1];
      } else if (key === "e" && tag.length > 1) {
        att.agreementEventId = tag[1];
      } else if (key === "rating" && tag.length > 1) {
        const parsed = parseInt(tag[1], 10);
        att.rating = isNaN(parsed) ? 0 : parsed;
      }
    }

    return att;
  }

  /** Convert to Nostr event tags. */
  toNostrTags(): string[][] {
    const tags: string[][] = [];

    if (this.subjectPubkey) tags.push(["p", this.subjectPubkey]);
    if (this.agreementEventId) tags.push(["e", this.agreementEventId]);
    if (this.rating > 0) tags.push(["rating", String(this.rating)]);

    // NIP-32 label tags for attestation domain
    tags.push(["L", "nostr.agent.attestation"]);
    tags.push(["l", "completed", "nostr.agent.attestation"]);
    tags.push(["l", "commerce.service_completion", "nostr.agent.attestation"]);

    return tags;
  }
}
