import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { fetchUnderlyings, underlyingsKey } from "@/lib/api";
import { buildUnderlyingMap, hasMcxUnderlyings, type Segment } from "@/lib/instruments";
import { useSegmentStore } from "@/stores/use-segment-store";

/**
 * Effective segment for the current user. When /underlyings returns no MCX
 * rows the toggle is hidden and everything behaves as EQ_IDX, regardless of
 * what was persisted.
 */
export function useActiveSegment() {
  const storedSegment = useSegmentStore((state) => state.segment);
  const setSegment = useSegmentStore((state) => state.setSegment);
  const underlyingsQuery = useQuery({
    queryKey: underlyingsKey,
    queryFn: fetchUnderlyings,
  });

  const underlyings = useMemo(() => underlyingsQuery.data ?? [], [underlyingsQuery.data]);
  const mcxAvailable = hasMcxUnderlyings(underlyings);
  const segment: Segment = mcxAvailable ? storedSegment : "EQ_IDX";
  const underlyingMap = useMemo(() => buildUnderlyingMap(underlyings), [underlyings]);

  return {
    segment,
    setSegment,
    mcxAvailable,
    underlyings,
    underlyingMap,
    underlyingsQuery,
  };
}
