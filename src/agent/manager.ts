/**
 * Agent Manager -- main orchestrator for ASA protocol operations.
 *
 * Provides a high-level API for discovering capabilities, publishing services,
 * sending requests, publishing agreements, and settling via L402.
 */

import { L402Client, type PayInvoiceCallback } from "../l402/client.js";
import {
  L402ProducerClient,
  type L402ChallengeResponse,
} from "../l402/producer.js";
import { AgentServiceAgreement } from "../models/agreement.js";
import { AgentAttestation } from "../models/attestation.js";
import { AgentCapability } from "../models/capability.js";
import { AgentServiceRequest } from "../models/request.js";
import { NostrEvent, type NostrEventData } from "../nostr/event.js";
import { RelayClient } from "../nostr/relay.js";
import { TagParser } from "../nostr/tags.js";

export interface AgentManagerOptions {
  /** Hex-encoded 32-byte Nostr private key. */
  privateKey?: string;
  /** List of Nostr relay WebSocket URLs. */
  relayUrls?: string[];
  /** Async callable(invoice: string) => preimage: string. For L402 auto-payment. */
  payInvoiceCallback?: PayInvoiceCallback;
  /** Lightning Enable merchant API key. Required for producer operations. */
  leApiKey?: string;
  /** Base URL for the Lightning Enable API. */
  leApiBaseUrl?: string;
}

export interface DiscoverOptions {
  categories?: string[];
  hashtags?: string[];
  limit?: number;
  timeout?: number;
}

export interface ReputationResult {
  average: number;
  count: number;
  attestations: AgentAttestation[];
}

export class AgentManager {
  readonly privateKey?: string;
  readonly relayUrls: string[];
  private payCallback?: PayInvoiceCallback;
  private leApiKey?: string;
  private leApiBaseUrl: string;
  private _pubkey?: string;
  private producerClient?: L402ProducerClient;

  constructor(options: AgentManagerOptions = {}) {
    this.privateKey = options.privateKey;
    this.relayUrls = options.relayUrls ?? ["wss://agents.lightningenable.com"];
    this.payCallback = options.payInvoiceCallback;
    this.leApiKey = options.leApiKey;
    this.leApiBaseUrl =
      options.leApiBaseUrl ?? "https://api.lightningenable.com";
  }

  /** Derive and cache the public key from the private key. */
  get pubkey(): string {
    if (!this._pubkey) {
      if (!this.privateKey) {
        throw new Error("No private key configured; cannot derive pubkey");
      }
      this._pubkey = NostrEvent.pubkeyFromPrivateKey(this.privateKey);
    }
    return this._pubkey;
  }

  // --- Internal relay helpers ---

