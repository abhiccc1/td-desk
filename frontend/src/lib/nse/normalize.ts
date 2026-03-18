/**
 * Normalizes raw NSE option chain JSON into the app's internal types.
 */

import type {
  GreeksResult,
  OptionChainSnapshot,
  OptionStrike,
  TickData,
} from "@/types/market-data";
import { computeAllGreeks, daysToExpiry, dteToYears } from "@/lib/black-scholes";
import type { NseOptionChainResponse, NseOptionLeg } from "./types";

/** Convert NSE date "17-Mar-2026" → "2026-03-17". */
function parseNseDate(nseDate: string): string {
  const d = new Date(nseDate);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Build an option symbol like NIFTY2026031722000CE. */
function makeSymbol(
  underlying: string,
  expiry: string,
  strike: number,
  type: "CE" | "PE",
): string {
  return `${underlying}${expiry.replace(/-/g, "")}${strike}${type}`;
}

function legToTick(leg: NseOptionLeg, symbol: string): TickData {
  return {
    symbol,
    exchange: "NSE",
    ltp: leg.lastPrice,
    bid: leg.buyPrice1,
    ask: leg.sellPrice1,
    bidQty: leg.buyQuantity1,
    askQty: leg.sellQuantity1,
    volume: leg.totalTradedVolume,
    oi: leg.openInterest,
    turnover: 0,
    timestamp: new Date().toISOString(),
  };
}

/** Extract sorted unique expiry dates (YYYY-MM-DD) from an NSE response. */
export function extractExpiries(nse: NseOptionChainResponse): string[] {
  return nse.records.expiryDates.map(parseNseDate).sort();
}

/**
 * Normalize an NSE option chain response for a specific expiry.
 * Returns the chain snapshot and per-strike Greeks.
 */
export function normalizeNseOptionChain(
  nse: NseOptionChainResponse,
  symbol: string,
  expiry: string,
): { chain: OptionChainSnapshot; greeks: GreeksResult[] } {
  const underlyingPrice = nse.records.underlyingValue;
  const dte = daysToExpiry(expiry);
  const T = dteToYears(dte);
  const now = new Date().toISOString();

  // Filter records by the requested expiry
  const filtered = nse.records.data.filter(
    (rec) => parseNseDate(rec.expiryDates) === expiry,
  );

  const strikes: OptionStrike[] = [];
  const greeks: GreeksResult[] = [];

  for (const rec of filtered) {
    const K = rec.strikePrice;
    // Skip records with strikePrice === 0 (summary rows)
    if (K <= 0) continue;

    let callTick: TickData | null = null;
    let putTick: TickData | null = null;

    if (rec.CE && rec.CE.strikePrice > 0) {
      const ceSymbol = makeSymbol(symbol, expiry, K, "CE");
      callTick = legToTick(rec.CE, ceSymbol);

      const iv = (rec.CE.impliedVolatility || 0) / 100;
      if (iv > 0) {
        const g = computeAllGreeks(underlyingPrice, K, T, iv, "CE");
        greeks.push({
          symbol: ceSymbol,
          underlying: symbol,
          expiry,
          strike: K,
          optionType: "CE",
          iv: Math.round(g.iv * 10000) / 10000,
          delta: Math.round(g.delta * 10000) / 10000,
          gamma: Math.round(g.gamma * 10000) / 10000,
          theta: Math.round(g.theta * 100) / 100,
          vega: Math.round(g.vega * 100) / 100,
          underlyingPrice,
          timestamp: now,
        });
      }
    }

    if (rec.PE && rec.PE.strikePrice > 0) {
      const peSymbol = makeSymbol(symbol, expiry, K, "PE");
      putTick = legToTick(rec.PE, peSymbol);

      const iv = (rec.PE.impliedVolatility || 0) / 100;
      if (iv > 0) {
        const g = computeAllGreeks(underlyingPrice, K, T, iv, "PE");
        greeks.push({
          symbol: peSymbol,
          underlying: symbol,
          expiry,
          strike: K,
          optionType: "PE",
          iv: Math.round(g.iv * 10000) / 10000,
          delta: Math.round(g.delta * 10000) / 10000,
          gamma: Math.round(g.gamma * 10000) / 10000,
          theta: Math.round(g.theta * 100) / 100,
          vega: Math.round(g.vega * 100) / 100,
          underlyingPrice,
          timestamp: now,
        });
      }
    }

    if (callTick || putTick) {
      strikes.push({ strike: K, call: callTick, put: putTick });
    }
  }

  // Sort strikes ascending
  strikes.sort((a, b) => a.strike - b.strike);

  const chain: OptionChainSnapshot = {
    underlying: symbol,
    underlyingPrice,
    expiry,
    exchange: "NSE",
    strikes,
    timestamp: now,
  };

  return { chain, greeks };
}
