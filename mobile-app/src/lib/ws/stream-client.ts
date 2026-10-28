import { useConnectionStore } from "@/stores/use-connection-store";

type Listener = (topic: string, payload: unknown) => void;
type SubscribeOptions = { passive?: boolean };

export type ChainDemand = {
  underlying: string;
  expiry: string;
  throttleMs: number;
  /** Analytics tiers to compute. `[]` means quotes only — no Greeks, SVI or
   *  model pricing. Omitting the field asks the backend for every tier. */
  analytics?: string[];
};

const HEARTBEAT_INTERVAL_MS = 15_000;
const STALE_CONNECTION_MS = 45_000;

class StreamClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private desiredTopics = new Set<string>();
  private desiredDemand: ChainDemand[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectAttempts = 0;
  private intentionalClose = false;
  private lastActivityAt = 0;
  private connectionId = 0;

  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const { wsUrl } = useConnectionStore.getState().config;
    const connectionId = ++this.connectionId;
    this.intentionalClose = false;
    this.lastActivityAt = Date.now();
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      if (connectionId !== this.connectionId) return;

      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }

      this.markActivity();
      this.startHeartbeat(connectionId);
      if (this.desiredTopics.size > 0) {
        this.send({
          action: "subscribe",
          topics: [...this.desiredTopics],
        });
      }
      this.flushDemand();
    };

    this.ws.onmessage = (event) => {
      if (connectionId !== this.connectionId) return;

      try {
        const data = JSON.parse(event.data as string) as { topic?: string; payload?: unknown };
        this.markActivity();
        if (!data.topic) return;
        for (const listener of this.listeners) {
          listener(data.topic, data.payload);
        }
      } catch {
        // Ignore malformed payloads.
      }
    };

    this.ws.onclose = () => {
      if (connectionId !== this.connectionId) return;

      this.stopHeartbeat();
      this.ws = null;
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };

    this.ws.onerror = () => {
      // reconnect is handled by onclose
    };
  }

  forceReconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    this.ws?.close();
    this.ws = null;
    this.intentionalClose = false;
    this.connect();
  }

  subscribe(topics: string[], opts?: SubscribeOptions) {
    for (const topic of topics) this.desiredTopics.add(topic);
    this.send({ action: "subscribe", topics, ...(opts?.passive ? { passive: true } : {}) });
  }

  unsubscribe(topics: string[]) {
    for (const topic of topics) this.desiredTopics.delete(topic);
    this.send({ action: "unsubscribe", topics });
  }

  /**
   * State the complete set of chains this client needs computed, and how fast.
   *
   * Without this the gateway has no level for the chain and the market-data
   * service falls back to the desktop active rate — 40 snapshots a second,
   * each one a full IV/Greeks solve, for a phone screen.
   *
   * Always the full set, never a delta, and replayed on reconnect.
   */
  setDemand(chains: ChainDemand[]) {
    this.desiredDemand = chains;
    this.flushDemand();
  }

  private flushDemand() {
    this.send({ action: "demand", chains: this.desiredDemand });
  }

  onMessage(listener: Listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private send(payload: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      return;
    }

    const delay = Math.min(1_000 * 2 ** this.reconnectAttempts, 30_000);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(connectionId: number) {
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

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private markActivity() {
    this.lastActivityAt = Date.now();
  }
}

export const streamClient = new StreamClient();