  private async publishToRelays(
    event: NostrEventData
  ): Promise<string> {
    const tasks = this.relayUrls.map((url) =>
      this.publishToRelay(url, event)
    );
    const results = await Promise.allSettled(tasks);

    let anyAccepted = false;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value === true) {
        anyAccepted = true;
        break;
      }
    }

    if (!anyAccepted) {
      throw new Error(
        `Event ${event.id} was not accepted by any relay. ` +
          `Tried ${this.relayUrls.length} relay(s): ${this.relayUrls.join(", ")}`
      );
    }

    return event.id;
  }

  private async publishToRelay(
    url: string,
    event: NostrEventData
  ): Promise<boolean> {
    const relay = new RelayClient();
    try {
      await relay.connect(url);
      return await relay.publish(event as unknown as Record<string, unknown>);
    } catch {
      return false;
    } finally {
      await relay.close();
    }
  }

  /**
   * Verify a raw relay event's ID and signature.
   *
   * Relay lists are caller-configurable and results from every relay are merged,
   * so a single hostile or compromised relay could otherwise inject events
   * attributed to any pubkey. Anything that does not carry a valid BIP-340
   * signature over its own ID is not authentic and must be discarded.
   */
  static async isAuthentic(raw: Record<string, unknown>): Promise<boolean> {
    if (
      typeof raw.id !== "string" ||
      typeof raw.pubkey !== "string" ||
      typeof raw.created_at !== "number" ||
      typeof raw.kind !== "number" ||
      typeof raw.content !== "string" ||
      typeof raw.sig !== "string" ||
      !Array.isArray(raw.tags)
    ) {
      return false;
    }

    try {
      return await NostrEvent.verify(raw as unknown as NostrEventData);
    } catch {
      return false;
    }
  }

  /**
   * Query all configured relays and merge/deduplicate results.
   *
   * Events that fail signature verification are discarded rather than returned.
   */
  async queryRelays(
    filters: Record<string, unknown>[],
    timeout = 5_000
  ): Promise<Record<string, unknown>[]> {
    const tasks = this.relayUrls.map((url) =>
      this.queryRelay(url, filters, timeout)
    );
    const results = await Promise.allSettled(tasks);

    const seenIds = new Set<string>();
    const events: Record<string, unknown>[] = [];

    for (const result of results) {
      if (result.status === "fulfilled") {
        for (const event of result.value) {
          const eventId = event.id as string;
          if (eventId && !seenIds.has(eventId)) {
            seenIds.add(eventId);
            if (await AgentManager.isAuthentic(event)) {
              events.push(event);
            }
          }
        }
      }
    }

    return events;
  }

  private async queryRelay(
    url: string,
    filters: Record<string, unknown>[],
    timeout: number
  ): Promise<Record<string, unknown>[]> {
    const relay = new RelayClient();
    try {
      await relay.connect(url);
      return await relay.collectEvents(filters, timeout);
    } catch {
      return [];
    } finally {
      await relay.close();
    }
  }

  // --- Public API ---

  /**
   * Query relays for agent capabilities.
   */
  async discover(options: DiscoverOptions = {}): Promise<AgentCapability[]> {
    const { categories, hashtags, limit = 20, timeout = 5_000 } = options;

    let tags: Record<string, string[]> | undefined;
    if (categories || hashtags) {
      tags = {};
      if (categories) tags.s = categories;
      if (hashtags) tags.t = hashtags;
    }

    const nostrFilter = TagParser.buildFilter({
      kinds: [AgentCapability.KIND],
      limit,
      tags,
    });

    const rawEvents = await this.queryRelays([nostrFilter], timeout);

    // Parse each event independently. A malformed tag (e.g. a non-integer
    // "price" amount) makes AgentCapability.fromNostrEvent throw; if that
    // propagated out of a .map() over the batch, one hostile relay publishing
    // one bad capability event would abort the whole discover() and drop every
    // valid capability with it. Fail closed, LOUDLY: skip the offending event
    // and warn (naming its id) rather than silently swallowing it.
    const capabilities: AgentCapability[] = [];
    for (const event of rawEvents) {
      try {
        capabilities.push(AgentCapability.fromNostrEvent(event));
      } catch (err) {
        const eventId =
          typeof event.id === "string" && event.id ? event.id : "<unknown>";
        console.warn(
          `discover(): skipping malformed capability event ${eventId}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
    return capabilities;
  }

  /**
   * Publish a capability advertisement to relays.
   * Returns the Nostr event ID.
   */
  async publishCapability(capability: AgentCapability): Promise<string> {
    const tags = capability.toNostrTags();
    const event = await NostrEvent.create({
      kind: AgentCapability.KIND,
      content: capability.content,
      tags,
      privateKey: this.privateKey,
    });
    return this.publishToRelays(event);
  }

  /**
   * Send a service request to a provider.
   */
  async requestService(
    capabilityEventId: string,
    providerPubkey: string,
    budgetSats = 0,
    params?: Record<string, string>,
    content = ""
  ): Promise<AgentServiceRequest> {
    const request = new AgentServiceRequest({
      capabilityEventId,
      providerPubkey,
      budgetSats,
      params: params ?? {},
      content,
    });

    const tags = request.toNostrTags();
    const event = await NostrEvent.create({
      kind: AgentServiceRequest.KIND,
      content: request.content,
      tags,
      privateKey: this.privateKey,
    });

    const eventId = await this.publishToRelays(event);
    request.eventId = eventId;
    request.pubkey = event.pubkey;
    request.createdAt = event.created_at;
    return request;
  }

  /**
   * Listen for incoming service requests addressed to this agent.
   * Returns an async generator that yields AgentServiceRequest objects.
   */
  async *listenRequests(
    _timeout = 0
  ): AsyncGenerator<AgentServiceRequest> {
    const nostrFilter = TagParser.buildFilter({
      kinds: [AgentServiceRequest.KIND],
      tags: { p: [this.pubkey] },
    });

    const relays: RelayClient[] = [];
    for (const url of this.relayUrls) {
      const relay = new RelayClient();
      try {
        await relay.connect(url);
        await relay.subscribe([nostrFilter]);
        relays.push(relay);
      } catch {
        await relay.close();
      }
    }

    if (relays.length === 0) {
      throw new Error(
        `Could not connect to any relay. Tried: ${this.relayUrls.join(", ")}`
      );
    }

    const seenIds = new Set<string>();
    const maxReconnectAttempts = 5;
    const backoffBase = 1_000;

    try {
      let activeRelay = relays[0];
      let reconnectAttempts = 0;

      while (true) {
        try {
          for await (const msg of activeRelay.listen()) {
            if (msg.type === "EVENT") {
              const eventId = msg.event.id as string;
              if (eventId && !seenIds.has(eventId)) {
                seenIds.add(eventId);
                reconnectAttempts = 0;
                // Drop events a relay cannot prove were signed by their
                // claimed author before acting on them.
                if (await AgentManager.isAuthentic(msg.event)) {
                  yield AgentServiceRequest.fromNostrEvent(msg.event);
                }
              }
            }
          }
        } catch {
          reconnectAttempts++;
          if (reconnectAttempts > maxReconnectAttempts) {
            throw new Error(
              `Lost connection to relay after ${maxReconnectAttempts} reconnect attempts`
            );
          }
          const wait = backoffBase * 2 ** (reconnectAttempts - 1);
          await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));

          let reconnected = false;
          for (const url of this.relayUrls) {
            try {
              const newRelay = new RelayClient();
              await newRelay.connect(url);
              await newRelay.subscribe([nostrFilter]);
              activeRelay = newRelay;
              reconnected = true;
              break;
            } catch {
              // Try next relay
            }
          }

          if (!reconnected) {
            throw new Error(
              `Could not reconnect to any relay after attempt ${reconnectAttempts}`
            );
          }
        }
      }
    } finally {
      for (const r of relays) {
        await r.close();
      }
    }
  }

  /**
   * Publish a service agreement.
   */
  async publishAgreement(options: {
    requestEventId: string;
    capabilityEventId: string;
    requesterPubkey: string;
    agreedPriceSats: number;
    l402Endpoint?: string;
    terms?: string;
    expiresAt?: number;
    content?: string;
  }): Promise<AgentServiceAgreement> {
    const agreement = new AgentServiceAgreement({
      requestEventId: options.requestEventId,
      capabilityEventId: options.capabilityEventId,
      providerPubkey: this.pubkey,
      requesterPubkey: options.requesterPubkey,
      agreedPriceSats: options.agreedPriceSats,
      l402Endpoint: options.l402Endpoint ?? "",
      terms: options.terms ?? "",
      expiresAt: options.expiresAt,
      content: options.content ?? "",
    });

    const tags = agreement.toNostrTags();
    const event = await NostrEvent.create({
      kind: AgentServiceAgreement.KIND,
      content: agreement.content,
      tags,
      privateKey: this.privateKey,
    });

    const eventId = await this.publishToRelays(event);
    agreement.eventId = eventId;
    agreement.pubkey = event.pubkey;
    agreement.createdAt = event.created_at;
    return agreement;
  }

  /**
   * Execute L402 settlement for an agreement.
   */
  async settle(
    agreement: AgentServiceAgreement,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<Response> {
    if (!agreement.l402Endpoint) {
      throw new Error("Agreement has no L402 endpoint configured");
    }

    const client = new L402Client({
      payInvoiceCallback: this.payCallback,
    });

    return client.access(agreement.l402Endpoint, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
    });
  }

  /**
   * Directly settle via a capability's L402 endpoint (skip the request/agreement steps).
   */
  async settleViaL402(
    capability: AgentCapability,
    options?: {
      method?: string;
      headers?: Record<string, string>;
      body?: string;
    }
  ): Promise<Response> {
    if (!capability.l402Endpoint) {
      throw new Error("Capability has no L402 endpoint configured");
    }

    const client = new L402Client({
      payInvoiceCallback: this.payCallback,
    });

    return client.access(capability.l402Endpoint, {
      method: options?.method ?? "GET",
      headers: options?.headers,
      body: options?.body,
    });
  }

  // --- Producer / Provider API methods ---

  private getProducerClient(): L402ProducerClient {
    if (!this.leApiKey) {
      throw new Error(
        "Lightning Enable API key (leApiKey) is required for producer operations. " +
          "Pass leApiKey to AgentManager or set LIGHTNING_ENABLE_API_KEY env var."
      );
    }
    if (!this.producerClient) {
      this.producerClient = new L402ProducerClient({
        leApiKey: this.leApiKey,
        leApiBaseUrl: this.leApiBaseUrl,
      });
    }
    return this.producerClient;
  }

  /**
   * Create an L402 challenge for the requester to pay (provider side).
   *
   * Returns the agreement updated with invoice, macaroon, and paymentHash.
   */
  async createChallenge(
    agreement: AgentServiceAgreement,
    priceSats?: number,
    description?: string
  ): Promise<AgentServiceAgreement> {
    const producer = this.getProducerClient();
    const effectivePrice = priceSats ?? agreement.agreedPriceSats;

    const resource =
      `asa:${agreement.eventId || agreement.capabilityEventId}` +
      `:${agreement.requesterPubkey.substring(0, 16)}`;
    const desc =
      description ??
      `ASA settlement: ${agreement.terms || agreement.capabilityEventId}`;

    const result: L402ChallengeResponse = await producer.createChallenge(
      resource,
      effectivePrice,
      desc
    );

    if (!result.success) {
      throw new Error(`Failed to create L402 challenge: ${result.error}`);
    }

    agreement.invoice = result.invoice ?? null;
    agreement.macaroon = result.macaroon ?? null;
    agreement.paymentHash = result.paymentHash ?? null;
    agreement.settlementMode = "producer";

    return agreement;
  }

  /**
   * Verify an L402 token to confirm payment (provider side).
   * Returns true if the payment is valid.
   */
  async verifyPayment(macaroon: string, preimage: string): Promise<boolean> {
    const producer = this.getProducerClient();
    const result = await producer.verifyPayment(macaroon, preimage);

    if (!result.success) {
      throw new Error(`Failed to verify L402 payment: ${result.error}`);
    }

    return result.valid;
  }

  /**
   * Publish a reputation attestation for an agent.
   * Returns the Nostr event ID.
   */
  async publishAttestation(
    subjectPubkey: string,
    agreementId: string,
    rating: number,
    content: string
  ): Promise<string> {
    const attestation = new AgentAttestation({
      subjectPubkey,
      agreementEventId: agreementId,
      rating,
      content,
    });

    const tags = attestation.toNostrTags();
    const event = await NostrEvent.create({
      kind: AgentAttestation.KIND,
      content: attestation.content,
      tags,
      privateKey: this.privateKey,
    });

    return this.publishToRelays(event);
  }

  /**
   * Query relays for reputation attestations about a given pubkey.
   *
   * Only attestations carrying a rating within the valid 1-5 range are counted.
   * publishAttestation() enforces that range locally, but nothing stops a hostile
   * agent from putting any integer on the wire, and a single out-of-range rating
   * would otherwise skew the average arbitrarily.
   */
  async getReputation(pubkey: string): Promise<ReputationResult> {
    const nostrFilter = TagParser.buildFilter({
      kinds: [AgentAttestation.KIND],
      tags: { p: [pubkey] },
    });

    const rawEvents = await this.queryRelays([nostrFilter]);
    const attestations = rawEvents
      .map((e) => AgentAttestation.fromNostrEvent(e))
      .filter((a) => a.rating >= 1 && a.rating <= 5);

    if (attestations.length === 0) {
      return { average: 0, count: 0, attestations: [] };
    }

    const total = attestations.reduce((sum, a) => sum + a.rating, 0);
    return {
      average: total / attestations.length,
      count: attestations.length,
      attestations,
    };
  }
}
