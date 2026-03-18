/**
 * Data feed orchestrator — decides which data source to use:
 *   - mock mode → initMocks() with scraped NSE data
 *   - non-mock  → WebSocket connection to API gateway, REST polling for initial data
 */

import { startTransition } from "react";

import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type { GreeksResult, ModelPricesResult, OptionChainSnapshot, TickData } from "@/types/market-data";
import type { Position } from "@/types/orders";

import { wsClient } from "./ws-client";

export class DataFeedOrchestrator {
  private _unsub: (() => void) | null = null;
  private _removeMessageHandler: (() => void) | null = null;
  private _pendingGreeks = new Map<string, GreeksResult>();
  private _greeksFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private _pendingModelPrices: ModelPricesResult | null = null;
  private _modelPricesFlushHandle: ReturnType<typeof setTimeout> | null = null;

  async init(): Promise<void> {
    const isMock = process.env.NEXT_PUBLIC_MOCK_MODE === "true";

    if (isMock) {
      const { initMocks } = await import("@/mocks");
      initMocks();
      useMarketDataStore.getState().setFeedMode("mock");
      return;
    }

    // Non-mock: connect WebSocket and register message handlers
    useMarketDataStore.getState().setFeedMode("broker");

    // Load lot sizes and available underlyings from instrument master
    import("@/lib/lot-sizes").then(({ loadLotSizes }) => loadLotSizes());
    this._loadUnderlyings();

    this._removeMessageHandler = wsClient.onMessage((topic: string, payload: unknown) => {
      if (topic.startsWith("ticks:option:")) {
        const tick = payload as TickData;
        if (tick) {
          useMarketDataStore.getState().updateTick(tick);
        }
        return;
      }

      if (topic.startsWith("ticks:chain:")) {
        const chain = payload as OptionChainSnapshot;
        useMarketDataStore.getState().setOptionChain(chain);
      } else if (topic.startsWith("greeks:batch:")) {
        const batch = payload as { greeks: GreeksResult[] };
        if (Array.isArray(batch.greeks)) {
          startTransition(() => {
            useGreeksStore.getState().updateGreeksBatch(batch.greeks);
          });
        }
      } else if (topic.startsWith("greeks:computed:")) {
        const greeks = payload as GreeksResult;
        this._queueGreeks(greeks);
      } else if (topic.startsWith("orders:updates:")) {
        const data = payload as { positions?: Position[]; realizedPnl?: number };
        if (data.positions) {
          // Sort: open positions first, then closed
          const sorted = [...data.positions].sort((a, b) => {
            const aOpen = (a as Record<string, unknown>).isOpen !== false ? 0 : 1;
            const bOpen = (b as Record<string, unknown>).isOpen !== false ? 0 : 1;
            return aOpen - bOpen;
          });
          usePositionStore.getState().setPositions(sorted);
        }
        if (typeof data.realizedPnl === "number") {
          usePositionStore.getState().setRealizedPnl(data.realizedPnl);
        }
      } else if (topic.startsWith("model:prices:")) {
        const prices = payload as ModelPricesResult;
        this._queueModelPrices(prices);
      } else if (topic.startsWith("svi:alerts:")) {
        const alert = payload as { level?: string; title?: string; message?: string };
        if (alert.title) {
          useMarketDataStore.getState().addSviAlert(alert as { level: string; title: string; message: string });
        }
      }
    });

    wsClient.connect();
    wsClient.subscribe(["orders:updates:default"]);

    // Subscribe to topics when underlying/expiry are selected
    this._unsub = useMarketDataStore.subscribe((state, prevState) => {
      const underlying = state.selectedUnderlying;
      const expiry = state.selectedExpiry;
      const prevUnderlying = prevState.selectedUnderlying;
      const prevExpiry = prevState.selectedExpiry;
      const hadPreviousSelection = !!(prevUnderlying && prevExpiry);
      const hasCurrentSelection = !!(underlying && expiry);

      if (underlying === prevUnderlying && expiry === prevExpiry) return;

      // Unsubscribe old topics
      if (hadPreviousSelection) {
        wsClient.unsubscribe([
          `ticks:option:${prevUnderlying}:${prevExpiry}`,
          `ticks:chain:${prevUnderlying}:${prevExpiry}`,
          `greeks:computed:${prevUnderlying}:${prevExpiry}`,
          `greeks:batch:${prevUnderlying}:${prevExpiry}`,
          `model:prices:${prevUnderlying}:${prevExpiry}`,
        ]);
      }

      if (!hasCurrentSelection) return;

      useMarketDataStore.getState().clearTicks();
      useGreeksStore.getState().clearGreeks();
      useMarketDataStore.getState().setSviParams(null);
      useMarketDataStore.getState().setModelPrices(null);

      // Subscribe new topics
      wsClient.subscribe([
        `ticks:option:${underlying}:${expiry}`,
        `ticks:chain:${underlying}:${expiry}`,
        `greeks:computed:${underlying}:${expiry}`,
        `greeks:batch:${underlying}:${expiry}`,
        `model:prices:${underlying}:${expiry}`,
      ]);
    });
  }

  private async _loadUnderlyings(): Promise<void> {
    try {
      const { getConfig } = await import("@/lib/config");
      const { apiUrl } = getConfig();
      const resp = await fetch(`${apiUrl}/api/v1/underlyings`);
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data)) {
          const enabled = data
            .filter((u: { enabled?: boolean }) => u.enabled !== false)
            .map((u: { name: string }) => u.name);
          if (enabled.length > 0) {
            useMarketDataStore.getState().setAvailableUnderlyings(enabled);
          }
        }
      }
    } catch {
      // Fallback: store remains empty, toolbar uses hardcoded list
    }
  }

  destroy(): void {
    const feedMode = useMarketDataStore.getState().feedMode;
    if (feedMode === "mock") {
      import("@/mocks").then(({ teardownMocks }) => teardownMocks());
    } else {
      wsClient.disconnect();
    }
    if (this._removeMessageHandler) {
      this._removeMessageHandler();
      this._removeMessageHandler = null;
    }
    if (this._greeksFlushHandle !== null) {
      clearTimeout(this._greeksFlushHandle);
      this._greeksFlushHandle = null;
    }
    if (this._modelPricesFlushHandle !== null) {
      clearTimeout(this._modelPricesFlushHandle);
      this._modelPricesFlushHandle = null;
    }
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    useMarketDataStore.getState().setFeedMode(null);
  }

  private _queueGreeks(greeks: GreeksResult): void {
    this._pendingGreeks.set(greeks.symbol, greeks);
    if (this._greeksFlushHandle !== null) return;

    // Batch off the paint boundary. Running a large Greeks merge inside
    // requestAnimationFrame creates long frame tasks and visible jank.
    this._greeksFlushHandle = setTimeout(() => {
      this._greeksFlushHandle = null;
      const batch = [...this._pendingGreeks.values()];
      this._pendingGreeks.clear();
      startTransition(() => {
        useGreeksStore.getState().updateGreeksBatch(batch);
      });
    }, 32);
  }

  private _queueModelPrices(prices: ModelPricesResult): void {
    this._pendingModelPrices = prices;
    if (this._modelPricesFlushHandle !== null) return;

    this._modelPricesFlushHandle = setTimeout(() => {
      this._modelPricesFlushHandle = null;
      if (!this._pendingModelPrices) return;
      const latest = this._pendingModelPrices;
      this._pendingModelPrices = null;
      startTransition(() => {
        useMarketDataStore.getState().setModelPrices(latest);
      });
    }, 200);
  }
}
