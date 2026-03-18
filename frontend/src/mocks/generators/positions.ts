/**
 * Generates sample positions: a short strangle (sell 22300PE + sell 22700CE).
 */

import type { Position } from "@/types/orders";
import { EXCHANGE, EXPIRIES, LOT_SIZE, UNDERLYING } from "../seed/constants";

export function generatePositions(): Position[] {
  const expiry = EXPIRIES[0].replace(/-/g, "");

  return [
    {
      symbol: `${UNDERLYING}${expiry}22300PE`,
      exchange: EXCHANGE,
      quantity: LOT_SIZE,
      avgPrice: 45.5,
      ltp: 42.3,
      pnl: (45.5 - 42.3) * LOT_SIZE, // short → profit when premium drops
      side: "SELL",
    },
    {
      symbol: `${UNDERLYING}${expiry}22700CE`,
      exchange: EXCHANGE,
      quantity: LOT_SIZE,
      avgPrice: 52.75,
      ltp: 48.1,
      pnl: (52.75 - 48.1) * LOT_SIZE,
      side: "SELL",
    },
  ];
}
