/**
 * Example: Agent that provides a translation service.
 *
 * This demonstrates how to:
 * 1. Publish an agent capability to Nostr relays
 * 2. Listen for incoming service requests
 * 3. Create agreements with requesters
 *
 * Usage:
 *   npx tsx examples/simple-provider.ts
 */

import {
  AgentManager,
  AgentCapability,
  AgentPricing,
} from "../src/index.js";

async function main() {
  // Initialize the agent manager with your Nostr private key
  const manager = new AgentManager({
    privateKey: "<your_hex_private_key>",
    relayUrls: ["wss://agents.lightningenable.com"],
    // For producer operations (creating invoices), provide an API key:
    // leApiKey: "<your_lightning_enable_api_key>",
  });

  // Define a capability to advertise
  const cap = new AgentCapability({
    serviceId: "translate-v1",
    categories: ["ai", "translation"],
    content:
      "AI translation service. Supports 50+ languages. " +
      "Send text with source/target language params.",
    pricing: [
      new AgentPricing({ amount: 10, unit: "sats", model: "per-request" }),
      new AgentPricing({ amount: 1, unit: "sats", model: "per-token" }),
    ],
    l402Endpoint:
      "https://api.lightningenable.com/l402/proxy/translate-abc123",
    apiEndpoint: "https://api.example.com/translate",
    apiMethod: "POST",
    schemaUrl: "https://api.example.com/schema/translate.json",
    hashtags: ["translation", "ai", "multilingual"],
  });

  // Publish the capability to relays
  const eventId = await manager.publishCapability(cap);
  console.log(`Published capability: ${eventId}`);
  console.log(`Service ID: ${cap.serviceId}`);
  console.log(`Categories: ${cap.categories.join(", ")}`);
  console.log(
    `Pricing: ${cap.pricing[0].amount} ${cap.pricing[0].unit}/${cap.pricing[0].model}`
  );
  console.log();

  // Listen for incoming service requests
  console.log("Listening for service requests...");
  for await (const request of manager.listenRequests()) {
    console.log(`Received request from ${request.pubkey}`);
    console.log(`  Budget: ${request.budgetSats} sats`);
    console.log(`  Params: ${JSON.stringify(request.params)}`);
    console.log(`  Content: ${request.content}`);

    // Create an agreement
    const agreement = await manager.publishAgreement({
      requestEventId: request.eventId,
      capabilityEventId: eventId,
      requesterPubkey: request.pubkey,
      agreedPriceSats: Math.min(request.budgetSats, cap.pricing[0].amount),
      l402Endpoint: cap.l402Endpoint ?? "",
      terms: "Max 10 requests per minute. Results in JSON.",
    });
    console.log(`  Published agreement: ${agreement.eventId}`);
  }
}

main().catch(console.error);
