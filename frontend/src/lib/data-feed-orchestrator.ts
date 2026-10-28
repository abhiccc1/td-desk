/**
 * Data feed orchestrator — manages the live broker-backed data pipeline.
 */

import { startTransition } from "react";

import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type { GreeksResult, ModelPricesResult, OptionChainSnapshot, TickData, VrpResult } from "@/types/market-data";
import type { OrderLifecycleEvent, Position } from "@/types/orders";

import {
  ChainDemandController,
  DEMAND_REASSERT_INTERVAL_MS,
  DEMAND_THROTTLE_MS,
  type ChainDemand,
} from "./chain-demand";
import { toastOrderLifecycleEvent } from "./order-toast";
import { wsClient } from "./ws-client";

/** Parse "NIFTY 260319 22000 CE" into parts. */
function parsePositionSymbol(sym: string): { underlying: string; expiry: string } | null {
  const m = sym.match(/^([A-Z]+)\s+(\d{6})\s+[\d.]+\s+(?:CE|PE)$/);
  if (!m) return null;
  const raw = m[2];
  return {
    underlying: m[1],
    expiry: `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`,
  };
}

export class DataFeedOrchestrator {
  private _unsub: (() => void) | null = null;
  private _removeMessageHandler: (() => void) | null = null;
  private _pendingGreeks = new Map<string, GreeksResult>();
  private _greeksFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private _pendingModelPrices: ModelPricesResult | null = null;
  private _modelPricesFlushHandle: ReturnType<typeof setTimeout> | null = null;
  private _positionTopics = new Set<string>();
  private _removeReconnectHandler: (() => void) | null = null;
  private _unsubPositionStore: (() => void) | null = null;
  private _demand = new ChainDemandController();
  private _removeDemandHandler: (() => void) | null = null;
  private _demandReassertTimer: ReturnType<typeof setInterval> | null = null;
  /** The chain whose topics are currently subscribed, or null when demand is
   *  off. Kept as the single record of what the socket actually holds so
   *  subscribe/unsubscribe can never double-fire or leak a chain. */
  private _activeChainKey: { underlying: string; expiry: string } | null = null;

  private _modelTimestampMs(prices: ModelPricesResult | null): number {
    if (!prices?.timestamp) return 0;
    const ts = new Date(prices.timestamp).getTime();
    return Number.isFinite(ts) ? ts : 0;
  }

