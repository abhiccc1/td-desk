/**
 * Fetches option chain, greeks, SVI params, and positions from the REST API
 * whenever the selected underlying or expiry changes.
 *
 * This provides the initial data load; WebSocket handles real-time updates.
 */

import { useEffect } from "react";

import {
  fetchExpiries,
  fetchGreeks,
  fetchModelPrices,
  fetchOptionChain,
  fetchStaticData,
  fetchSvi,
} from "@/lib/api-client";
import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";

export function useLiveData() {
  const underlying = useMarketDataStore((s) => s.selectedUnderlying);
  const expiry = useMarketDataStore((s) => s.selectedExpiry);
  const feedMode = useMarketDataStore((s) => s.feedMode);

  // Fetch available expiries when underlying changes
  useEffect(() => {
    if (!underlying) return;
    if (feedMode === "mock") return;

    let cancelled = false;

    fetchExpiries(underlying)
      .then((expiries) => {
        if (!cancelled) {
          useMarketDataStore.getState().setAvailableExpiries(expiries);
          // Auto-select nearest expiry when underlying changes
          if (expiries.length > 0) {
            const current = useMarketDataStore.getState().selectedExpiry;
            if (!current || !expiries.includes(current)) {
              useMarketDataStore.getState().setSelectedExpiry(expiries[0]);
            }
          }
        }
      })
      .catch(() => {});

    // Fetch static OHLC data for the underlying index
    fetchStaticData(underlying)
      .then((data) => {
        if (!cancelled) {
          useMarketDataStore.getState().setSpotStatic(data);
        }
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [underlying, feedMode]);

  // Fetch option chain + greeks + SVI when underlying/expiry changes
  useEffect(() => {
    if (!underlying || !expiry) return;
    // Skip REST fetches in mock mode — mock ticker handles everything
    if (feedMode === "mock") return;

    let cancelled = false;

    // Clear stale derived state immediately before fetch
    useGreeksStore.getState().clearGreeks();
    useMarketDataStore.getState().setOptionChain(null);
    useMarketDataStore.getState().setSviParams(null);
    useMarketDataStore.getState().setModelPrices(null);

    async function load() {
      try {
        const [chain, greeks, svi, modelPrices] = await Promise.all([
          fetchOptionChain(underlying, expiry),
          fetchGreeks(underlying, expiry).catch(() => []),
          fetchSvi(underlying, expiry).catch(() => null),
          fetchModelPrices(underlying, expiry).catch(() => null),
        ]);

        if (cancelled) return;

        useMarketDataStore.getState().setOptionChain(chain);
        useMarketDataStore.getState().setSviParams(svi);
        useMarketDataStore.getState().setModelPrices(modelPrices);
        useGreeksStore.getState().updateGreeksBatch(greeks);
      } catch {
        // API might not be ready yet — WS will provide data when available
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [underlying, expiry, feedMode]);

  // Positions are fetched by PositionMonitor component directly
}
