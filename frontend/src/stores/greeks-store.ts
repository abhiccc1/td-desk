import { create } from "zustand";

import type { GreeksResult } from "@/types/market-data";

interface GreeksState {
  greeks: Map<string, GreeksResult>;
  greeksVersion: number;
  lastUpdatedSymbols: string[];
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
}

interface GreeksActions {
  updateGreeks: (greeks: GreeksResult) => void;
  updateGreeksBatch: (greeks: GreeksResult[]) => void;
  clearGreeks: () => void;
  setNetGreeks: (
    delta: number,
    gamma: number,
    theta: number,
    vega: number,
  ) => void;
}

export type GreeksStore = GreeksState & GreeksActions;

export const useGreeksStore = create<GreeksStore>()((set, get) => ({
  greeks: new Map<string, GreeksResult>(),
  greeksVersion: 0,
  lastUpdatedSymbols: [],
  netDelta: 0,
  netGamma: 0,
  netTheta: 0,
  netVega: 0,

  updateGreeks: (greeks: GreeksResult) => {
    get().updateGreeksBatch([greeks]);
  },

  clearGreeks: () => {
    set((state) => ({
      greeks: new Map<string, GreeksResult>(),
      greeksVersion: state.greeksVersion + 1,
      lastUpdatedSymbols: [],
    }));
  },

  updateGreeksBatch: (greeks: GreeksResult[]) => {
    if (greeks.length === 0) return;
    const map = new Map(get().greeks);
    const updatedSymbols: string[] = [];
    for (const greek of greeks) {
      map.set(greek.symbol, greek);
      updatedSymbols.push(greek.symbol);
    }
    set((state) => ({
      greeks: map,
      greeksVersion: state.greeksVersion + 1,
      lastUpdatedSymbols: updatedSymbols,
    }));
  },

  setNetGreeks: (
    delta: number,
    gamma: number,
    theta: number,
    vega: number,
  ) => {
    set({
      netDelta: delta,
      netGamma: gamma,
      netTheta: theta,
      netVega: vega,
    });
  },
}));
