/**
 * Example: Agent that discovers and uses translation services.
 *
 * This demonstrates how to:
 * 1. Discover available agent capabilities on the network
 * 2. Send a service request
 * 3. Settle via L402 payment
 *
 * Usage:
 *   npx tsx examples/simple-requester.ts
 */

import { AgentManager } from "../src/index.js";

async function main() {
  // Initialize the agent manager with your Nostr private key
  // For L402 auto-payment, provide a payInvoiceCallback
  const manager = new AgentManager({
    privateKey: "<your_hex_private_key>",
    relayUrls: ["wss://agents.lightningenable.com"],
    // payInvoiceCallback: async (invoice) => { return "<preimage_hex>"; },
  });

  // Discover translation services
  console.log("Searching for translation services...");
  const capabilities = await manager.discover({
    categories: ["translation"],
    hashtags: ["ai"],
    limit: 10,
  });
  console.log(`Found ${capabilities.length} services\n`);

  for (const cap of capabilities) {
    console.log(`  [${cap.serviceId}] ${cap.content.substring(0, 60)}...`);
    if (cap.pricing.length > 0) {
      console.log(
        `    Price: ${cap.pricing[0].amount} ${cap.pricing[0].unit}/${cap.pricing[0].model}`
      );
    }
    if (cap.l402Endpoint) {
      console.log(`    L402: ${cap.l402Endpoint}`);
    }
    console.log();
  }

  if (capabilities.length === 0) {
    console.log("No services found. Try publishing a capability first.");
    return;
  }

  // Pick the first capability
  const chosen = capabilities[0];
  console.log(`Using service: ${chosen.serviceId}`);

  // Option A: Direct L402 settlement (skip the request/agreement steps)
  if (chosen.l402Endpoint) {
    console.log(`Settling via L402 at ${chosen.l402Endpoint}`);
    try {
      const result = await manager.settleViaL402(chosen);
      console.log(`Result: HTTP ${result.status}`);
      console.log(`Body: ${(await result.text()).substring(0, 200)}`);
    } catch (e) {
      console.log(`Settlement failed: ${e}`);
      console.log("(Configure payInvoiceCallback for auto-payment)");
    }
  } else {
    // Option B: Send a service request and wait for an agreement
    console.log("No L402 endpoint; sending service request...");
    const request = await manager.requestService(
      chosen.eventId,
      chosen.pubkey,
      100,
      { source_lang: "en", target_lang: "es" },
      "Please translate: Hello, how are you?"
    );
    console.log(`Sent request: ${request.eventId}`);
    console.log("Waiting for provider to respond with an agreement...");
  }
}

main().catch(console.error);
