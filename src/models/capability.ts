/**
 * Agent Capability model -- Nostr kind 38400.
 *
 * Addressable/replaceable event (NIP-33 style) keyed by `d` tag (serviceId).
 */

export interface AgentPricingInit {
  amount: number;
  unit?: string;
  model?: string;
}

export class AgentPricing {
  readonly amount: number;
  readonly unit: string;
  readonly model: string;

  constructor(init: AgentPricingInit) {
    this.amount = init.amount;
    this.unit = init.unit ?? "sats";
    this.model = init.model ?? "per-request";
  }

  /** Convert to a Nostr "price" tag. */
  toTag(): string[] {
    return ["price", String(this.amount), this.unit, this.model];
  }

  /** Parse from a Nostr "price" tag: ["price", amount, unit, model]. */
  static fromTag(tag: string[]): AgentPricing {
    if (tag.length < 2) {
      throw new Error(`Invalid price tag: ${JSON.stringify(tag)}`);
    }
    return new AgentPricing({
      amount: parseInt(tag[1], 10),
      unit: tag.length > 2 ? tag[2] : "sats",
      model: tag.length > 3 ? tag[3] : "per-request",
    });
  }
}

export interface AgentCapabilityInit {
  serviceId?: string;
  categories?: string[];
  content?: string;
  pricing?: AgentPricing[];
  l402Endpoint?: string | null;
  apiEndpoint?: string | null;
  apiMethod?: string | null;
  schemaUrl?: string | null;
  hashtags?: string[];
  negotiable?: boolean;
  minPriceSats?: number | null;
  eventId?: string;
  pubkey?: string;
  createdAt?: number;
}

export class AgentCapability {
  static readonly KIND = 38400;

  serviceId: string;
  categories: string[];
  content: string;
  pricing: AgentPricing[];
  l402Endpoint: string | null;
  apiEndpoint: string | null;
  apiMethod: string | null;
  schemaUrl: string | null;
  hashtags: string[];
  negotiable: boolean;
  minPriceSats: number | null;
  eventId: string;
  pubkey: string;
  createdAt: number;

  constructor(init: AgentCapabilityInit = {}) {
    this.serviceId = init.serviceId ?? "";
    this.categories = init.categories ?? [];
    this.content = init.content ?? "";
    this.pricing = init.pricing ?? [];
    this.l402Endpoint = init.l402Endpoint ?? null;
    this.apiEndpoint = init.apiEndpoint ?? null;
    this.apiMethod = init.apiMethod ?? null;
    this.schemaUrl = init.schemaUrl ?? null;
    this.hashtags = init.hashtags ?? [];
    this.negotiable = init.negotiable ?? true;
    this.minPriceSats = init.minPriceSats ?? null;
    this.eventId = init.eventId ?? "";
    this.pubkey = init.pubkey ?? "";
    this.createdAt = init.createdAt ?? 0;
  }

  /** Parse an AgentCapability from a raw Nostr event object. */
  static fromNostrEvent(event: Record<string, unknown>): AgentCapability {
    const tags = (event.tags as string[][] | undefined) ?? [];
    const cap = new AgentCapability({
      eventId: (event.id as string) ?? "",
      pubkey: (event.pubkey as string) ?? "",
      createdAt: (event.created_at as number) ?? 0,
      content: (event.content as string) ?? "",
    });

    for (const tag of tags) {
      if (!tag || tag.length === 0) continue;
      const key = tag[0];
      if (key === "d" && tag.length > 1) {
        cap.serviceId = tag[1];
      } else if (key === "s" && tag.length > 1) {
        cap.categories.push(tag[1]);
      } else if (key === "price" && tag.length > 1) {
        cap.pricing.push(AgentPricing.fromTag(tag));
      } else if (key === "l402" && tag.length > 1) {
        cap.l402Endpoint = tag[1];
      } else if (key === "api_endpoint" && tag.length > 1) {
        cap.apiEndpoint = tag[1];
      } else if (key === "api_method" && tag.length > 1) {
        cap.apiMethod = tag[1];
      } else if (key === "schema" && tag.length > 1) {
        cap.schemaUrl = tag[1];
      } else if (key === "t" && tag.length > 1) {
        cap.hashtags.push(tag[1]);
      } else if (key === "negotiable" && tag.length > 1) {
        if (tag[1] === "false") {
          cap.negotiable = false;
        } else if (tag[1] === "true") {
          cap.negotiable = true;
        } else if (tag[1] === "floor" && tag.length > 2) {
          cap.negotiable = true;
          cap.minPriceSats = parseInt(tag[2], 10);
        }
      }
    }

    return cap;
  }

  /** Convert to Nostr event tags. */
  toNostrTags(): string[][] {
    const tags: string[][] = [];

    if (this.serviceId) tags.push(["d", this.serviceId]);
    for (const cat of this.categories) tags.push(["s", cat]);
    for (const p of this.pricing) tags.push(p.toTag());
    if (this.l402Endpoint) tags.push(["l402", this.l402Endpoint]);
    if (this.apiEndpoint) tags.push(["api_endpoint", this.apiEndpoint]);
    if (this.apiMethod) tags.push(["api_method", this.apiMethod]);
    if (this.schemaUrl) tags.push(["schema", this.schemaUrl]);
    for (const ht of this.hashtags) tags.push(["t", ht]);

    if (this.minPriceSats != null) {
      tags.push(["negotiable", "floor", String(this.minPriceSats)]);
    } else if (!this.negotiable) {
      tags.push(["negotiable", "false"]);
    } else {
      tags.push(["negotiable", "true"]);
    }

    return tags;
  }
}
