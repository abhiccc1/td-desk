import { useEffect, useMemo } from "react";
import { AppState } from "react-native";
import { useQueryClient } from "@tanstack/react-query";

import { positionsKey } from "@/lib/api";
import { positionValueMultiplier } from "@/lib/instruments";
import {
  clearDemandContribution,
  POSITION_THROTTLE_MS,
  REASSERT_INTERVAL_MS,
  setDemandContribution,
  throttleFor,
} from "@/lib/ws/demand";
import { streamClient } from "@/lib/ws/stream-client";
import type { Position, PositionsEnvelope, PositionsPayload, TickData, Underlying } from "@/types/api";

const EMPTY_UNDERLYING_MAP: Record<string, Underlying> = {};

export function usePositionsSubscription(
  positions: Position[],
  underlyingMap: Record<string, Underlying> = EMPTY_UNDERLYING_MAP,
) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const topic = "orders:updates:default";
    streamClient.connect();
    streamClient.subscribe([topic]);

    const unsubscribe = streamClient.onMessage((incomingTopic, payload) => {
      if (incomingTopic !== topic) return;
      const update = payload as PositionsPayload;
      if (!update?.positions) return;
      queryClient.setQueryData(positionsKey, {
        positions: update.positions,
        realizedPnl: update.realizedPnl ?? 0,
      });
    });

    return () => {
      unsubscribe();
      streamClient.unsubscribe([topic]);
    };
  }, [queryClient]);

  const positionChains = useMemo(() => {
    const needed = new Map<string, { underlying: string; expiry: string }>();
    for (const position of positions) {
      if (!isOpenPosition(position)) continue;
      const parsed = parsePositionSymbol(position.symbol);
      if (!parsed) continue;
      needed.set(`${parsed.underlying}:${parsed.expiry}`, parsed);
    }
    return [...needed.values()];
  }, [positions]);

  const positionTopics = useMemo(
    () => positionChains.map((chain) => `ticks:option:${chain.underlying}:${chain.expiry}`),
    [positionChains],
  );

  // Claim quotes-only demand for every expiry we hold a position in. These
  // chains keep emitting position snapshots whether or not anything is viewing
  // them, and without a claim the backend assumes the full analytics pipeline
  // and runs an IV + Greeks solve over the whole strip for data this app never
  // displays — P&L here comes from the raw tick stream.
  useEffect(() => {
    if (positionChains.length === 0) {
      clearDemandContribution("positions");
      return;
    }

    const pushDemand = () => {
      setDemandContribution(
        "positions",
        positionChains.map((chain) => ({
          ...chain,
          throttleMs: throttleFor(POSITION_THROTTLE_MS),
        })),
      );
    };
    pushDemand();

    const appStateSub = AppState.addEventListener("change", pushDemand);
    const reassert = setInterval(pushDemand, REASSERT_INTERVAL_MS);

    return () => {
      clearInterval(reassert);
      appStateSub.remove();
      clearDemandContribution("positions");
    };
  }, [positionChains]);

  useEffect(() => {
    if (positionTopics.length === 0) return;

    streamClient.connect();
    streamClient.subscribe(positionTopics, { passive: true });

    const unsubscribe = streamClient.onMessage((incomingTopic, payload) => {
      if (!incomingTopic.startsWith("ticks:option:")) return;
      const tick = payload as TickData;
      if (!tick?.symbol || !Number.isFinite(tick.ltp)) return;

      queryClient.setQueryData(
        positionsKey,
        (current: PositionsEnvelope | undefined): PositionsEnvelope | undefined => {
          if (!current) return current;

          let changed = false;
          const nextPositions = current.positions.map((position) => {
            if (position.symbol !== tick.symbol) return position;
            changed = true;
            return applyLiveTickToPosition(position, tick.ltp, positionValueMultiplier(position, underlyingMap));
          });

          return changed ? { ...current, positions: nextPositions } : current;
        },
      );
    });

    return () => {
      unsubscribe();
      streamClient.unsubscribe(positionTopics);
    };
  }, [positionTopics, queryClient, underlyingMap]);
}

function parsePositionSymbol(sym: string): { underlying: string; expiry: string } | null {
  const match = sym.match(/^([A-Z]+)\s+(\d{6})\s+[\d.]+\s+(?:CE|PE)$/);
  if (!match) return null;
  const raw = match[2];
  return {
    underlying: match[1],
    expiry: `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`,
  };
}

function isOpenPosition(position: Position) {
  const qty = position.netQty ?? position.quantity ?? 0;
  return position.isOpen !== false && qty !== 0;
}

function applyLiveTickToPosition(position: Position, liveLtp: number, multiplier: number): Position {
  if (liveLtp <= 0) return position;

  const bookedPnl = position.bookedPnl ?? 0;
  const quantity = position.quantity ?? position.netQty ?? 0;
  const realizedPnlComponent = position.realizedPnlComponent ?? 0;

  if (position.isOpen === false) {
    return {
      ...position,
      ltp: liveLtp,
      pnl: bookedPnl,
      unrealizedPnl: 0,
    };
  }

  const totalPnl = bookedPnl + (quantity * liveLtp * multiplier);
  const unrealizedPnl = totalPnl - realizedPnlComponent;

  return {
    ...position,
    ltp: round2(liveLtp),
    pnl: round2(totalPnl),
    unrealizedPnl: round2(unrealizedPnl),
  };
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}
