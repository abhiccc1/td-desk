/**
 * Generates GreeksResult[] from an OptionChainSnapshot.
 */

import type { GreeksResult, OptionChainSnapshot } from "@/types/market-data";
import {
  computeAllGreeks,
  daysToExpiry,
  dteToYears,
  impliedVolSmile,
} from "../seed/black-scholes";

export function generateGreeks(chain: OptionChainSnapshot): GreeksResult[] {
  const results: GreeksResult[] = [];
  const S = chain.underlyingPrice;
  const dte = daysToExpiry(chain.expiry);
  const T = dteToYears(dte);
  const now = new Date().toISOString();

  for (const strike of chain.strikes) {
    const K = strike.strike;
    const iv = impliedVolSmile(K, S);

    for (const type of ["CE", "PE"] as const) {
      const tick = type === "CE" ? strike.call : strike.put;
      if (!tick) continue;

      const g = computeAllGreeks(S, K, T, iv, type);

      results.push({
        symbol: tick.symbol,
        underlying: chain.underlying,
        expiry: chain.expiry,
        strike: K,
        optionType: type,
        iv: Math.round(g.iv * 10000) / 10000,
        delta: Math.round(g.delta * 10000) / 10000,
        gamma: Math.round(g.gamma * 10000) / 10000,
        theta: Math.round(g.theta * 100) / 100,
        vega: Math.round(g.vega * 100) / 100,
        underlyingPrice: S,
        timestamp: now,
      });
    }
  }

  return results;
}
