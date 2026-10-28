import type { OrderBookEntry, Position, Underlying } from "@/types/api";
import { extractUnderlying } from "@/lib/positions";

export type Segment = "EQ_IDX" | "MCX";

export const SEGMENTS: Segment[] = ["EQ_IDX", "MCX"];

export const SEGMENT_LABELS: Record<Segment, string> = {
  EQ_IDX: "NSE+BSE",
  MCX: "MCX",
};

export const DEFAULT_TICK_SIZE = 0.05;

/** Map an exchange label or Kotak segment (nse_fo, mcx_fo…) to an app segment. Unknown ⇒ EQ_IDX. */
export function segmentOf(exchange?: string | null): Segment {
  return (exchange ?? "").trim().toUpperCase().startsWith("MCX") ? "MCX" : "EQ_IDX";
}

export function segmentFromLabel(label: string): Segment {
  return (SEGMENTS.find((segment) => SEGMENT_LABELS[segment] === label) ?? "EQ_IDX");
}

export function otherSegment(segment: Segment): Segment {
  return segment === "MCX" ? "EQ_IDX" : "MCX";
}

/**
 * ₹ per unit quantity per ₹1 of price: pnlMultiplier / lotSize.
 * GOLD 100, GOLDM 0.1, NSE/BSE and other MCX contracts 1. Undefined when unknown.
 */
export function unitMultiplier(
  meta?: Pick<Underlying, "lotSize" | "pnlMultiplier"> | null,
): number | undefined {
  const lotSize = Number(meta?.lotSize);
  const pnlMultiplier = Number(meta?.pnlMultiplier);
  if (!(lotSize > 0) || !(pnlMultiplier > 0)) return undefined;
  return pnlMultiplier / lotSize;
}

export function buildUnderlyingMap(underlyings?: Underlying[]) {
  const map: Record<string, Underlying> = {};
  for (const item of underlyings ?? []) {
    map[item.name.toUpperCase()] = item;
  }
  return map;
}

/** unitMultiplier for an underlying name, defaulting to 1 (NSE behaviour). */
export function unitMultiplierFor(underlying: string, metaByName: Record<string, Underlying>) {
  return unitMultiplier(metaByName[underlying.trim().toUpperCase()]) ?? 1;
}

/** Precedence: position.valueMultiplier → unitMultiplier(meta) → position.multiplier → 1. */
export function positionValueMultiplier(
  position: Position,
  metaByName: Record<string, Underlying>,
): number {
  if (Number.isFinite(position.valueMultiplier) && (position.valueMultiplier ?? 0) > 0) {
    return position.valueMultiplier as number;
  }
  const underlying = extractUnderlying(position.tradingSymbol ?? position.symbol ?? "");
  const fromMeta = unitMultiplier(metaByName[underlying.toUpperCase()]);
  if (fromMeta !== undefined) return fromMeta;
  return position.multiplier ?? 1;
}

export function positionSegment(position: Position): Segment {
  return segmentOf(position.exchange);
}

/**
 * Order segment from exchangeSegment (nse_fo / bse_fo / mcx_fo). When that is
 * missing, fall back to the trading symbol's underlying prefix; unknown ⇒ EQ_IDX.
 */
export function orderSegment(order: OrderBookEntry, metaByName?: Record<string, Underlying>): Segment {
  if (order.exchangeSegment) return segmentOf(order.exchangeSegment);
  const symbol = order.tradingSymbol || order.symbol || "";
  const meta = metaByName?.[extractUnderlying(symbol).toUpperCase()];
  return segmentOf(meta?.exchange);
}

export function underlyingPriceLabel(assetClass?: string | null): "Spot" | "Fut" {
  return assetClass === "commodity" ? "Fut" : "Spot";
}

export function hasMcxUnderlyings(underlyings?: Underlying[]) {
  return Boolean(underlyings?.some((item) => segmentOf(item.exchange) === "MCX"));
}

// Module registry filled by fetchUnderlyings so non-React code (the order
// serializer) can tell MCX legs apart and convert them to lots.
let registeredMeta: Record<string, Underlying> = {};

export function registerUnderlyings(underlyings: Underlying[]) {
  registeredMeta = buildUnderlyingMap(underlyings);
}

/**
 * Lot count for an MCX leg whose quantity is in units, or undefined for
 * NSE/BSE legs, unknown underlyings, or a non-whole lot count (which is then
 * sent as quantity so the backend rejects it rather than rounding).
 */
export function mcxLotsFor(underlying: string, quantity: number): number | undefined {
  const meta = registeredMeta[underlying.trim().toUpperCase()];
  const lotSize = Number(meta?.lotSize);
  if (!meta || segmentOf(meta.exchange) !== "MCX" || !(lotSize > 0)) return undefined;
  const lots = quantity / lotSize;
  return Number.isInteger(lots) && lots > 0 ? lots : undefined;
}
