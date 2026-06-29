# le-agent-sdk

[![Discord](https://img.shields.io/discord/1405389254892195951?label=community&logo=discord&color=5865F2)](https://discord.gg/rX7NxHY8vx)


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
