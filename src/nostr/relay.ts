/**
 * WebSocket relay client for Nostr (NIP-01 protocol).
 *
 * Uses the `ws` package for Node.js WebSocket connections.
 */

import WebSocket from "ws";

export type RelayMessageType = "EVENT" | "EOSE" | "OK" | "NOTICE";
export type RelayMessage =
  | { type: "EVENT"; subscriptionId: string; event: Record<string, unknown> }
  | { type: "EOSE"; subscriptionId: string }
  | { type: "OK"; eventId: string; accepted: boolean; message: string }
  | { type: "NOTICE"; message: string };

export class RelayClient {
  private ws: WebSocket | null = null;
  private url = "";
  private subscriptions: Map<string, Record<string, unknown>[]> = new Map();

  /** True if the WebSocket connection is open. */
  get isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** Connect to a Nostr relay. */
  async connect(url: string): Promise<void> {
    this.url = url;
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Connection timeout: ${url}`));
      }, 10_000);

      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        resolve();
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  /** Close the WebSocket connection. */
  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Reconnect to the last connected relay URL.
   * Closes existing connection and resubscribes to all active subscriptions.
   */
  async reconnect(): Promise<void> {
    if (!this.url) {
      throw new Error("Cannot reconnect: no previous URL");
    }

    const savedSubscriptions = new Map(this.subscriptions);
    await this.close();
    await this.connect(this.url);

    for (const [subId, filters] of savedSubscriptions) {
      if (!this.ws) throw new Error("Not connected");
      const message = JSON.stringify(["REQ", subId, ...filters]);
      this.ws.send(message);
      this.subscriptions.set(subId, filters);
    }
  }

  /**
   * Publish a Nostr event to the relay.
   * Sends ["EVENT", <event>] and waits for the OK response.
   */
  async publish(
    event: Record<string, unknown>,
    timeout = 10_000
  ): Promise<boolean> {
    if (!this.ws) throw new Error("Not connected to a relay");

    const eventId = event.id as string;
    const message = JSON.stringify(["EVENT", event]);
    this.ws.send(message);

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.ws?.removeListener("message", handler);
        resolve(false);
      }, timeout);

      const handler = (data: WebSocket.Data) => {
        try {
          const msg = JSON.parse(String(data));
          if (
            Array.isArray(msg) &&
            msg[0] === "OK" &&
            msg.length >= 3 &&
            msg[1] === eventId
          ) {
            clearTimeout(timer);
            this.ws?.removeListener("message", handler);
            resolve(Boolean(msg[2]));
          }
        } catch {
          // Ignore parse errors
        }
      };

      this.ws!.on("message", handler);
    });
  }

  /**
   * Subscribe to events matching the given filters.
   * Sends ["REQ", <subId>, <filter1>, ...].
   */
  async subscribe(
    filters: Record<string, unknown>[],
    subscriptionId?: string
  ): Promise<string> {
    if (!this.ws) throw new Error("Not connected to a relay");

    const subId =
      subscriptionId ?? Math.random().toString(36).substring(2, 18);
    this.subscriptions.set(subId, filters);

    const message = JSON.stringify(["REQ", subId, ...filters]);
    this.ws.send(message);

    return subId;
  }

  /** Close a subscription. Sends ["CLOSE", <subId>]. */
  async unsubscribe(subscriptionId: string): Promise<void> {
    if (!this.ws) throw new Error("Not connected to a relay");

    const message = JSON.stringify(["CLOSE", subscriptionId]);
    this.ws.send(message);
    this.subscriptions.delete(subscriptionId);
  }

  /**
   * Yield incoming relay messages as parsed RelayMessage objects.
   * Returns an async iterable.
   */
  async *listen(): AsyncGenerator<RelayMessage> {
    if (!this.ws) throw new Error("Not connected to a relay");

    const ws = this.ws;
    const queue: RelayMessage[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    const handler = (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(String(data));
        if (!Array.isArray(msg) || msg.length < 2) return;

        const msgType = msg[0] as string;
        let parsed: RelayMessage | null = null;

        if (msgType === "EVENT" && msg.length >= 3) {
          parsed = {
            type: "EVENT",
            subscriptionId: msg[1],
            event: msg[2],
          };
        } else if (msgType === "EOSE" && msg.length >= 2) {
          parsed = { type: "EOSE", subscriptionId: msg[1] };
        } else if (msgType === "OK" && msg.length >= 4) {
          parsed = {
            type: "OK",
            eventId: msg[1],
            accepted: msg[2],
            message: msg[3],
          };
        } else if (msgType === "NOTICE" && msg.length >= 2) {
          parsed = { type: "NOTICE", message: msg[1] };
        }

        if (parsed) {
          queue.push(parsed);
          if (resolve) {
            resolve();
            resolve = null;
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    const closeHandler = () => {
      done = true;
      if (resolve) {
        resolve();
        resolve = null;
      }
    };

    ws.on("message", handler);
    ws.on("close", closeHandler);

    try {
      while (!done) {
        if (queue.length > 0) {
          yield queue.shift()!;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
      // Drain remaining queue
      while (queue.length > 0) {
        yield queue.shift()!;
      }
    } finally {
      ws.removeListener("message", handler);
      ws.removeListener("close", closeHandler);
    }
  }

  /**
   * Subscribe, collect events until EOSE, then unsubscribe.
   * Convenience method for one-shot queries.
   */
  async collectEvents(
    filters: Record<string, unknown>[],
    timeout = 5_000
  ): Promise<Record<string, unknown>[]> {
    const subId = await this.subscribe(filters);
    const events: Record<string, unknown>[] = [];

    try {
      await Promise.race([
        (async () => {
          for await (const msg of this.listen()) {
            if (msg.type === "EVENT" && msg.subscriptionId === subId) {
              events.push(msg.event);
            } else if (msg.type === "EOSE" && msg.subscriptionId === subId) {
              break;
            }
          }
        })(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("timeout")), timeout)
        ),
      ]);
    } catch {
      // Timeout or connection error
    } finally {
      try {
        await this.unsubscribe(subId);
      } catch {
        // Ignore unsubscribe errors
      }
    }

    return events;
  }
}
