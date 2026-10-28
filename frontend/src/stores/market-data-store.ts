import { create } from "zustand";

import type { UnderlyingMeta } from "@/lib/instruments";
import type { ModelPricesResult, OptionChainSnapshot, SviParams, TickData, VrpResult } from "@/types/market-data";

export type FeedMode = "broker" | null;
export type BrokerStatus = "connected" | "disconnected" | "authenticating" | null;
export type SessionStatus = "active" | "reconnecting" | "degraded" | "expired" | null;

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
  lastLiveTickAtMs: number | null;
  lastLiveSourceAtMs: number | null;
  selectedUnderlying: string;
  selectedExpiry: string;
  feedMode: FeedMode;
  brokerStatus: BrokerStatus;
  sviParams: SviParams | null;
  availableExpiries: string[];
  expiriesByUnderlying: Record<string, string[]>;
  expiriesLastUpdated: string | null;
  availableUnderlyings: string[];
  /** Full `/underlyings` metadata (exchange, asset class, multipliers). */
  underlyingMeta: UnderlyingMeta[];
  spotStatic: StaticData | null;
  modelPrices: ModelPricesResult | null;
  vrp: VrpResult | null;
  sessionStatus: SessionStatus;
  sviAlerts: SviAlert[];
}

interface MarketDataActions {
  updateTick: (tick: TickData) => void;
  clearTicks: () => void;
  clearTicksForExpiry: (underlying: string, expiry: string, protectedSymbols?: Set<string>) => void;
  setOptionChain: (chain: OptionChainSnapshot | null) => void;
  setSelectedUnderlying: (underlying: string) => void;
  setSelectedExpiry: (expiry: string) => void;
  setFeedMode: (mode: FeedMode) => void;
  setBrokerStatus: (status: BrokerStatus) => void;
  setSviParams: (params: SviParams | null) => void;
  setAvailableExpiries: (expiries: string[]) => void;
  setExpiriesCache: (expiriesByUnderlying: Record<string, string[]>, lastUpdated: string | null) => void;
  setAvailableUnderlyings: (underlyings: string[]) => void;
  setUnderlyingMeta: (meta: UnderlyingMeta[]) => void;
  setSpotStatic: (data: StaticData | null) => void;
  setModelPrices: (prices: ModelPricesResult | null) => void;
  setVrp: (vrp: VrpResult | null) => void;
  setSessionStatus: (status: SessionStatus) => void;
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
  lastLiveTickAtMs: null,
  lastLiveSourceAtMs: null,
  selectedUnderlying: "",
  selectedExpiry: "",
  feedMode: null,
  brokerStatus: null,
  sviParams: null,
  availableExpiries: [],
  expiriesByUnderlying: {},
  expiriesLastUpdated: null,
  availableUnderlyings: [],
  underlyingMeta: [],
  modelPrices: null,
  vrp: null,
  spotStatic: null,
  sessionStatus: null,
  sviAlerts: [],

  updateTick: (tick: TickData) => {
    // LKGV: ignore zero-LTP ticks (broker pushes 0 after market close)
    // to prevent off-hours P&L from showing incorrect values
    if (tick.ltp === 0 || tick.ltp == null) return;

    const ticks = get().ticks;
    ticks.set(tick.symbol, tick);
    const sourceAtMs = new Date(tick.timestamp).getTime();
    set((state) => ({
      ticks,
      tickVersion: state.tickVersion + 1,
      lastTickSymbol: tick.symbol,
      lastLiveTickAtMs: Date.now(),
      lastLiveSourceAtMs: Number.isFinite(sourceAtMs) ? sourceAtMs : state.lastLiveSourceAtMs,
    }));
  },

  clearTicks: () => {
    set((state) => ({
      ticks: new Map<string, TickData>(),
      tickVersion: state.tickVersion + 1,
      lastTickSymbol: null,
      lastLiveTickAtMs: null,
      lastLiveSourceAtMs: null,
    }));
  },

  clearTicksForExpiry: (underlying: string, expiry: string, protectedSymbols?: Set<string>) => {
    // Remove chain ticks for the given underlying+expiry, but preserve
    // ticks for symbols in protectedSymbols (open position symbols).
    const compact = expiry.replace(/-/g, "").slice(2); // "2026-03-19" → "260319"
    const prefix = `${underlying} ${compact} `;
    const ticks = get().ticks;

    let removed = 0;
    for (const key of [...ticks.keys()]) {
      if (key.startsWith(prefix) && (!protectedSymbols || !protectedSymbols.has(key))) {
        ticks.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      set((state) => ({
        ticks,
        tickVersion: state.tickVersion + 1,
        lastTickSymbol: null,
      }));
    }
  },

  setOptionChain: (chain: OptionChainSnapshot | null) => {
    set({ optionChain: chain });
  },

  setSelectedUnderlying: (underlying: string) => {
    set((state) => ({
      selectedUnderlying: underlying,
      availableExpiries: underlying ? (state.expiriesByUnderlying[underlying] ?? []) : [],
    }));
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

  setExpiriesCache: (expiriesByUnderlying: Record<string, string[]>, lastUpdated: string | null) => {
    set((state) => ({
      expiriesByUnderlying,
      expiriesLastUpdated: lastUpdated,
      availableExpiries: state.selectedUnderlying
        ? (expiriesByUnderlying[state.selectedUnderlying] ?? [])
        : state.availableExpiries,
    }));
  },

  setAvailableUnderlyings: (underlyings: string[]) => {
    set({ availableUnderlyings: underlyings });
  },

  setUnderlyingMeta: (meta: UnderlyingMeta[]) => {
    set({ underlyingMeta: meta });
  },

  setSpotStatic: (data: StaticData | null) => {
    set({ spotStatic: data });
  },

  setModelPrices: (prices: ModelPricesResult | null) => {
    set({ modelPrices: prices });
  },

  setVrp: (vrp: VrpResult | null) => {
    set({ vrp });
  },

  setSessionStatus: (status: SessionStatus) => set({ sessionStatus: status }),

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
