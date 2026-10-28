/**
 * Instrument metadata — the frontend mirror of backend `shared/instruments.py`.
 *
 * Loaded once from `/api/v1/underlyings` by the orchestrator and held in a
 * module registry (like `lot-sizes.ts`) so pure helpers can use it without a
 * React hook. Components that need to re-render on load read
 * `useMarketDataStore().underlyingMeta` instead.
 *
 * Key MCX facts (verified against Kotak's scrip master):
 * - Order quantity is in units (lots × lotSize), same as NSE.
 * - Rupee value = price × qty × unitMultiplier, where unitMultiplier =
 *   pnlMultiplier / lotSize (GOLD 100: qty in kg, price per 10 g;
 *   GOLDM 0.1; everything else 1).
 * - Options are on the underlying FUTURE (Black-76), and trade until the
 *   evening close: 23:30 IST while the US is on DST, 23:55 otherwise.
 */

export type Segment = "EQ_IDX" | "MCX";

export const SEGMENT_LABELS: Record<Segment, string> = {
  EQ_IDX: "NSE+BSE",
  MCX: "MCX",
};

export interface UnderlyingMeta {
  name: string;
  displayName: string;
  exchange: string; // "NSE" | "BSE" | "MCX"
  lotSize: number;
  enabled: boolean;
  assetClass: "index" | "commodity";
  pnlMultiplier: number;
  sessionClose: string; // "HH:MM" IST | "mcx_evening"
}

let _meta: Record<string, UnderlyingMeta> = {};

export function setUnderlyingMeta(list: UnderlyingMeta[]): void {
  _meta = Object.fromEntries(list.map((u) => [u.name.toUpperCase(), u]));
}

export function getUnderlyingMeta(underlying: string | null | undefined): UnderlyingMeta | undefined {
  return underlying ? _meta[underlying.toUpperCase()] : undefined;
}

/** Parse the backend payload, tolerating the older name-only shape. */
export function parseUnderlyings(data: unknown): UnderlyingMeta[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((raw): UnderlyingMeta | null => {
      if (typeof raw === "string") {
        return {
          name: raw, displayName: raw, exchange: "NSE", lotSize: 1, enabled: true,
          assetClass: "index", pnlMultiplier: 1, sessionClose: "15:30",
        };
      }
      if (!raw || typeof raw !== "object" || typeof (raw as { name?: unknown }).name !== "string") {
        return null;
      }
      const u = raw as Partial<UnderlyingMeta> & { name: string };
      const lotSize = Number(u.lotSize) || 1;
      return {
        name: u.name,
        displayName: u.displayName || u.name,
        exchange: (u.exchange || "NSE").toUpperCase(),
        lotSize,
        enabled: u.enabled !== false,
        assetClass: u.assetClass === "commodity" ? "commodity" : "index",
        pnlMultiplier: Number(u.pnlMultiplier) || lotSize,
        sessionClose: u.sessionClose || "15:30",
      };
    })
    .filter((u): u is UnderlyingMeta => u !== null);
}

/* ------------------------------------------------------------------ */
/*  Segments                                                          */
/* ------------------------------------------------------------------ */

/** Map an exchange label or Kotak segment ("MCX", "mcx_fo", "NSE", "nse_fo"…) to a segment. */
export function segmentOfExchange(exchange: string | null | undefined): Segment {
  return (exchange || "").toLowerCase().startsWith("mcx") ? "MCX" : "EQ_IDX";
}

export function segmentOfUnderlying(underlying: string | null | undefined): Segment {
  const meta = getUnderlyingMeta(underlying);
  return meta ? segmentOfExchange(meta.exchange) : "EQ_IDX";
}

export function isFuturesUnderlying(underlying: string | null | undefined): boolean {
  return getUnderlyingMeta(underlying)?.assetClass === "commodity";
}

/** "Spot" for index options, "Fut" for options on futures. */
export function underlyingPriceLabel(underlying: string | null | undefined): "Spot" | "Fut" {
  return isFuturesUnderlying(underlying) ? "Fut" : "Spot";
}

/* ------------------------------------------------------------------ */
/*  Rupee value                                                       */
/* ------------------------------------------------------------------ */

/**
 * ₹ per unit of order quantity per ₹1 of quoted price.
 * 1 for NSE/BSE and unknown underlyings; GOLD 100, GOLDM 0.1.
 */
export function unitMultiplier(underlying: string | null | undefined): number {
  const meta = getUnderlyingMeta(underlying);
  if (!meta || !meta.lotSize) return 1;
  return meta.pnlMultiplier / meta.lotSize;
}

/**
 * Value multiplier for a position row. Prefers the backend's explicit
 * `valueMultiplier`, then instrument metadata, then Kotak's raw `multiplier`.
 */
export function positionValueMultiplier(pos: {
  valueMultiplier?: number | null;
  multiplier?: number | null;
  underlying?: string | null;
}): number {
  if (typeof pos.valueMultiplier === "number" && pos.valueMultiplier > 0) return pos.valueMultiplier;
  if (getUnderlyingMeta(pos.underlying)) return unitMultiplier(pos.underlying);
  return pos.multiplier ?? 1;
}

/* ------------------------------------------------------------------ */
/*  Expiry close & pricing model                                      */
/* ------------------------------------------------------------------ */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

/** Is US daylight saving in force on this calendar date (2nd Sun Mar → 1st Sun Nov)? */
function usDstOn(year: number, month: number, day: number): boolean {
  const nthSunday = (m: number, n: number) => {
    const first = new Date(Date.UTC(year, m, 1)).getUTCDay();
    return 1 + ((7 - first) % 7) + (n - 1) * 7;
  };
  const start = nthSunday(2, 2); // March
  const end = nthSunday(10, 1); // November
  const md = month * 100 + day;
  return md >= 2 * 100 + start && md < 10 * 100 + end;
}

