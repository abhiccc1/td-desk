/**
 * Generates a TickData quote for a given symbol.
 * If the symbol looks like an option (contains CE/PE), it returns
 * data from the mock chain; otherwise it returns an underlying tick.
 */

import type { TickData } from "@/types/market-data";
import { ATM_PRICE, EXCHANGE, LOT_SIZE, UNDERLYING } from "../seed/constants";

export function generateQuote(symbol: string): TickData {
  const now = new Date().toISOString();

  // Underlying quote
  if (symbol === UNDERLYING || symbol === `${UNDERLYING} INDEX`) {
    const jitter = (Math.random() - 0.5) * 30;
    const ltp = ATM_PRICE + jitter;
    return {
      symbol,
      exchange: EXCHANGE,
      ltp: round2(ltp),
      bid: round2(ltp - 0.5),
      ask: round2(ltp + 0.5),
      bidQty: 1000,
      askQty: 1000,
      volume: 500_000,
      oi: 0,
      turnover: 0,
      timestamp: now,
    };
  }

  // Option quote — parse strike and type from symbol
  const match = symbol.match(/(\d{5})(CE|PE)$/);
  if (match) {
    const strike = parseInt(match[1], 10);
    const diff = Math.abs(strike - ATM_PRICE);
    const isCall = match[2] === "CE";

    // Rough intrinsic + time value
    const intrinsic = isCall
      ? Math.max(ATM_PRICE - strike, 0)
      : Math.max(strike - ATM_PRICE, 0);
    const timeValue = Math.max(50 - diff * 0.08, 2);
    const ltp = intrinsic + timeValue + (Math.random() - 0.5) * 5;

    return {
      symbol,
      exchange: EXCHANGE,
      ltp: round2(Math.max(ltp, 0.5)),
      bid: round2(Math.max(ltp - 1.5, 0.05)),
      ask: round2(ltp + 1.5),
      bidQty: Math.round(Math.random() * 300 + 50) * LOT_SIZE,
      askQty: Math.round(Math.random() * 300 + 50) * LOT_SIZE,
      volume: Math.round(Math.random() * 20000 + 1000) * LOT_SIZE,
      oi: Math.round(Math.random() * 500000 + 50000),
      turnover: 0,
      timestamp: now,
    };
  }

  // Fallback: generic tick
  return {
    symbol,
    exchange: EXCHANGE,
    ltp: 100,
    bid: 99.5,
    ask: 100.5,
    bidQty: 100,
    askQty: 100,
    volume: 10000,
    oi: 0,
    turnover: 0,
    timestamp: now,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
