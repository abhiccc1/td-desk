export function normalizeApiUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "http://localhost:8000";
  const withScheme = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/, "");
}

export function normalizeWsUrl(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "ws://localhost:8000/ws/stream";

  if (trimmed.startsWith("http://")) {
    return `${trimmed.replace("http://", "ws://").replace(/\/+$/, "")}/ws/stream`.replace(/\/ws\/stream\/ws\/stream$/, "/ws/stream");
  }
  if (trimmed.startsWith("https://")) {
    return `${trimmed.replace("https://", "wss://").replace(/\/+$/, "")}/ws/stream`.replace(/\/ws\/stream\/ws\/stream$/, "/ws/stream");
  }
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) {
    return trimmed.replace(/\/+$/, "").endsWith("/ws/stream")
      ? trimmed.replace(/\/+$/, "")
      : `${trimmed.replace(/\/+$/, "")}/ws/stream`;
  }

  return `ws://${trimmed.replace(/\/+$/, "")}/ws/stream`;
}
