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
  positionGreeks: Map<string, GreeksResult>;
  positionGreeksVersion: number;
}

interface GreeksActions {
  updateGreeks: (greeks: GreeksResult) => void;
  updateGreeksBatch: (greeks: GreeksResult[]) => void;
  clearGreeks: () => void;
  updatePositionGreeksBatch: (greeks: GreeksResult[]) => void;
  clearPositionGreeks: () => void;
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
  positionGreeks: new Map<string, GreeksResult>(),
  positionGreeksVersion: 0,

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

  updatePositionGreeksBatch: (greeks: GreeksResult[]) => {
    if (greeks.length === 0) return;
    const map = new Map(get().positionGreeks);
    for (const g of greeks) {
      map.set(g.symbol, g);
    }
    set((state) => ({
      positionGreeks: map,
      positionGreeksVersion: state.positionGreeksVersion + 1,
    }));
  },

  clearPositionGreeks: () => {
    set((state) => ({
      positionGreeks: new Map<string, GreeksResult>(),
      positionGreeksVersion: state.positionGreeksVersion + 1,
    }));
  },

}));
