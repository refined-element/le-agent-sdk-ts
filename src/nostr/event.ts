/**
 * Nostr event builder and signing (NIP-01).
 *
 * Handles event creation, ID computation (SHA-256 of canonical serialization),
 * and Schnorr signing (BIP-340) via @noble/secp256k1.
 */

import { schnorr } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";

export interface NostrEventData {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
  sig: string;
}

export class NostrEvent {
  /**
   * Serialize an event for ID computation per NIP-01.
   *
   * The canonical form is:
   *   [0, <pubkey>, <created_at>, <kind>, <tags>, <content>]
   */
  static serializeForId(event: {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  }): string {
    const commitment = [
      0,
      event.pubkey,
      event.created_at,
      event.kind,
      event.tags,
      event.content,
    ];
    return JSON.stringify(commitment);
  }

  /** Compute the event ID (SHA-256 hex digest of canonical serialization). */
  static computeId(event: {
    pubkey: string;
    created_at: number;
    kind: number;
    tags: string[][];
    content: string;
  }): string {
    const serialized = NostrEvent.serializeForId(event);
    const hash = sha256(new TextEncoder().encode(serialized));
    return bytesToHex(hash);
  }

  /**
   * Derive the x-only public key from a hex private key.
   * Returns 32-byte x-only public key as hex string.
   */
  static pubkeyFromPrivateKey(privateKeyHex: string): string {
    const privkeyBytes = hexToBytes(privateKeyHex);
    if (privkeyBytes.length !== 32) {
      throw new Error(
        `Private key must be 32 bytes, got ${privkeyBytes.length} bytes`
      );
    }
    const pubkeyBytes = schnorr.getPublicKey(privkeyBytes);
    return bytesToHex(pubkeyBytes);
  }

  /**
   * Create a Schnorr signature (BIP-340) over the event ID.
   * Returns 64-byte signature as hex string.
   */
  static async sign(
    eventIdHex: string,
    privateKeyHex: string
  ): Promise<string> {
    const msgBytes = hexToBytes(eventIdHex);
    const privkeyBytes = hexToBytes(privateKeyHex);
    if (privkeyBytes.length !== 32) {
      throw new Error(
        `Private key must be 32 bytes, got ${privkeyBytes.length} bytes`
      );
    }
    const sig = await schnorr.sign(msgBytes, privkeyBytes);
    return bytesToHex(sig);
  }

  /**
   * Verify a Nostr event's ID and signature.
   * Returns true if valid, false otherwise.
   */
  static async verify(event: NostrEventData): Promise<boolean> {
    const computedId = NostrEvent.computeId(event);
    if (computedId !== event.id) return false;

    if (!event.pubkey || !event.sig) return false;

    try {
      const msgBytes = hexToBytes(event.id);
      const sigBytes = hexToBytes(event.sig);
      const pubkeyBytes = hexToBytes(event.pubkey);
      return await schnorr.verify(sigBytes, msgBytes, pubkeyBytes);
    } catch {
      return false;
    }
  }

  /**
   * Create a Nostr event, optionally signed.
   *
   * If privateKey is provided, the event is signed. Otherwise, an unsigned
   * event is returned with empty sig (for external signing).
   */
  static async create(options: {
    kind: number;
    content: string;
    tags: string[][];
    privateKey?: string;
    createdAt?: number;
    pubkey?: string;
  }): Promise<NostrEventData> {
    const createdAt = options.createdAt ?? Math.floor(Date.now() / 1000);

    let derivedPubkey: string;
    if (options.privateKey) {
      derivedPubkey = NostrEvent.pubkeyFromPrivateKey(options.privateKey);
    } else if (options.pubkey) {
      derivedPubkey = options.pubkey;
    } else {
      derivedPubkey = "";
    }

    const event: NostrEventData = {
      id: "",
      pubkey: derivedPubkey,
      created_at: createdAt,
      kind: options.kind,
      tags: options.tags,
      content: options.content,
      sig: "",
    };

    event.id = NostrEvent.computeId(event);

    if (options.privateKey) {
      event.sig = await NostrEvent.sign(event.id, options.privateKey);
    }

    return event;
  }

  /**
   * Create an unsigned Nostr event for external signing.
   * Returns event with computed ID but empty sig.
   */
  static async createUnsigned(options: {
    kind: number;
    content: string;
    tags: string[][];
    pubkey: string;
    createdAt?: number;
  }): Promise<NostrEventData> {
    return NostrEvent.create({
      kind: options.kind,
      content: options.content,
      tags: options.tags,
      pubkey: options.pubkey,
      createdAt: options.createdAt,
    });
  }
}
