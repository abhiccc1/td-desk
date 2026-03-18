/**
 * Generates a complete OptionChainSnapshot with 25 strikes,
 * IV smile, OI bell curve, and realistic bid-ask spreads.
 */

import type {
  OptionChainSnapshot,
  OptionStrike,
  TickData,
} from "@/types/market-data";
import {
  computeAllGreeks,
  daysToExpiry,
  dteToYears,
  impliedVolSmile,
} from "../seed/black-scholes";
import {
  ATM_PRICE,
  EXCHANGE,
  EXPIRIES,
  LOT_SIZE,
  STRIKE_STEP,
  STRIKES_EACH_SIDE,
  UNDERLYING,
} from "../seed/constants";

/** Simple seeded PRNG (mulberry32) for deterministic output. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Bell-curve OI distribution peaking at ATM. */
function oiBellCurve(strike: number, atm: number, peakOi: number): number {
  const dist = (strike - atm) / (STRIKES_EACH_SIDE * STRIKE_STEP);
  const oi = peakOi * Math.exp(-3 * dist * dist);
  return Math.round(oi / LOT_SIZE) * LOT_SIZE;
}

function makeTick(
  symbol: string,
  ltp: number,
  oi: number,
  rng: () => number,
): TickData {
  const spread = Math.max(0.5, ltp * 0.004); // ~0.4% spread
  const half = spread / 2;
  return {
    symbol,
    exchange: EXCHANGE,
    ltp: round2(ltp),
    bid: round2(ltp - half),
    ask: round2(ltp + half),
    bidQty: Math.round(rng() * 500 + 100) * LOT_SIZE,
    askQty: Math.round(rng() * 500 + 100) * LOT_SIZE,
    volume: Math.round(rng() * 50000 + 5000) * LOT_SIZE,
    oi,
    turnover: 0,
    timestamp: new Date().toISOString(),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function generateOptionChain(
  underlying: string = UNDERLYING,
  expiry: string = EXPIRIES[0],
): OptionChainSnapshot {
  const rng = mulberry32(42);
  const S = ATM_PRICE + (rng() - 0.5) * 50; // slight jitter
  const dte = daysToExpiry(expiry);
  const T = dteToYears(dte);
  const peakOi = 1_200_000;

  const strikes: OptionStrike[] = [];

  for (let i = -STRIKES_EACH_SIDE; i <= STRIKES_EACH_SIDE; i++) {
    const K = ATM_PRICE + i * STRIKE_STEP;
    const iv = impliedVolSmile(K, S);
    const ce = computeAllGreeks(S, K, T, iv, "CE");
    const pe = computeAllGreeks(S, K, T, iv, "PE");
    const ceOi = oiBellCurve(K, ATM_PRICE, peakOi);
    const peOi = oiBellCurve(K, ATM_PRICE, peakOi * 0.9);

    const ceSymbol = `${underlying}${expiry.replace(/-/g, "")}${K}CE`;
    const peSymbol = `${underlying}${expiry.replace(/-/g, "")}${K}PE`;

    strikes.push({
      strike: K,
      call: makeTick(ceSymbol, Math.max(ce.price, 0.5), ceOi, rng),
      put: makeTick(peSymbol, Math.max(pe.price, 0.5), peOi, rng),
    });
  }

  return {
    underlying,
    underlyingPrice: round2(S),
    expiry,
    exchange: EXCHANGE,
    strikes,
    timestamp: new Date().toISOString(),
  };
}
