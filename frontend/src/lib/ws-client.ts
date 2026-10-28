import { getConfig } from "@/lib/config";

type MessageHandler = (topic: string, payload: unknown) => void;
type ReconnectHandler = () => void;

interface StreamMessage {
  topic: string;
  payload: unknown;
}

interface ControlMessage {
  type?: string;
  topics?: string[];
  error?: string;
  ts?: number;
}

interface TopicOptions {
  passive: boolean;
}

export interface ChainDemandMessage {
  underlying: string;
  expiry: string;
  throttleMs: number;
  /** Analytics tiers to compute. `[]` means quotes only — no Greeks, SVI or
   *  model pricing. Omitting the field asks the backend for every tier. */
  analytics?: string[];
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private reconnectHandlers: ReconnectHandler[] = [];
  private desiredTopics = new Map<string, TopicOptions>();
  private pinnedTopics = new Set<string>(); // position topics — immune to unsubscribe
  // Current compute demand, replayed on reconnect alongside desiredTopics. A
  // socket that comes back without this would leave the server at whatever
  // cadence it last heard, which after a gateway restart is none at all.
  private desiredDemand: ChainDemandMessage[] = [];
  private hasConnectedBefore = false;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private intentionalClose = false;
  private lastActivityAt = 0;
  private connectionId = 0;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const { wsUrl } = getConfig();
    const connectionId = ++this.connectionId;
    this.intentionalClose = false;
    this.lastActivityAt = Date.now();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      if (connectionId !== this.connectionId) return;

      const isReconnect = this.hasConnectedBefore;
      this.hasConnectedBefore = true;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.markActivity();
      this.startHeartbeat(connectionId);
      this.flushSubscriptions();
      this.flushDemand();

      if (isReconnect) {
        for (const handler of this.reconnectHandlers) {
          handler();
        }
      }
    };

    this.ws.onmessage = (event: MessageEvent) => {
      if (connectionId !== this.connectionId) return;

      try {
        const message = JSON.parse(event.data as string) as StreamMessage | ControlMessage;
        this.markActivity();

        if (typeof (message as StreamMessage).topic === "string") {
          const streamMessage = message as StreamMessage;
          for (const handler of this.handlers) {
            handler(streamMessage.topic, streamMessage.payload);
          }
          return;
        }

        const control = message as ControlMessage;
        if (control.type === "ready") return;
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onerror = () => {
      // Error handling is managed by onclose via reconnect
    };

    this.ws.onclose = () => {
      if (connectionId !== this.connectionId) return;

      this.stopHeartbeat();
      this.ws = null;
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  subscribe(topics: string[], opts?: { passive?: boolean }): void {
    const passive = opts?.passive === true;
    for (const topic of topics) {
      const existing = this.desiredTopics.get(topic);
      this.desiredTopics.set(topic, { passive: passive || existing?.passive === true });
      if (passive) this.pinnedTopics.add(topic);
    }
    this.sendSubscriptionBatch(topics);
  }

  unsubscribe(topics: string[]): void {
    // Never unsubscribe pinned (position) topics via chain switches
    const actual = topics.filter((topic) => !this.pinnedTopics.has(topic));
    for (const topic of actual) {
      this.desiredTopics.delete(topic);
    }
    if (actual.length > 0) {
      this.send({ action: "unsubscribe", topics: actual });
    }
  }

  /** Unpin and unsubscribe position topics that are no longer needed. */
  unpinAndUnsubscribe(topics: string[]): void {
    for (const topic of topics) {
      this.pinnedTopics.delete(topic);
      this.desiredTopics.delete(topic);
    }
    if (topics.length > 0) {
      this.send({ action: "unsubscribe", topics });
    }
  }

  /**
   * State the complete set of chains this client needs computed, and how fast.
   *
   * Always the full set, never a delta: a lost or reordered message then costs
   * one stale interval rather than leaving a claim stuck on the server.
   * Re-sending an unchanged set is harmless and is how the periodic re-assert
   * repairs a server that restarted.
   */
  setDemand(chains: ChainDemandMessage[]): void {
    this.desiredDemand = chains;
    this.flushDemand();
  }

  private flushDemand(): void {
    this.send({ action: "demand", chains: this.desiredDemand });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((existing) => existing !== handler);
    };
  }

  onReconnect(handler: ReconnectHandler): () => void {
    this.reconnectHandlers.push(handler);
    return () => {
      this.reconnectHandlers = this.reconnectHandlers.filter((h) => h !== handler);
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.reconnectAttempts = 0;
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  private flushSubscriptions(): void {
    if (this.desiredTopics.size === 0) {
      return;
    }

    const passiveTopics: string[] = [];
    const activeTopics: string[] = [];
    for (const [topic, options] of this.desiredTopics.entries()) {
      if (options.passive) {
        passiveTopics.push(topic);
      } else {
        activeTopics.push(topic);
      }
    }

    if (activeTopics.length > 0) {
      this.send({ action: "subscribe", topics: activeTopics });
    }
    if (passiveTopics.length > 0) {
      this.send({ action: "subscribe", topics: passiveTopics, passive: true });
    }
  }

  private sendSubscriptionBatch(topics: string[]): void {
    if (topics.length === 0) return;

    const passiveTopics: string[] = [];
    const activeTopics: string[] = [];
    for (const topic of topics) {
      if (this.desiredTopics.get(topic)?.passive) {
        passiveTopics.push(topic);
      } else {
        activeTopics.push(topic);
      }
    }

    if (activeTopics.length > 0) {
      this.send({ action: "subscribe", topics: activeTopics });
    }
    if (passiveTopics.length > 0) {
      this.send({ action: "subscribe", topics: passiveTopics, passive: true });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(connectionId: number): void {
    this.stopHeartbeat();

    this.heartbeatTimer = setInterval(() => {
      if (connectionId !== this.connectionId) return;
      this.send({ action: "ping", ts: Date.now() });
    }, HEARTBEAT_INTERVAL_MS);

    this.staleTimer = setInterval(() => {
      if (connectionId !== this.connectionId) return;
      if (Date.now() - this.lastActivityAt <= STALE_CONNECTION_MS) return;
      this.ws?.close();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private markActivity(): void {
    this.lastActivityAt = Date.now();
  }
}

export const wsClient = new WSClient();
