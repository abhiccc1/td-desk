import {
  fetchPositions,
  fetchPaperPositions,
  placeOrders,
  placePaperOrders,
} from "@/lib/api-client";
import type { PlaceOrderLeg, PlaceOrderResult } from "@/lib/api-client";
import { usePositionStore } from "@/stores/position-store";
import { usePaperPositionStore } from "@/stores/paper-position-store";

/**
 * A pluggable data source for {@link PositionMonitor}, so the exact same
 * component can render either the LIVE book or the PAPER book.
 *
 * The safety-critical field is {@link placeOrders}: for the paper data source
 * it points at the isolated paper endpoint, guaranteeing that square-off /
 * modify actions taken on paper positions can never reach the live broker.
 */
export interface PositionDataSource {
  /** Zustand store hook (also exposes `.getState()` / `.subscribe()`). */
  store: typeof usePositionStore;
  fetchPositions: () => Promise<unknown>;
  placeOrders: (legs: PlaceOrderLeg[]) => Promise<PlaceOrderResult[]>;
  /** Short label shown in the panel header, e.g. "LIVE" / "PAPER". */
  label: string;
  isPaper: boolean;
  /**
   * Poll interval (ms) for refetching positions. Live positions are pushed via
   * WebSocket so they don't poll; paper positions have no push channel and so
   * poll on this interval.
   */
  pollMs?: number;
}

export const liveDataSource: PositionDataSource = {
  store: usePositionStore,
  fetchPositions,
  placeOrders,
  label: "LIVE",
  isPaper: false,
};

export const paperDataSource: PositionDataSource = {
  store: usePaperPositionStore,
  fetchPositions: fetchPaperPositions,
  placeOrders: placePaperOrders,
  label: "PAPER",
  isPaper: true,
  pollMs: 4000,
};
