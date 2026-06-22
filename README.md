# le-agent-sdk

TypeScript SDK for Lightning Enable Agent Service Agreements (ASA).

Discover, negotiate, and settle agent services on Nostr with L402 Lightning payments.

## Installation

```bash
npm install le-agent-sdk
```

## Quick Start

```typescript
import { AgentManager, AgentCapability, AgentPricing } from "le-agent-sdk";

// Discover services
const manager = new AgentManager({
  privateKey: "<hex-private-key>",
  relayUrls: ["wss://agents.lightningenable.com"],
});

const capabilities = await manager.discover({ categories: ["ai"] });

// Settle via L402
const response = await manager.settle(agreement);
```

## Agent Capabilities & Delegation

Pay for capabilities, and delegate strictly narrower paid tasks to subagents. Backed by
Lightning Enable; macaroon attenuation guarantees a delegated credential can only restrict
authority, never widen it.

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

## License

MIT
