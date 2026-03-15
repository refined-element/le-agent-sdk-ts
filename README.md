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

## License

MIT