  async init(): Promise<void> {
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

      if (topic.startsWith("ticks:spot:")) {
        const tick = payload as TickData;
        if (tick) {
          useMarketDataStore.getState().updateTick(tick);
        }
        return;
      }

      if (topic.startsWith("ticks:chain:")) {
        const chain = payload as OptionChainSnapshot;
        useMarketDataStore.getState().setOptionChain(chain);
      } else if (topic.startsWith("greeks:position_batch:")) {
        const batch = payload as { greeks: GreeksResult[] };
        if (batch && Array.isArray(batch.greeks)) {
          startTransition(() => {
            useGreeksStore.getState().updatePositionGreeksBatch(batch.greeks);
          });
        }
      } else if (topic.startsWith("greeks:batch:")) {
        const batch = payload as { greeks: GreeksResult[] };
        if (batch && Array.isArray(batch.greeks)) {
          startTransition(() => {
            // Update chain greeks
            useGreeksStore.getState().updateGreeksBatch(batch.greeks);

            // Also update positionGreeks for symbols that match open positions
            const positionSymbols = new Set(
              usePositionStore.getState().positions
                .filter((p) => (p as Record<string, unknown>).isOpen !== false)
                .map((p) => p.symbol),
            );
            const positionBatch = batch.greeks.filter((g) => positionSymbols.has(g.symbol));
            if (positionBatch.length > 0) {
              useGreeksStore.getState().updatePositionGreeksBatch(positionBatch);
            }
          });
        }
      } else if (topic.startsWith("greeks:computed:")) {
        const greeks = payload as GreeksResult;
        this._queueGreeks(greeks);
      } else if (topic.startsWith("orders:updates:")) {
        const data = payload as { positions?: Position[]; realizedPnl?: number };
        if (data.positions) {
          usePositionStore.getState().setPositions(data.positions);
        }
        // Signal order book components to refresh
        usePositionStore.getState().bumpOrderUpdate();
        if (typeof data.realizedPnl === "number") {
          usePositionStore.getState().setRealizedPnl(data.realizedPnl);
        }
      } else if (topic.startsWith("orders:events:")) {
        const event = payload as OrderLifecycleEvent;
        if (event && event.status) {
          toastOrderLifecycleEvent(event);
        }
      } else if (topic.startsWith("model:analytics:")) {
        const prices = payload as ModelPricesResult;
        this._queueModelPrices(prices);
      } else if (topic.startsWith("model:prices:")) {
        const prices = payload as ModelPricesResult;
        this._queueModelPrices(prices);
      } else if (topic.startsWith("vrp:computed:")) {
        const vrp = payload as VrpResult;
        if (vrp && vrp.underlying) {
          useMarketDataStore.getState().setVrp(vrp);
        }
      } else if (topic.startsWith("svi:alerts:")) {
        const alert = payload as { level?: string; title?: string; message?: string };
        if (alert.title) {
          useMarketDataStore.getState().addSviAlert(alert as { level: string; title: string; message: string });
        }
      } else if (topic.startsWith("session:")) {
        const status = payload as { version?: number; status?: string };
        if (status?.status) {
          const s = status.status as "active" | "reconnecting" | "degraded" | "expired";
          useMarketDataStore.getState().setSessionStatus(s);
          if (s === "active") {
            // Session recovered — refresh stale data
            this._reconcileOnReconnect();
          }
        }
      }
    });

    // On WS reconnect: reconcile all data that may have been missed
    this._removeReconnectHandler = wsClient.onReconnect(() => {
      this._reconcileOnReconnect();
    });

    wsClient.connect();
    wsClient.subscribe(["orders:updates:default", "orders:events:default", "session:status"]);
    void this._reconcileOnReconnect();

    // Sync position tick topics whenever the position store changes
    // (covers initial REST fetch, WS updates, and reconnect reconciliation)
    this._unsubPositionStore = usePositionStore.subscribe((state, prev) => {
      if (state.positions !== prev.positions) {
        this._syncPositionTopics(state.positions);
      }
    });

    // Subscribe to topics when underlying/expiry are selected
    this._unsub = useMarketDataStore.subscribe((state, prevState) => {
      const underlying = state.selectedUnderlying;
      const expiry = state.selectedExpiry;
      const prevUnderlying = prevState.selectedUnderlying;
      const prevExpiry = prevState.selectedExpiry;
      const hadPreviousSelection = !!(prevUnderlying && prevExpiry);
      const hasCurrentSelection = !!(underlying && expiry);

      if (underlying === prevUnderlying && expiry === prevExpiry) return;

      // Spot + VRP topics are per-underlying — subscribe/unsub independently of expiry
      if (underlying !== prevUnderlying) {
        if (prevUnderlying) {
          wsClient.unsubscribe([
            `ticks:spot:${prevUnderlying}`,
            `vrp:computed:${prevUnderlying}`,
          ]);
        }
        if (underlying) {
          wsClient.subscribe([
            `ticks:spot:${underlying}`,
            `vrp:computed:${underlying}`,
          ]);
        }
      }

      if (!hasCurrentSelection) {
        // Nothing selected any more — drop whatever chain is still held.
        this._syncChainTopics();
        return;
      }

      // Clear only ticks for the old chain — never clear position ticks
      const posSymbols = new Set(
        usePositionStore.getState().positions
          .filter((p) => (p as Record<string, unknown>).isOpen !== false)
          .map((p) => p.symbol),
      );
      if (hadPreviousSelection) {
        useMarketDataStore.getState().clearTicksForExpiry(prevUnderlying, prevExpiry, posSymbols);
      } else {
        // First selection — clear non-position ticks only
        const ticks = useMarketDataStore.getState().ticks;
        for (const key of [...ticks.keys()]) {
          if (!posSymbols.has(key)) ticks.delete(key);
        }
      }
      useGreeksStore.getState().clearGreeks();
      useMarketDataStore.getState().setSviParams(null);
      useMarketDataStore.getState().setModelPrices(null);
      if (prevUnderlying !== underlying) {
        useMarketDataStore.getState().setVrp(null);
        useMarketDataStore.getState().setSpotStatic(null);
        useMarketDataStore.getState().setAvailableExpiries([]);
      }

      // Chain topics (spot + VRP already handled above) are owned by the
      // demand reconciler: whether they are held at all depends on whether
      // anything is looking at the chain, not just on what is selected.
      this._syncChainTopics();
    });

    // Compute demand: panel layout, tab visibility and user idleness decide
    // how hard the backend works on the selected chain.
    this._removeDemandHandler = this._demand.onChange(() => {
      this._syncChainTopics();
    });
    this._demand.start();

    // Restate demand periodically. Demand messages are fire-and-forget, and
    // the market-data service holds the level in memory, so a restart on
    // either side would otherwise leave a chain at the wrong cadence until the
    // next user action. This bounds that to one interval.
    this._demandReassertTimer = setInterval(() => {
      this._pushDemand(this._demand.snapshot());
    }, DEMAND_REASSERT_INTERVAL_MS);

    this._syncChainTopics();
  }

  private _chainTopics(underlying: string, expiry: string): string[] {
    return [
      `ticks:option:${underlying}:${expiry}`,
      `ticks:chain:${underlying}:${expiry}`,
      `greeks:computed:${underlying}:${expiry}`,
      `greeks:batch:${underlying}:${expiry}`,
      `model:prices:${underlying}:${expiry}`,
      `model:analytics:${underlying}:${expiry}`,
    ];
  }

  /**
   * Reconcile the chain topics the socket holds against current demand, then
   * restate the demand level.
   *
   * Idempotent and driven off `_activeChainKey` rather than off the event that
   * triggered it, so a selection change, a panel being closed, a tab blur and
   * the idle timer can all call it in any order without leaking or
   * double-subscribing a chain.
   */
  private _syncChainTopics(): void {
    const demand = this._demand.snapshot();
    const wanted =
      demand.level === "off"
        ? null
        : { underlying: demand.underlying, expiry: demand.expiry };
    const held = this._activeChainKey;

    if (
      held &&
      (!wanted || held.underlying !== wanted.underlying || held.expiry !== wanted.expiry)
    ) {
      // Position topics are pinned, so a chain that also holds open positions
      // keeps streaming its ticks through wsClient's pin filter.
      wsClient.unsubscribe(this._chainTopics(held.underlying, held.expiry));
      this._activeChainKey = null;
    }

    if (wanted && this._activeChainKey === null) {
      wsClient.subscribe(this._chainTopics(wanted.underlying, wanted.expiry));
      this._activeChainKey = wanted;
    }

    this._pushDemand(demand);
  }

  private _pushDemand(demand: ChainDemand): void {
    wsClient.setDemand(
      demand.level === "off"
        ? []
        : [
            {
              underlying: demand.underlying,
              expiry: demand.expiry,
              throttleMs: DEMAND_THROTTLE_MS[demand.level],
              analytics: demand.analytics,
            },
          ],
    );
  }

  private async _loadUnderlyings(): Promise<void> {
    try {
      const { getConfig } = await import("@/lib/config");
      const { apiUrl } = getConfig();
      const resp = await fetch(`${apiUrl}/api/v1/underlyings`);
      if (resp.ok) {
        const data = await resp.json();
        const { parseUnderlyings, setUnderlyingMeta, loadContractMeta } = await import("@/lib/instruments");
        const meta = parseUnderlyings(data).filter((u) => u.enabled);
        if (meta.length > 0) {
          // Registry first so pure helpers (multipliers, expiry close) see it
          // before components re-render off the store update.
          setUnderlyingMeta(meta);
          const store = useMarketDataStore.getState();
          store.setUnderlyingMeta(meta);
          store.setAvailableUnderlyings(meta.map((u) => u.name));
          // MCX option tick sizes (₹0.10 / 0.05 / 0.50) for limit-price stepping
          for (const u of meta) {
            if (u.assetClass === "commodity") void loadContractMeta(apiUrl, u.name);
          }
        }
      }
    } catch {
      // Fallback: store remains empty, toolbar uses hardcoded list
    }
  }

  destroy(): void {
    wsClient.disconnect();
    if (this._demandReassertTimer !== null) {
      clearInterval(this._demandReassertTimer);
      this._demandReassertTimer = null;
    }
    if (this._removeDemandHandler) {
      this._removeDemandHandler();
      this._removeDemandHandler = null;
    }
    this._demand.stop();
    this._activeChainKey = null;
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
    if (this._unsubPositionStore) {
      this._unsubPositionStore();
      this._unsubPositionStore = null;
    }
    if (this._removeReconnectHandler) {
      this._removeReconnectHandler();
      this._removeReconnectHandler = null;
    }
    if (this._positionTopics.size > 0) {
      wsClient.unpinAndUnsubscribe([...this._positionTopics]);
      this._positionTopics.clear();
    }
    if (this._unsub) {
      this._unsub();
      this._unsub = null;
    }
    useMarketDataStore.getState().setFeedMode(null);
  }

  private async _reconcileOnReconnect(): Promise<void> {
    const {
      fetchPositions,
      fetchPositionGreeks,
      fetchOptionChain,
      fetchGreeks,
      fetchSvi,
      fetchModelPrices,
    } = await import("@/lib/api-client");

    // Positions
    try {
      const data = await fetchPositions();
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const { positions: pos, realizedPnl } = data as {
          positions: (Position & { isOpen?: boolean })[];
          realizedPnl: number;
        };
        if (Array.isArray(pos)) {
          usePositionStore.getState().setPositions(pos);
        }
        if (typeof realizedPnl === "number") {
          usePositionStore.getState().setRealizedPnl(realizedPnl);
        }
      }
    } catch { /* stream will recover */ }

    // Option chain + greeks + SVI + model prices for current selection
    const underlying = useMarketDataStore.getState().selectedUnderlying;
    const expiry = useMarketDataStore.getState().selectedExpiry;
    if (!underlying || !expiry) return;

    try {
      const [chain, greeks, svi, modelPrices] = await Promise.all([
        fetchOptionChain(underlying, expiry).catch(() => null),
        fetchGreeks(underlying, expiry).catch(() => []),
        fetchSvi(underlying, expiry).catch(() => null),
        fetchModelPrices(underlying, expiry).catch(() => null),
      ]);

      if (chain) useMarketDataStore.getState().setOptionChain(chain);
      if (svi) useMarketDataStore.getState().setSviParams(svi);
      if (modelPrices) useMarketDataStore.getState().setModelPrices(modelPrices);
      if (Array.isArray(greeks) && greeks.length > 0) {
        useGreeksStore.getState().updateGreeksBatch(greeks);
      }
    } catch { /* stream will recover */ }

    // Position Greeks (all expiries) — cold start / reconnect seed
    try {
      const posGreeks = await fetchPositionGreeks();
      if (posGreeks.length > 0) {
        useGreeksStore.getState().updatePositionGreeksBatch(posGreeks);
      }
    } catch { /* ignore — will arrive via WS stream */ }
  }

  private _syncPositionTopics(positions: Position[]): void {
    const needed = new Set<string>();
    for (const pos of positions) {
      const rec = pos as Record<string, unknown>;
      if (rec.isOpen === false || rec.netQty === 0) continue;
      const parsed = parsePositionSymbol(pos.symbol);
      if (parsed) {
        needed.add(`ticks:option:${parsed.underlying}:${parsed.expiry}`);
        needed.add(`greeks:position_batch:${parsed.underlying}:${parsed.expiry}`);
      }
    }

    // Unpin + unsubscribe position topics no longer needed
    const toRemove = [...this._positionTopics].filter((t) => !needed.has(t));
    if (toRemove.length > 0) {
      wsClient.unpinAndUnsubscribe(toRemove);
    }

    // Subscribe new topics (passive — backend PositionSubscriber handles Kotak tokens)
    const toAdd = [...needed].filter((t) => !this._positionTopics.has(t));
    if (toAdd.length > 0) {
      wsClient.subscribe(toAdd, { passive: true });
    }

    this._positionTopics = needed;
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
    }, 16);
  }

  private _queueModelPrices(prices: ModelPricesResult): void {
    if (
      this._pendingModelPrices === null
      || this._modelTimestampMs(prices) >= this._modelTimestampMs(this._pendingModelPrices)
    ) {
      this._pendingModelPrices = prices;
    }
    if (this._modelPricesFlushHandle !== null) return;

    this._modelPricesFlushHandle = setTimeout(() => {
      this._modelPricesFlushHandle = null;
      if (!this._pendingModelPrices) return;
      const latest = this._pendingModelPrices;
      this._pendingModelPrices = null;
      startTransition(() => {
        const current = useMarketDataStore.getState().modelPrices;
        if (this._modelTimestampMs(latest) >= this._modelTimestampMs(current)) {
          useMarketDataStore.getState().setModelPrices(latest);
        }
      });
    }, 80);
  }
}
