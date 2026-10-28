import { create } from "zustand";
import { persist } from "zustand/middleware";

import { segmentOfExchange } from "@/lib/instruments";
import type { Segment } from "@/lib/instruments";
import { useMarketDataStore } from "@/stores/market-data-store";

interface SegmentState {
  /** Active market segment: NSE+BSE index options or MCX commodity options. */
  segment: Segment;
  setSegment: (segment: Segment) => void;
}

export const useSegmentStore = create<SegmentState>()(
  persist(
    (set) => ({
      segment: "EQ_IDX",
      setSegment: (segment) => set({ segment }),
    }),
    {
      name: "td-desk-segment",
      merge: (persisted, current) => {
        const seg = (persisted as Partial<SegmentState> | undefined)?.segment;
        return { ...current, segment: seg === "MCX" ? "MCX" : "EQ_IDX" };
      },
    },
  ),
);

/**
 * Segment filter for positions/orders. Inactive (shows everything) until the
 * backend exposes MCX underlyings, so books look exactly as before.
 */
export function useSegmentFilter(): { active: boolean; segment: Segment } {
  const segment = useSegmentStore((s) => s.segment);
  const hasMcx = useMarketDataStore((s) => s.underlyingMeta.some((u) => segmentOfExchange(u.exchange) === "MCX"));
  return { active: hasMcx, segment: hasMcx ? segment : "EQ_IDX" };
}
