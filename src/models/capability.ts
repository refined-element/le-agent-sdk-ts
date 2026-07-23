/**
 * Agent Capability model -- Nostr kind 38400.
 *
 * Addressable/replaceable event (NIP-33 style) keyed by `d` tag (serviceId).
 */

/**
 * Parse a satoshi amount that must be a NON-NEGATIVE plain integer, or throw.
 *
 * parseInt() is unsafe for untrusted tag values: parseInt("abc") is NaN and
 * every comparison against NaN is false, so a NaN amount silently passes any
 * budget / price-floor check downstream; parseInt("10.5") / parseInt("100abc")
 * silently truncate to 10 / 100. Both are worse than useless, so anything that
 * is not a plain integer is rejected. A negative amount is rejected too
 * (ledger #69): a negative advertised price/floor is never meaningful and
 * accepting it is a fail-open smell, so the `^[0-9]+$` pattern (no leading `-`)
 * rejects it on the same throw path as any other malformed amount. Zero is
 * valid (a free service). Shared by BOTH price-tag and negotiable-floor parsing
 * so the two can never drift apart again (ledger #41 / #61 / #69; pinned by the
 * shared conformance vectors price-tag.json / negotiable-floor.json).
 */
function parseSatsAmount(raw: string, context: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new Error(`Invalid ${context}`);
  }
  const amount = Number(raw);
  if (!Number.isSafeInteger(amount)) {
    throw new Error(`Invalid ${context}`);
  }
  return amount;
}

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

    // Reject anything that is not a plain integer (see parseSatsAmount): a NaN or
    // silently-truncated amount would pass any budget check downstream instead of
    // being rejected. Shared with the negotiable-floor parse below.
    return new AgentPricing({
      amount: parseSatsAmount(tag[1], `price tag: ${JSON.stringify(tag)}`),
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
          // Same strict integer parse as price amounts (ledger #61). parseInt()
          // kept a NaN floor for "abc" and truncated "10.5"->10 / "100abc"->100,
          // and a bogus/NaN floor then slips past every downstream price-floor
          // comparison. python and .NET already reject a malformed floor.
          cap.minPriceSats = parseSatsAmount(
            tag[2],
            `negotiable floor: ${JSON.stringify(tag[2])}`
          );
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
