import { create } from "zustand";

import type { ModelPricesResult, OptionChainSnapshot, SviParams, TickData } from "@/types/market-data";

export type FeedMode = "mock" | "broker" | null;
export type BrokerStatus = "connected" | "disconnected" | "authenticating" | null;

export interface StaticData {
  symbol: string;
  open: number;
  high: number;
  low: number;
  prevClose: number;
  change: number;
  pctChange: number;
}

export interface SviAlert {
  level: string;   // "error" | "warning" | "info"
  title: string;
  message: string;
  timestamp?: number;
}

interface MarketDataState {
  optionChain: OptionChainSnapshot | null;
  ticks: Map<string, TickData>;
  tickVersion: number;
  lastTickSymbol: string | null;
  selectedUnderlying: string;
  selectedExpiry: string;
  feedMode: FeedMode;
  brokerStatus: BrokerStatus;
  sviParams: SviParams | null;
  availableExpiries: string[];
  availableUnderlyings: string[];
  spotStatic: StaticData | null;
  modelPrices: ModelPricesResult | null;
  sviAlerts: SviAlert[];
}

interface MarketDataActions {
  updateTick: (tick: TickData) => void;
  clearTicks: () => void;
  setOptionChain: (chain: OptionChainSnapshot | null) => void;
  setSelectedUnderlying: (underlying: string) => void;
  setSelectedExpiry: (expiry: string) => void;
  setFeedMode: (mode: FeedMode) => void;
  setBrokerStatus: (status: BrokerStatus) => void;
  setSviParams: (params: SviParams | null) => void;
  setAvailableExpiries: (expiries: string[]) => void;
  setAvailableUnderlyings: (underlyings: string[]) => void;
  setSpotStatic: (data: StaticData | null) => void;
  setModelPrices: (prices: ModelPricesResult | null) => void;
  addSviAlert: (alert: { level: string; title: string; message: string }) => void;
  dismissSviAlert: (idx: number) => void;
}

export type MarketDataStore = MarketDataState & MarketDataActions;

/**
 * Market data store — the most performance-critical store.
 *
 * For high-frequency tick injection, prefer the `getState()` pattern
 * (e.g. `useMarketDataStore.getState().updateTick(tick)`) so that
 * React does not re-render on every tick update.
 */
export const useMarketDataStore = create<MarketDataStore>()((set, get) => ({
  optionChain: null,
  ticks: new Map<string, TickData>(),
  tickVersion: 0,
  lastTickSymbol: null,
  selectedUnderlying: "",
  selectedExpiry: "",
  feedMode: null,
  brokerStatus: null,
  sviParams: null,
  availableExpiries: [],
  availableUnderlyings: [],
  modelPrices: null,
  spotStatic: null,
  sviAlerts: [],

  updateTick: (tick: TickData) => {
    const ticks = get().ticks;
    ticks.set(tick.symbol, tick);
    set((state) => ({
      ticks,
      tickVersion: state.tickVersion + 1,
      lastTickSymbol: tick.symbol,
    }));
  },

  clearTicks: () => {
    set((state) => ({
      ticks: new Map<string, TickData>(),
      tickVersion: state.tickVersion + 1,
      lastTickSymbol: null,
    }));
  },

  setOptionChain: (chain: OptionChainSnapshot | null) => {
    set({ optionChain: chain });
  },

  setSelectedUnderlying: (underlying: string) => {
    set({ selectedUnderlying: underlying });
  },

  setSelectedExpiry: (expiry: string) => {
    set({ selectedExpiry: expiry });
  },

  setFeedMode: (mode: FeedMode) => {
    set({ feedMode: mode });
  },

  setBrokerStatus: (status: BrokerStatus) => {
    set({ brokerStatus: status });
  },

  setSviParams: (params: SviParams | null) => {
    set({ sviParams: params });
  },

  setAvailableExpiries: (expiries: string[]) => {
    set({ availableExpiries: expiries });
  },

  setAvailableUnderlyings: (underlyings: string[]) => {
    set({ availableUnderlyings: underlyings });
  },

  setSpotStatic: (data: StaticData | null) => {
    set({ spotStatic: data });
  },

  setModelPrices: (prices: ModelPricesResult | null) => {
    set({ modelPrices: prices });
  },

  addSviAlert: (alert: { level: string; title: string; message: string }) => {
    set((state) => ({
      sviAlerts: [
        { ...alert, timestamp: Date.now() },
        ...state.sviAlerts,
      ].slice(0, 20), // keep last 20
    }));
  },

  dismissSviAlert: (idx: number) => {
    set((state) => ({
      sviAlerts: state.sviAlerts.filter((_, i) => i !== idx),
    }));
  },
}));
