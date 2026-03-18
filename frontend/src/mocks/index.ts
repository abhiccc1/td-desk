/**
 * Mock module bootstrap — loads scraped NSE data into stores
 * and starts the mock ticker.
 */

import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type { NseOptionChainResponse } from "@/lib/nse/types";
import {
  extractExpiries,
  normalizeNseOptionChain,
} from "@/lib/nse/normalize";
import { generatePositions } from "./generators/positions";
import { startMockTicker, stopMockTicker } from "./mock-ws-ticker";
import nseData from "./data/nse-option-chain.json";

let initialized = false;

export function initMocks(): void {
  if (initialized) return;
  initialized = true;

  console.log("[mock] Initializing mock data module (NSE scraped data)...");

  const nse = nseData as unknown as NseOptionChainResponse;
  const expiries = extractExpiries(nse);
  const firstExpiry = expiries[0] ?? "";
  const underlying = "NIFTY";

  // Normalize NSE data into app types
  const { chain, greeks } = normalizeNseOptionChain(nse, underlying, firstExpiry);

  // Seed market data store
  useMarketDataStore.getState().setOptionChain(chain);
  useMarketDataStore.getState().setSelectedUnderlying(underlying);
  useMarketDataStore.getState().setSelectedExpiry(firstExpiry);
  useMarketDataStore.getState().setAvailableExpiries(expiries);

  // Seed individual ticks from the chain
  for (const strike of chain.strikes) {
    if (strike.call) useMarketDataStore.getState().updateTick(strike.call);
    if (strike.put) useMarketDataStore.getState().updateTick(strike.put);
  }

  // Seed Greeks
  for (const g of greeks) {
    useGreeksStore.getState().updateGreeks(g);
  }

  // Seed positions
  const positions = generatePositions();
  usePositionStore.getState().setPositions(positions);

  // Start live ticker
  startMockTicker();

  console.log(
    `[mock] Mock data module ready — ${chain.strikes.length} strikes, ${expiries.length} expiries, ticker running.`,
  );
}

export function teardownMocks(): void {
  stopMockTicker();
  initialized = false;
  console.log("[mock] Mock data module torn down.");
}
