/**
 * Lightning Enable Agent SDK -- discover, negotiate, and settle Agent Service Agreements.
 */

export { AgentCapability, AgentPricing } from "./models/capability.js";
export type { AgentCapabilityInit, AgentPricingInit } from "./models/capability.js";

export { AgentServiceRequest } from "./models/request.js";
export type { AgentServiceRequestInit } from "./models/request.js";

export { AgentServiceAgreement } from "./models/agreement.js";
export type { AgentServiceAgreementInit } from "./models/agreement.js";

export { AgentAttestation } from "./models/attestation.js";
export type { AgentAttestationInit } from "./models/attestation.js";

export { NostrEvent } from "./nostr/event.js";
export type { NostrEventData } from "./nostr/event.js";

export { RelayClient } from "./nostr/relay.js";
export type { RelayMessage, RelayMessageType } from "./nostr/relay.js";

export { TagParser } from "./nostr/tags.js";

export {
  L402Client,
  parseL402Challenge,
  parseMppChallenge,
  parsePaymentChallenge,
  decodeInvoiceAmountSats,
  validatePreimage,
} from "./l402/client.js";
export type {
  L402Challenge,
  MppChallenge,
  L402ClientOptions,
  PayInvoiceCallback,
} from "./l402/client.js";

export { L402ProducerClient } from "./l402/producer.js";
export type {
  L402ChallengeResponse,
  L402VerifyResponse,
  L402ProducerClientOptions,
} from "./l402/producer.js";

export { AgentManager } from "./agent/manager.js";
export type {
  AgentManagerOptions,
  DiscoverOptions,
  ReputationResult,
} from "./agent/manager.js";

export { CapabilityClient, ApprovalRequiredError, protect } from "./capabilities/client.js";
export type {
  CapabilityClientOptions,
  InvokeResult,
  IssueCredentialOptions,
  DelegateCredentialOptions,
  CredentialResult,
  ProtectOptions,
} from "./capabilities/client.js";
