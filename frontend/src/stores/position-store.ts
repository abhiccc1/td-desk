import { create } from "zustand";

import type { Position } from "@/types/orders";

interface PositionState {
  positions: Position[];
  totalPnl: number;
  realizedPnl: number;
}

interface PositionActions {
  setPositions: (positions: Position[]) => void;
  setRealizedPnl: (pnl: number) => void;
  updatePosition: (symbol: string, update: Partial<Position>) => void;
}

export type PositionStore = PositionState & PositionActions;

function computeTotalPnl(positions: Position[]): number {
  return positions.reduce((acc, pos) => acc + pos.pnl, 0);
}

export const usePositionStore = create<PositionStore>()((set, get) => ({
  positions: [],
  totalPnl: 0,
  realizedPnl: 0,

  setPositions: (positions: Position[]) => {
    set({ positions, totalPnl: computeTotalPnl(positions) });
  },

  setRealizedPnl: (pnl: number) => {
    set({ realizedPnl: pnl });
  },

  updatePosition: (symbol: string, update: Partial<Position>) => {
    const positions = get().positions.map((pos) =>
      pos.symbol === symbol ? { ...pos, ...update } : pos,
    );
    set({ positions, totalPnl: computeTotalPnl(positions) });
  },
}));
