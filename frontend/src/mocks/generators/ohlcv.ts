/**
 * Generates deterministic OHLCV candle data using a random-walk.
 */

import { ATM_PRICE } from "../seed/constants";

export interface OHLCVBar {
  time: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Simple seeded PRNG (xorshift32). */
function xorshift32(seed: number) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1; // [-1, 1]
  };
}

const INTERVAL_SECONDS: Record<string, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "1h": 3600,
  "1d": 86400,
};

export function generateOHLCV(
  symbol: string,
  from: string,
  to: string,
  interval: string = "5m",
): OHLCVBar[] {
  const startTs = Math.floor(new Date(from).getTime() / 1000);
  const endTs = Math.floor(new Date(to).getTime() / 1000);
  const step = INTERVAL_SECONDS[interval] ?? 300;
  const rng = xorshift32(hashCode(symbol + from));

  const bars: OHLCVBar[] = [];
  let price = ATM_PRICE;

  for (let t = startTs; t < endTs; t += step) {
    const volatility = 15; // points per bar
    const change = rng() * volatility;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.abs(rng()) * volatility * 0.3;
    const low = Math.min(open, close) - Math.abs(rng()) * volatility * 0.3;
    const volume = Math.round(Math.abs(rng()) * 50000 + 10000);

    bars.push({
      time: t,
      open: round2(open),
      high: round2(high),
      low: round2(low),
      close: round2(close),
      volume,
    });

    price = close;
  }

  return bars;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function hashCode(s: string): number {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    hash = (Math.imul(31, hash) + s.charCodeAt(i)) | 0;
  }
  return hash || 1;
}
