import { useCallback } from "react";
import type { CellClickedEvent } from "ag-grid-community";

import type { OptionType, Side } from "@/types/market-data";
import { useBasketStore } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";

interface FieldMapping {
  optionType: OptionType;
  side: Side;
}

const CLICKABLE_FIELDS: Record<string, FieldMapping> = {
  callLtp: { optionType: "CE", side: "BUY" },
  putLtp: { optionType: "PE", side: "BUY" },
};

export function useCellClickHandler() {
  return useCallback((event: CellClickedEvent) => {
    const field = event.colDef.field;
    if (!field || !(field in CLICKABLE_FIELDS)) return;

    const mapping = CLICKABLE_FIELDS[field];
    const strike = event.data?.strike as number | undefined;
    const premium = event.value as number | null;

    if (strike === undefined || premium === null || premium === undefined)
      return;

    const { selectedUnderlying, selectedExpiry } =
      useMarketDataStore.getState();

    if (!selectedUnderlying || !selectedExpiry) return;

    useBasketStore.getState().addLegFromChain({
      strike,
      optionType: mapping.optionType,
      side: mapping.side,
      premium,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
    });
  }, []);
}
