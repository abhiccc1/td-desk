/**
 * Lot size management — fetched from scrip master via API.
 *
 * On startup the orchestrator calls `loadLotSizes()` which fetches
 * from `/api/v1/lot-sizes` and caches in memory. `getLotSize()` reads
 * from the cache with a hardcoded fallback for safety.
 */

const FALLBACK: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 65,
  MIDCPNIFTY: 50,
  SENSEX: 20,
  BANKEX: 20,
  // MCX (qty per lot; verified against Kotak mcx_fo scrip master 2026-09-25)
  CRUDEOIL: 100,
  CRUDEOILM: 10,
  NATURALGAS: 1250,
  NATGASMINI: 250,
  GOLD: 1,
  GOLDM: 100,
};

const DEFAULT_LOT_SIZE = 1;

let _lotSizes: Record<string, number> = {};

export function getLotSize(underlying: string): number {
  const key = underlying.toUpperCase();
  return _lotSizes[key] || FALLBACK[key] || DEFAULT_LOT_SIZE;
}

export function getAllLotSizes(): Record<string, number> {
  return { ...FALLBACK, ..._lotSizes };
}

export async function loadLotSizes(): Promise<void> {
  try {
    const { getConfig } = await import("@/lib/config");
    const { apiUrl } = getConfig();
    const resp = await fetch(`${apiUrl}/api/v1/lot-sizes`);
    if (resp.ok) {
      const data = await resp.json();
      if (data && typeof data === "object") {
        _lotSizes = data;
      }
    }
  } catch {
    // Fall back to hardcoded values
  }
}
