import { create } from "zustand";

import type { OptionType, ProductType, Side, StrategyLeg } from "@/types/market-data";
import type { OrderStatus } from "@/types/orders";
import { getLotSize } from "@/lib/lot-sizes";

interface BasketState {
  basketId: string | null;
  legs: StrategyLeg[];
  netCredit: number;
  status: OrderStatus;
  productType: ProductType;
  lots: number;
}

interface AddLegFromChainParams {
  strike: number;
  optionType: OptionType;
  side: Side;
  premium: number;
  underlying: string;
  expiry: string;
}

interface BasketActions {
  addLeg: (leg: StrategyLeg) => void;
  addLegFromChain: (params: AddLegFromChainParams) => void;
  removeLeg: (index: number) => void;
  updateLeg: (index: number, leg: Partial<StrategyLeg>) => void;
  reorderLegs: (fromIndex: number, toIndex: number) => void;
  clearBasket: () => void;
  setStatus: (status: OrderStatus) => void;
  setProductType: (productType: ProductType) => void;
  setLots: (lots: number) => void;
}

export type BasketStore = BasketState & BasketActions;

function inferLegLotSize(leg: StrategyLeg, basketLots: number): number {
  const underlying = leg.symbol.replace(/[\d\s].*/, "");
  const resolved = getLotSize(underlying);
  if (resolved > 1) return resolved;

  if (basketLots > 0 && leg.quantity > 0) {
    const inferred = Math.round(leg.quantity / basketLots);
    if (inferred > 0) return inferred;
  }

  return 1;
}

function computeNetCredit(legs: StrategyLeg[]): number {
  return legs.reduce((acc, leg) => {
    const value = leg.premium * leg.quantity;
    return leg.side === "SELL" ? acc + value : acc - value;
  }, 0);
}

function sortLegs(legs: StrategyLeg[]): StrategyLeg[] {
  return [...legs].sort((a, b) => {
    // Group by option type first (CE before PE) for visual spread grouping
    if (a.optionType !== b.optionType) return a.optionType === "CE" ? -1 : 1;
    // BUY before SELL within each group
    if (a.side !== b.side) return a.side === "BUY" ? -1 : 1;
    // Then by strike ascending
    return a.strike - b.strike;
  });
}

function buildSymbol(
  underlying: string,
  expiry: string,
  strike: number,
  optionType: OptionType,
): string {
  // expiry format: "2026-03-19" → "20260319"
  const expiryCompact = expiry.replace(/-/g, "");
  return `${underlying}${expiryCompact}${strike}${optionType}`;
}

/** Returns a Set of keys like "22500-CE-SELL" for quick lookup */
export function buildActiveLegSet(legs: StrategyLeg[]): Set<string> {
  const set = new Set<string>();
  for (const leg of legs) {
    set.add(`${leg.strike}-${leg.optionType}-${leg.side}`);
  }
  return set;
}

export const useBasketStore = create<BasketStore>()((set, get) => ({
  basketId: null,
  legs: [],
  netCredit: 0,
  status: "DRAFT" as OrderStatus,
  productType: "NRML" as ProductType,
  lots: 1,

  addLeg: (leg: StrategyLeg) => {
    const legs = sortLegs([...get().legs, leg]);
    set({ legs, netCredit: computeNetCredit(legs) });
  },

  addLegFromChain: (params: AddLegFromChainParams) => {
    const { strike, optionType, side, premium, underlying, expiry } = params;
    const current = get().legs;

    // Deduplicate: if same strike/type/side exists, update premium
    const existingIndex = current.findIndex(
      (l) =>
        l.strike === strike && l.optionType === optionType && l.side === side,
    );

    if (existingIndex !== -1) {
      const legs = current.map((leg, i) =>
        i === existingIndex ? { ...leg, premium } : leg,
      );
      set({ legs, netCredit: computeNetCredit(legs) });
      return;
    }

    const symbol = buildSymbol(underlying, expiry, strike, optionType);
    const newLeg: StrategyLeg = {
      symbol,
      strike,
      optionType,
      side,
      quantity: getLotSize(underlying) * get().lots,
      premium,
      orderType: "LIMIT",
      productType: get().productType,
    };
    const legs = sortLegs([...current, newLeg]);
    set({ legs, netCredit: computeNetCredit(legs) });
  },

  reorderLegs: (fromIndex: number, toIndex: number) => {
    const legs = [...get().legs];
    const [moved] = legs.splice(fromIndex, 1);
    legs.splice(toIndex, 0, moved);
    set({ legs });
  },

  removeLeg: (index: number) => {
    const legs = get().legs.filter((_, i) => i !== index);
    set({ legs, netCredit: computeNetCredit(legs) });
  },

  updateLeg: (index: number, update: Partial<StrategyLeg>) => {
    const legs = get().legs.map((leg, i) => {
      if (i !== index) return leg;
      const merged = { ...leg, ...update };
      // Snap quantity to nearest lot size multiple
      if (update.quantity !== undefined) {
        const lotSize = inferLegLotSize(leg, get().lots);
        if (lotSize > 1) {
          merged.quantity = Math.max(lotSize, Math.round(merged.quantity / lotSize) * lotSize);
        }
      }
      return merged;
    });
    set({ legs, netCredit: computeNetCredit(legs) });
  },

  clearBasket: () => {
    set({ basketId: null, legs: [], netCredit: 0, status: "DRAFT" });
  },

  setStatus: (status: OrderStatus) => {
    set({ status });
  },

  setProductType: (productType: ProductType) => {
    const legs = get().legs.map((leg) => ({ ...leg, productType }));
    set({ productType, legs });
  },

  setLots: (newLots: number) => {
    const clamped = Math.max(1, newLots);
    if (clamped === get().lots) return;
    // Overwrite all leg quantities to lotSize × newLots
    const legs = get().legs.map((leg) => {
      const baseLot = inferLegLotSize(leg, get().lots);
      return { ...leg, quantity: baseLot * clamped };
    });
    set({ lots: clamped, legs, netCredit: computeNetCredit(legs) });
  },
}));
