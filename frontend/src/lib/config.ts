/**
 * Runtime configuration — reads from localStorage, falls back to build-time env vars.
 * This allows the Tauri desktop app to reconfigure without rebuilding.
 */

const STORAGE_KEY = "td-desk:config";

export interface AppConfig {
  apiUrl: string;
  wsUrl: string;
  kotakMobile: string;
  kotakUcc: string;
}

const DEFAULTS: AppConfig = {
  apiUrl: process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000",
  wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8000/ws/stream",
  kotakMobile: process.env.NEXT_PUBLIC_KOTAK_MOBILE ?? "",
  kotakUcc: process.env.NEXT_PUBLIC_KOTAK_UCC ?? "",
};

function load(): AppConfig {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<AppConfig>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

let _cached: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (!_cached) _cached = load();
  return _cached;
}

export function saveConfig(config: AppConfig): void {
  _cached = config;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function resetConfig(): void {
  _cached = null;
  localStorage.removeItem(STORAGE_KEY);
}
