/**
 * Mock WebSocket ticker — perturbs option chain prices on a timer
 * and hydrates Zustand stores via getState() (non-reactive path).
 */

import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type { TickData } from "@/types/market-data";
import { generateGreeks } from "./generators/greeks";
import { TICK_INTERVAL_MS } from "./seed/constants";

let tickerInterval: ReturnType<typeof setInterval> | null = null;

function perturbPrice(ltp: number): number {
  const change = (Math.random() - 0.5) * ltp * 0.003; // ±0.15%
  return Math.round((ltp + change) * 100) / 100;
}

function perturbTick(tick: TickData): TickData {
  const ltp = perturbPrice(tick.ltp);
  const spread = Math.max(0.5, ltp * 0.004);
  const half = spread / 2;
  return {
    ...tick,
    ltp,
    bid: Math.round((ltp - half) * 100) / 100,
    ask: Math.round((ltp + half) * 100) / 100,
    timestamp: new Date().toISOString(),
  };
}

function tickOnce() {
  const { optionChain } = useMarketDataStore.getState();
  if (!optionChain) return;

  // Perturb underlying price
  const underlyingPrice = perturbPrice(optionChain.underlyingPrice);

  // Perturb each strike's call/put ticks
  const updatedStrikes = optionChain.strikes.map((strike) => ({
    strike: strike.strike,
    call: strike.call ? perturbTick(strike.call) : null,
    put: strike.put ? perturbTick(strike.put) : null,
  }));

  // Update the chain in the store
  const updatedChain = {
    ...optionChain,
    underlyingPrice: Math.round(underlyingPrice * 100) / 100,
    strikes: updatedStrikes,
    timestamp: new Date().toISOString(),
  };
  useMarketDataStore.getState().setOptionChain(updatedChain);

  // Push individual ticks into the tick map
  for (const strike of updatedStrikes) {
    if (strike.call) {
      useMarketDataStore.getState().updateTick(strike.call);
    }
    if (strike.put) {
      useMarketDataStore.getState().updateTick(strike.put);
    }
  }

  // Recompute and push Greeks
  const greeksResults = generateGreeks(updatedChain);
  let netDelta = 0;
  let netGamma = 0;
  let netTheta = 0;
  let netVega = 0;

  for (const g of greeksResults) {
    useGreeksStore.getState().updateGreeks(g);
    // Aggregate net Greeks from positions
    const positions = usePositionStore.getState().positions;
    const pos = positions.find((p) => p.symbol === g.symbol);
    if (pos) {
      const sign = pos.side === "SELL" ? -1 : 1;
      const lots = pos.quantity / 75; // LOT_SIZE
      netDelta += g.delta * sign * lots;
      netGamma += g.gamma * sign * lots;
      netTheta += g.theta * sign * lots;
      netVega += g.vega * sign * lots;
    }
  }

  useGreeksStore.getState().setNetGreeks(netDelta, netGamma, netTheta, netVega);

  // Update position P&L based on latest ticks
  const positions = usePositionStore.getState().positions;
  for (const pos of positions) {
    const tick = useMarketDataStore.getState().ticks.get(pos.symbol);
    if (tick) {
      const newPnl =
        pos.side === "SELL"
          ? (pos.avgPrice - tick.ltp) * pos.quantity
          : (tick.ltp - pos.avgPrice) * pos.quantity;
      usePositionStore.getState().updatePosition(pos.symbol, {
        ltp: tick.ltp,
        pnl: Math.round(newPnl * 100) / 100,
      });
    }
  }
}

export function startMockTicker(): void {
  if (tickerInterval) return;
  tickerInterval = setInterval(tickOnce, TICK_INTERVAL_MS);
}

export function stopMockTicker(): void {
  if (tickerInterval) {
    clearInterval(tickerInterval);
    tickerInterval = null;
  }
}
