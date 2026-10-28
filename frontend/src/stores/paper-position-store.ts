import { create } from "zustand";

import type { Position } from "@/types/orders";
import { normalizePosition, sortPositions, computeTotalPnl } from "@/stores/position-store";
import type { PositionStore } from "@/stores/position-store";

/**
 * Paper-trading position store — a second, independent instance of the live
 * position store. Kept fully separate so simulated positions never mix with
 * live broker positions. Shares the same normalization/sort logic so the
 * reused {@link PositionMonitor} component behaves identically.
 */
export const usePaperPositionStore = create<PositionStore>()((set, get) => ({
  positions: [],
  totalPnl: 0,
  realizedPnl: 0,
  orderUpdateVersion: 0,

  setPositions: (positions: Position[]) => {
    const normalized = positions.map(normalizePosition);
    const sorted = sortPositions(normalized);
    set({ positions: sorted, totalPnl: computeTotalPnl(sorted) });
  },

  setRealizedPnl: (pnl: number) => {
    set({ realizedPnl: pnl });
  },

  updatePosition: (symbol: string, update: Partial<Position>) => {
    const positions = sortPositions(get().positions.map((pos) =>
      pos.symbol === symbol ? { ...pos, ...update } : pos,
    ));
    set({ positions, totalPnl: computeTotalPnl(positions) });
  },

  bumpOrderUpdate: () => {
    set((s) => ({ orderUpdateVersion: s.orderUpdateVersion + 1 }));
  },
}));
