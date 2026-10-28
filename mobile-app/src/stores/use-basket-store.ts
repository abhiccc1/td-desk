import { create } from "zustand";

import type { BasketLeg } from "@/types/api";

type BasketSelection = {
  tradingSymbol?: string | null;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
};

type BasketState = {
  legs: BasketLeg[];
  toggleLeg: (selection: BasketSelection) => void;
  updateLeg: (id: string, patch: Partial<Omit<BasketLeg, "id">>) => void;
  removeLeg: (id: string) => void;
  clearBasket: () => void;
};

function buildLegId(selection: Pick<BasketSelection, "tradingSymbol" | "underlying" | "expiry" | "strike" | "optionType">) {
  return selection.tradingSymbol
    || `${selection.underlying}:${selection.expiry}:${selection.strike}:${selection.optionType}`;
}

export const useBasketStore = create<BasketState>()((set) => ({
  legs: [],
  toggleLeg: (selection) => set((state) => {
    const id = buildLegId(selection);
    const exists = state.legs.some((leg) => leg.id === id);

    if (exists) {
      return { legs: state.legs.filter((leg) => leg.id !== id) };
    }

    const nextLeg: BasketLeg = {
      id,
      tradingSymbol: selection.tradingSymbol ?? undefined,
      underlying: selection.underlying,
      expiry: selection.expiry,
      strike: selection.strike,
      optionType: selection.optionType,
      transactionType: "B",
      product: "NRML",
      orderType: "MKT",
      lots: 1,
      price: 0,
    };

    return { legs: [...state.legs, nextLeg] };
  }),
  updateLeg: (id, patch) => set((state) => ({
    legs: state.legs.map((leg) => (leg.id === id ? { ...leg, ...patch } : leg)),
  })),
  removeLeg: (id) => set((state) => ({
    legs: state.legs.filter((leg) => leg.id !== id),
  })),
  clearBasket: () => set({ legs: [] }),
}));
