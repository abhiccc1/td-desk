import { getConfig } from "@/lib/config";

type MessageHandler = (topic: string, payload: unknown) => void;

interface WSMessage {
  topic: string;
  payload: unknown;
}

export class WSClient {
  private ws: WebSocket | null = null;
  private handlers: MessageHandler[] = [];
  private desiredTopics = new Set<string>();
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30_000;
  private baseReconnectDelay = 1_000;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;

  connect(): void {
    if (process.env.NEXT_PUBLIC_MOCK_MODE === "true") {
      return; // Mock ticker handles data injection; no real WS needed
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const { wsUrl } = getConfig();
    this.intentionalClose = false;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.flushSubscriptions();
    };

    this.ws.onmessage = (event: MessageEvent) => {
      try {
        const message = JSON.parse(event.data as string) as WSMessage;
        for (const handler of this.handlers) {
          handler(message.topic, message.payload);
        }
      } catch {
        // Ignore malformed messages
      }
    };

    this.ws.onerror = () => {
      // Error handling is managed by onclose via reconnect
    };

    this.ws.onclose = () => {
      if (!this.intentionalClose) {
        this.scheduleReconnect();
      }
    };
  }

  subscribe(topics: string[]): void {
    for (const topic of topics) {
      this.desiredTopics.add(topic);
    }
    this.send({ action: "subscribe", topics });
  }

  unsubscribe(topics: string[]): void {
    for (const topic of topics) {
      this.desiredTopics.delete(topic);
    }
    this.send({ action: "unsubscribe", topics });
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((existing) => existing !== handler);
    };
  }

  disconnect(): void {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
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
    this.send({ action: "subscribe", topics: [...this.desiredTopics] });
  }

  private scheduleReconnect(): void {
    const delay = Math.min(
      this.baseReconnectDelay * Math.pow(2, this.reconnectAttempts),
      this.maxReconnectDelay,
    );
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }
}

export const wsClient = new WSClient();
