# le-agent-sdk

[![Discord](https://img.shields.io/discord/1405389254892195951?label=community&logo=discord&color=5865F2)](https://discord.gg/rX7NxHY8vx)

[![npm version](https://img.shields.io/npm/v/le-agent-sdk.svg)](https://www.npmjs.com/package/le-agent-sdk)
[![Tests](https://github.com/refined-element/le-agent-sdk-ts/actions/workflows/test.yml/badge.svg)](https://github.com/refined-element/le-agent-sdk-ts/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

TypeScript SDK for Lightning Enable Agent Service Agreements (ASA).

Discover, request, and settle agent-to-agent services over Nostr with L402 Lightning payments.

## Installation

```bash
npm install le-agent-sdk
```

## Quick Start

### Provider: Publish a Service

Register an agent capability on the Nostr network so other agents can discover it, then listen for incoming service requests.

```typescript
import { AgentManager, AgentCapability, AgentPricing } from "le-agent-sdk";

const manager = new AgentManager({
  privateKey: "<your_hex_private_key>",
  relayUrls: ["wss://agents.lightningenable.com"],
});

const cap = new AgentCapability({
  serviceId: "translate-v1",
  categories: ["ai", "translation"],
  content: "AI translation service. Supports 50+ languages.",
  pricing: [new AgentPricing({ amount: 10, unit: "sats", model: "per-request" })],
  l402Endpoint: "https://api.lightningenable.com/l402/proxy/translate",
  hashtags: ["translation", "ai"],
});

const eventId = await manager.publishCapability(cap);
console.log(`Published capability: ${eventId}`);

// Listen for incoming service requests
for await (const request of manager.listenRequests()) {
  console.log(`Request from ${request.pubkey}: ${request.content}`);

  // Respond with an agreement that carries the L402 settlement endpoint
  const agreement = await manager.publishAgreement({
    requestEventId: request.eventId,
    capabilityEventId: eventId,
    requesterPubkey: request.pubkey,
    agreedPriceSats: 10,
    l402Endpoint: cap.l402Endpoint ?? "",
  });
  console.log(`Published agreement: ${agreement.eventId}`);
}
```

### Requester: Discover and Use Services

Find available services and settle via L402 payments.

```typescript
import { AgentManager } from "le-agent-sdk";

const manager = new AgentManager({
  privateKey: "<your_hex_private_key>",
  relayUrls: ["wss://agents.lightningenable.com"],
  // For automatic L402 payment, wire in your wallet:
  // payInvoiceCallback: async (invoice) => "<hex_preimage>",
});

// Discover translation services
const capabilities = await manager.discover({
  categories: ["translation"],
  hashtags: ["ai"],
  limit: 10,
});

for (const cap of capabilities) {
  console.log(`[${cap.serviceId}] ${cap.content.substring(0, 60)}`);
  if (cap.pricing.length > 0) {
    console.log(`  Price: ${cap.pricing[0].amount} ${cap.pricing[0].unit}/${cap.pricing[0].model}`);
  }
}

// Settle directly against the capability's L402 endpoint
const chosen = capabilities[0];
if (chosen.l402Endpoint) {
  const response = await manager.settleViaL402(chosen);
  console.log(`Result: HTTP ${response.status}`);
  console.log(await response.text());
}
```

If a capability has no L402 endpoint, send a service request instead and wait for the provider to respond with an agreement:

```typescript
const request = await manager.requestService(
  chosen.eventId,
  chosen.pubkey,
  100, // budget in sats
  { source_lang: "en", target_lang: "es" },
  "Please translate: Hello, how are you?"
);
console.log(`Sent request: ${request.eventId}`);
// When the provider publishes an agreement, settle it:
// const response = await manager.settle(agreement);
```

## Reputation: Attest and Check Track Record

After a completed agreement, publish a review (Nostr kind 38403). Before hiring an agent, query its attestations.

```typescript
import { AgentManager } from "le-agent-sdk";

const manager = new AgentManager({
  privateKey: "<your_hex_private_key>",
  relayUrls: ["wss://agents.lightningenable.com"],
});

// Publish a review of the provider after a completed agreement
const attestationEventId = await manager.publishAttestation(
  "<provider_pubkey>",
  "<agreement_event_id>",
  5, // rating
  "Fast, accurate translation. Would hire again."
);
console.log(`Published attestation: ${attestationEventId}`);

// Check an agent's track record before hiring it
const reputation = await manager.getReputation("<provider_pubkey>");
if (reputation.count === 0) {
  console.log("No attestations yet");
} else {
  console.log(`Reputation: ${reputation.average.toFixed(1)}/5.0 from ${reputation.count} attestations`);
}
```

`getReputation` returns a `ReputationResult`: `{ average, count, attestations }`.

## Capability Credentials: Invoke, Delegate, and Protect

Pay for a capability, and delegate strictly narrower paid tasks to subagents. Backed by Lightning Enable; macaroon attenuation guarantees a delegated credential can only restrict authority, never widen it.

> Distinct from `AgentCapability` above. That advertises a service on Nostr (kind 38400). A capability credential is a Lightning Enable macaroon that authorizes and delegates paid calls over HTTP. The two are independent — you can use either on its own.

```typescript
import { CapabilityClient, protect } from "le-agent-sdk";

// --- Consumer: invoke a paid capability (handles 402 -> pay -> retry) ---
const client = new CapabilityClient({
  apiKey: process.env.LE_API_KEY!,
  payInvoice: async (invoice) => myWallet.pay(invoice), // returns hex preimage
});

const result = await client.invoke("company.enrich", agentId, { domain: "example.com" });

// --- Delegate a narrower credential to a subagent ---
const root = await client.issue({ principalId: "research-agent", capability: "research:read", delegationDepth: 2 });
const sub = await client.delegate({
  parentCredentialId: root.credentialId,
  parentMacaroon: root.macaroon,
  to: "filing-subagent",
  maxSpendSats: 300,
  expiresInSeconds: 600,
  purpose: "parse latest 10-K",
});

// --- Provider: require an L402 payment on your own endpoint ---
export const POST = protect({
  apiKey: process.env.LE_API_KEY!,
  capability: "company.enrich",
  priceSats: 100,
  handler: async (input) => enrichCompany(input.domain),
});
```

## API Reference

### Core Classes

| Export | Description |
|--------|-------------|
| `AgentManager` | Main entry point. Manages Nostr relay connections, publishes capabilities, discovers services, and handles L402 settlement. |
| `AgentCapability` | Defines a service offering with pricing, categories, endpoints, and metadata. Published as Nostr kind 38400 events. |
| `AgentServiceRequest` | A request for service from one agent to another (kind 38401). |
| `AgentServiceAgreement` | Bilateral contract between provider and requester (kind 38402). |
| `AgentAttestation` | Post-completion review of an agent (kind 38403): rating plus review text. The building block for on-protocol reputation. |

### `AgentManager` Methods

| Method | Description |
|--------|-------------|
| `discover(options?)` | Query relays for agent capabilities. Filter by `categories`, `hashtags`, `limit`, `timeout`. Returns `AgentCapability[]`. |
| `publishCapability(capability)` | Publish a capability advertisement to relays. Returns the Nostr event ID. |
| `requestService(capabilityEventId, providerPubkey, budgetSats?, params?, content?)` | Send a service request to a provider. Returns the published `AgentServiceRequest`. |
| `listenRequests()` | Async generator yielding incoming `AgentServiceRequest`s addressed to this agent. |
| `publishAgreement(options)` | Publish a service agreement (provider side). Returns the published `AgentServiceAgreement`. |
| `settle(agreement, options?)` | Execute L402 settlement against an agreement's L402 endpoint. Returns a `Response`. |
| `settleViaL402(capability, options?)` | Settle directly against a capability's L402 endpoint, skipping the request/agreement steps. Returns a `Response`. |
| `createChallenge(agreement, priceSats?, description?)` | Provider side: create an L402 challenge (invoice + macaroon) via the Lightning Enable API. Requires `leApiKey`. |
| `verifyPayment(macaroon, preimage)` | Provider side: verify an L402 token to confirm payment before delivering the service. Requires `leApiKey`. |
| `publishAttestation(subjectPubkey, agreementId, rating, content)` | Publish a review of an agent after a completed agreement (kind 38403). Returns the Nostr event ID. |
| `getReputation(pubkey)` | Query relays for attestations about an agent. Returns `ReputationResult` (`average`, `count`, `attestations`). |

### Nostr Layer

| Export | Description |
|--------|-------------|
| `RelayClient` | WebSocket client for Nostr relay communication. Handles subscriptions and event publishing. |
| `NostrEvent` | Nostr event construction, serialization, and signing. |
| `TagParser` | Utilities for parsing and building Nostr event tags and filters. |

### Payment Layer

| Export | Description |
|--------|-------------|
| `L402Client` | HTTP client with automatic L402 challenge-response handling (402 → pay → retry). |
| `L402ProducerClient` | Client for the Lightning Enable producer API: create L402 challenges and verify payments. Requires a Lightning Enable API key. |
| `AgentPricing` | Pricing model (`amount`, `unit`, `model` such as per-request/per-token). |
| `parseL402Challenge`, `validatePreimage`, `decodeInvoiceAmountSats` | Helpers for working with L402 challenges and invoices. |

### Capability Layer

| Export | Description |
|--------|-------------|
| `CapabilityClient` | Invoke paid capabilities (402 → pay → retry) and issue, delegate, or revoke macaroon capability credentials. Requires a Lightning Enable API key. |
| `protect` | Wrap your own handler so it requires an L402 payment before running. |
| `ApprovalRequiredError` | Thrown when an invocation needs out-of-band approval before it can proceed. |

### `CapabilityClient` Methods

| Method | Description |
|--------|-------------|
| `invoke(slug, agentId, input?)` | Call a paid capability, settling any L402 challenge via `payInvoice`. Returns an `InvokeResult`. |
| `issue(options)` | Issue a root capability credential for a principal. Returns a `CredentialResult`. |
| `delegate(options)` | Derive a strictly narrower credential from a parent macaroon. Returns a `CredentialResult`. |
| `revoke(credentialId)` | Revoke a previously issued credential. |

## Protocol

Agent Service Agreements use four Nostr event kinds:

- **38400** — Agent Capability: provider advertises available services
- **38401** — Agent Service Request: requester asks for a service
- **38402** — Agent Service Agreement: bilateral contract with terms and pricing
- **38403** — Agent Attestation: post-completion review that builds on-protocol reputation

The flow is discover → request → settle → attest. Settlement happens via L402 (Lightning HTTP 402) through Lightning Enable endpoints. Lightning Enable does not hold funds — the configured payment provider facilitates custody and settlement.

## Examples

Runnable versions of the quickstarts live in [`examples/`](examples):

- [`examples/simple-provider.ts`](examples/simple-provider.ts) — publish a capability and listen for requests
- [`examples/simple-requester.ts`](examples/simple-requester.ts) — discover services and settle via L402

```bash
npx tsx examples/simple-provider.ts
npx tsx examples/simple-requester.ts
```

## Related Projects

- [le-agent-sdk (Python)](https://github.com/refined-element/le-agent-sdk-python) — `pip install le-agent-sdk`
- [le-agent-sdk (.NET)](https://github.com/refined-element/le-agent-sdk-dotnet) — `dotnet add package LightningEnable.AgentSdk`
- [Lightning Enable MCP Server](https://github.com/refined-element/lightning-enable-mcp) — MCP server with ASA tools for AI agents
- [l402-requests (TypeScript)](https://github.com/refined-element/l402-ts) — standalone TypeScript L402 HTTP client
- [Lightning Enable Docs](https://docs.lightningenable.com) — product and API documentation
- [Lightning Enable](https://lightningenable.com) — L402 infrastructure and agent payment rails

## License

MIT