/**
 * Expiry close instant for an option expiry (`YYYY-MM-DD`).
 * NSE/BSE: 15:30 IST. MCX: 23:30 IST during US DST, else 23:55.
 */
export function expiryCloseDate(underlying: string | null | undefined, expiry: string): Date {
  const [y, m, d] = expiry.split("-").map(Number);
  const close = getUnderlyingMeta(underlying)?.sessionClose ?? "15:30";
  let hh = 15;
  let mm = 30;
  if (close === "mcx_evening") {
    hh = 23;
    mm = usDstOn(y, m - 1, d) ? 30 : 55;
  } else {
    const [h, mi] = close.split(":").map(Number);
    if (Number.isFinite(h) && Number.isFinite(mi)) {
      hh = h;
      mm = mi;
    }
  }
  // IST = UTC+5:30
  return new Date(Date.UTC(y, m - 1, d, hh - 5, mm - 30));
}

/** Continuous time to expiry in years (365.25-day basis), floored at 1e-6 — matches the quant service. */
export function timeToExpiryYears(
  underlying: string | null | undefined,
  expiry: string,
  now: Date = new Date(),
): number {
  const ms = expiryCloseDate(underlying, expiry).getTime() - now.getTime();
  return Math.max(ms / MS_PER_YEAR, 1e-6);
}

/** Whole days to expiry (ceil, min 1) for display. */
export function daysToExpiryFor(
  underlying: string | null | undefined,
  expiry: string,
  now: Date = new Date(),
): number {
  const ms = expiryCloseDate(underlying, expiry).getTime() - now.getTime();
  return Math.max(Math.ceil(ms / 86_400_000), 1);
}

export type PricingModel = "bsm" | "black76";

export function pricingModelOf(underlying: string | null | undefined): PricingModel {
  return isFuturesUnderlying(underlying) ? "black76" : "bsm";
}

/* ------------------------------------------------------------------ */
/*  Tick size                                                         */
/* ------------------------------------------------------------------ */

const _tickSizes: Record<string, number> = {};

/** Record MCX tick sizes from `/api/v1/contract-meta/{u}` (option tick, ₹). */
export function setTickSize(underlying: string, tick: number): void {
  if (tick > 0) _tickSizes[underlying.toUpperCase()] = tick;
}

/** Option price tick for limit-price stepping; NSE/BSE options tick at ₹0.05. */
export function priceTick(underlying: string | null | undefined): number {
  return (underlying && _tickSizes[underlying.toUpperCase()]) || 0.05;
}

export async function loadContractMeta(apiUrl: string, underlying: string): Promise<void> {
  try {
    const resp = await fetch(`${apiUrl}/api/v1/contract-meta/${encodeURIComponent(underlying)}`);
    if (!resp.ok) return;
    const data = (await resp.json()) as { expiries?: Record<string, { tickSize?: number }> };
    const first = Object.values(data.expiries ?? {})[0];
    if (first?.tickSize) setTickSize(underlying, first.tickSize);
  } catch {
    // Keep the 0.05 default
  }
}

/** Underlying from a cache/tick symbol ("CRUDEOILM 261015 7000 CE" → "CRUDEOILM"). */
export function underlyingOfSymbol(symbol: string | null | undefined): string {
  return (symbol || "").replace(/[\d\s].*/, "");
}

/** ₹ value of `premium × quantity` for a leg/position symbol. */
export function legValue(symbol: string | null | undefined, premium: number, quantity: number): number {
  return premium * quantity * unitMultiplier(underlyingOfSymbol(symbol));
}

/**
 * Kotak F&O segment for an order row. Accepts a segment ("mcx_fo") or an
 * exchange label ("MCX"); returns undefined when unknown so the backend
 * derives it from the trading symbol instead of guessing nse_fo.
 */
export function foSegmentOf(segmentOrExchange: string | null | undefined): string | undefined {
  const v = (segmentOrExchange || "").trim().toLowerCase();
  if (!v) return undefined;
  if (v.includes("_")) return v;
  if (v.startsWith("mcx")) return "mcx_fo";
  if (v.startsWith("bse") || v === "bfo") return "bse_fo";
  if (v.startsWith("nse") || v === "nfo") return "nse_fo";
  return undefined;
}

type PositionLike = {
  exchange?: unknown;
  symbol?: unknown;
  tradingSymbol?: unknown;
  _underlying?: unknown;
  valueMultiplier?: unknown;
  multiplier?: unknown;
};

function positionUnderlying(pos: PositionLike): string {
  if (typeof pos._underlying === "string" && pos._underlying) return pos._underlying;
  return underlyingOfSymbol(typeof pos.symbol === "string" ? pos.symbol : String(pos.tradingSymbol ?? ""));
}

/** Segment of a position/order row: its exchange label, else its underlying's. */
export function segmentOfRow(row: PositionLike): Segment {
  const ex = typeof row.exchange === "string" ? row.exchange : "";
  if (ex) return segmentOfExchange(ex);
  return segmentOfUnderlying(positionUnderlying(row));
}

/** ₹ per unit qty per ₹1 price for a position row (see `positionValueMultiplier`). */
export function rowValueMultiplier(row: PositionLike): number {
  return positionValueMultiplier({
    valueMultiplier: typeof row.valueMultiplier === "number" ? row.valueMultiplier : null,
    multiplier: typeof row.multiplier === "number" ? row.multiplier : null,
    underlying: positionUnderlying(row),
  });
}
