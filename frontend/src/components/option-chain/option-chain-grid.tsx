"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellClassParams,
  CellClickedEvent,
  GetRowIdParams,
  GridReadyEvent,
  GridApi,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/lib/ag-grid-setup";

import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { GreeksResult, ModelPricesResult, OptionChainSnapshot, OptionStrike, SviParams, TickData } from "@/types/market-data";
import { bsPrice } from "@/lib/black-scholes";

const RISK_FREE_RATE = 0.065;

export interface OptionChainRow {
  strike: number;
  callLtp: number | null;
  callFair: number | null;
  callIv: number | null;
  callSviIv: number | null;
  callHestonIv: number | null;
  callVgIv: number | null;
  callIvDiff: number | null;
  callDelta: number | null;
  putDelta: number | null;
  putIvDiff: number | null;
  putSviIv: number | null;
  putHestonIv: number | null;
  putVgIv: number | null;
  putIv: number | null;
  putFair: number | null;
  putLtp: number | null;
  /** Marker for the spot-price divider row */
  _isSpotDivider?: boolean;
  _isCallItm?: boolean;
  _spotPrice?: number;
  _spotChange?: number;
  _spotPctChange?: number;
}

const PATCHABLE_FIELDS: (keyof OptionChainRow)[] = [
  "callLtp",
  "callFair",
  "callIv",
  "callSviIv",
  "callHestonIv",
  "callVgIv",
  "callIvDiff",
  "callDelta",
  "putDelta",
  "putIvDiff",
  "putSviIv",
  "putHestonIv",
  "putVgIv",
  "putIv",
  "putFair",
  "putLtp",
];

/** Build model IV lookup map from store's modelPrices. */
function buildModelIvMap(
  modelPrices: ModelPricesResult | null,
): Map<number, { hestonIv: number | null; vgIv: number | null }> {
  const map = new Map<number, { hestonIv: number | null; vgIv: number | null }>();
  if (!modelPrices) return map;
  for (const s of modelPrices.strikes) {
    map.set(s.strike, { hestonIv: s.hestonIv, vgIv: s.vgIv });
  }
  return map;
}

/** Evaluate SVI implied vol at a given strike. */
function sviIv(svi: SviParams, strike: number, spot: number, t: number): number | null {
  if (spot <= 0 || strike <= 0 || t <= 0) return null;
  const k = Math.log(strike / spot);
  const dk = k - svi.m;
  const w = svi.a + svi.b * (svi.rho * dk + Math.sqrt(dk * dk + svi.sigma * svi.sigma));
  if (w <= 0) return null;
  return Math.sqrt(w / t) * 100; // as percentage
}

function strikeToRow(
  s: OptionStrike,
  svi: SviParams | null,
  spot: number,
  t: number,
  greeksMap: Map<string, GreeksResult>,
  modelIvMap: Map<number, { hestonIv: number | null; vgIv: number | null }>,
  liveTicks: Map<string, TickData>,
): OptionChainRow {
  const callTick = s.call ? (liveTicks.get(s.call.symbol) ?? s.call) : null;
  const putTick = s.put ? (liveTicks.get(s.put.symbol) ?? s.put) : null;

  // SVI theoretical IV — always computed from fitted surface
  const callSviIv = svi ? sviIv(svi, s.strike, spot, t) : null;
  const putSviIv = svi ? sviIv(svi, s.strike, spot, t) : null;

  // Market IV from per-strike greeks (BSM solver)
  const callGreeks = callTick ? greeksMap.get(callTick.symbol) : undefined;
  const putGreeks = putTick ? greeksMap.get(putTick.symbol) : undefined;
  const callMarketIv = callGreeks?.iv ? callGreeks.iv * 100 : null;
  const putMarketIv = putGreeks?.iv ? putGreeks.iv * 100 : null;

  // IV Diff = Market IV - SVI IV (positive = expensive, negative = cheap)
  const callIvDiff = callMarketIv !== null && callSviIv !== null ? callMarketIv - callSviIv : null;
  const putIvDiff = putMarketIv !== null && putSviIv !== null ? putMarketIv - putSviIv : null;

  // Fair value from SVI IV + BSM pricing
  const callFair = callSviIv !== null && spot > 0 && t > 0
    ? bsPrice(spot, s.strike, t, RISK_FREE_RATE, callSviIv / 100, "CE")
    : null;
  const putFair = putSviIv !== null && spot > 0 && t > 0
    ? bsPrice(spot, s.strike, t, RISK_FREE_RATE, putSviIv / 100, "PE")
    : null;

  // Model IVs from Heston/VG FFT pricing
  const modelIvs = modelIvMap.get(s.strike);
  const hestonIvPct = modelIvs?.hestonIv != null ? modelIvs.hestonIv * 100 : null;
  const vgIvPct = modelIvs?.vgIv != null ? modelIvs.vgIv * 100 : null;

  return {
    strike: s.strike,
    callLtp: callTick?.ltp ?? null,
    callFair,
    callIv: callMarketIv ?? callSviIv,
    callSviIv,
    callHestonIv: hestonIvPct,
    callVgIv: vgIvPct,
    callIvDiff,
    callDelta: callGreeks?.delta ?? null,
    putDelta: putGreeks?.delta ?? null,
    putIvDiff,
    putSviIv,
    putHestonIv: hestonIvPct,
    putVgIv: vgIvPct,
    putIv: putMarketIv ?? putSviIv,
    putFair,
    putLtp: putTick?.ltp ?? null,
    _isCallItm: s.strike < spot,
  };
}

function buildSpotDivider(
  spot: number,
  prevClose: number,
): OptionChainRow | null {
  if (spot <= 0) return null;

  const liveChange = prevClose > 0 ? spot - prevClose : 0;
  const livePctChange = prevClose > 0 ? ((spot - prevClose) / prevClose) * 100 : 0;

  return {
    strike: spot + 0.001,
    callLtp: null,
    callFair: null,
    callIv: null,
    callSviIv: null,
    callHestonIv: null,
    callVgIv: null,
    callIvDiff: null,
    callDelta: null,
    putDelta: null,
    putIvDiff: null,
    putSviIv: null,
    putHestonIv: null,
    putVgIv: null,
    putIv: null,
    putFair: null,
    putLtp: null,
    _isSpotDivider: true,
    _isCallItm: false,
    _spotPrice: spot,
    _spotChange: liveChange,
    _spotPctChange: livePctChange,
  };
}

function hasSameStrikeStructure(
  chain: OptionChainSnapshot,
  strikeMap: Map<number, OptionStrike>,
): boolean {
  if (chain.strikes.length !== strikeMap.size) return false;
  const existingStrikes = [...strikeMap.keys()];
  for (let idx = 0; idx < chain.strikes.length; idx += 1) {
    if (chain.strikes[idx].strike !== existingStrikes[idx]) return false;
  }
  return true;
}

function computeDividerIndex(
  strikes: OptionStrike[],
  spot: number,
): number {
  if (spot <= 0) return -1;
  for (let idx = 0; idx < strikes.length; idx += 1) {
    if (strikes[idx].strike > spot) return idx;
  }
  return strikes.length;
}

function buildChainIndexes(
  chain: OptionChainSnapshot,
): { strikeMap: Map<number, OptionStrike>; symbolToStrike: Map<string, number> } {
  const strikeMap = new Map<number, OptionStrike>();
  const symbolToStrike = new Map<string, number>();

  for (const strikeEntry of chain.strikes) {
    strikeMap.set(strikeEntry.strike, strikeEntry);
    if (strikeEntry.call) symbolToStrike.set(strikeEntry.call.symbol, strikeEntry.strike);
    if (strikeEntry.put) symbolToStrike.set(strikeEntry.put.symbol, strikeEntry.strike);
  }

  return { strikeMap, symbolToStrike };
}

function buildRowsForChain(
  chain: OptionChainSnapshot,
  svi: SviParams | null,
  spotStaticPrevClose: number,
  modelPrices: ModelPricesResult | null,
  greeksMap: Map<string, GreeksResult>,
  liveTicks: Map<string, TickData>,
): { rows: OptionChainRow[]; strikeMap: Map<number, OptionStrike>; symbolToStrike: Map<string, number>; dividerIdx: number } {
  const spot = chain.underlyingPrice;
  // IST market close = 3:30 PM IST = 10:00 AM UTC
  const expiryClose = new Date(chain.expiry + "T10:00:00Z").getTime();
  const expiryMs = expiryClose - Date.now();
  const t = Math.max(expiryMs / (365.25 * 86400_000), 1e-6);
  const modelIvMap = buildModelIvMap(modelPrices);
  const strikeMap = new Map<number, OptionStrike>();
  const symbolToStrike = new Map<string, number>();
  const dataRows = chain.strikes.map((strikeEntry) => {
    strikeMap.set(strikeEntry.strike, strikeEntry);
    if (strikeEntry.call) symbolToStrike.set(strikeEntry.call.symbol, strikeEntry.strike);
    if (strikeEntry.put) symbolToStrike.set(strikeEntry.put.symbol, strikeEntry.strike);
    return strikeToRow(strikeEntry, svi, spot, t, greeksMap, modelIvMap, liveTicks);
  });

  const rows: OptionChainRow[] = [];
  const divider = buildSpotDivider(spot, spotStaticPrevClose);
  let dividerIdx = -1;
  let dividerInserted = false;

  for (let idx = 0; idx < dataRows.length; idx += 1) {
    if (!dividerInserted && divider && dataRows[idx].strike > spot) {
      rows.push(divider);
      dividerIdx = rows.length - 1;
      dividerInserted = true;
    }
    rows.push(dataRows[idx]);
  }

  if (!dividerInserted && divider) {
    rows.push(divider);
    dividerIdx = rows.length - 1;
  }

  return { rows, strikeMap, symbolToStrike, dividerIdx };
}

function rowIdFor(row: OptionChainRow): string {
  return row._isSpotDivider ? "__spot__" : String(row.strike);
}

function rowChanged(prev: OptionChainRow | undefined, next: OptionChainRow): boolean {
  if (!prev) return true;
  for (const field of PATCHABLE_FIELDS) {
    if (prev[field] !== next[field]) return true;
  }
  return false;
}

function patchRowNode(
  rowNode: { setDataValue: (colKey: string, newValue: unknown) => void },
  prev: OptionChainRow | undefined,
  next: OptionChainRow,
): void {
  for (const field of PATCHABLE_FIELDS) {
    if (prev?.[field] === next[field]) continue;
    rowNode.setDataValue(field, next[field] ?? null);
  }
}

/** Color IV Diff: green = cheap (buy opportunity), red = expensive (sell opportunity) */
const ivDiffClass = (params: CellClassParams<OptionChainRow>): string => {
  const value = params.value as number | null;
  if (value === null || value === undefined) return "";
  if (value > 2) return "text-red-400 font-semibold";    // significantly expensive
  if (value > 0.5) return "text-red-400/70";              // mildly expensive
  if (value < -2) return "text-green-400 font-semibold";  // significantly cheap
  if (value < -0.5) return "text-green-400/70";            // mildly cheap
  return "text-[#808090]";                                 // near fair value
};

const ivDiffFormatter = (p: { value: unknown }) => {
  if (p.value == null) return "";
  const v = p.value as number;
  return `${v >= 0 ? "+" : ""}${v.toFixed(1)}`;
};

/** Color fair value: green if LTP < Fair (cheap), red if LTP > Fair (expensive) */
function fairCellClass(field: "callFair" | "putFair"): (params: CellClassParams<OptionChainRow>) => string {
  const ltpField = field === "callFair" ? "callLtp" : "putLtp";
  return (params) => {
    const fair = params.value as number | null;
    const ltp = params.data?.[ltpField] as number | null | undefined;
    if (fair == null || ltp == null || ltp <= 0) return "text-[#808090]";
    const diff = ltp - fair;
    if (diff < -fair * 0.05) return "text-green-400";  // >5% cheaper than fair
    if (diff > fair * 0.05) return "text-red-400";      // >5% more expensive
    return "text-[#808090]";
  };
}

const deltaClass = (params: CellClassParams<OptionChainRow>): string => {
  const value = params.value as number | null;
  if (value === null || value === undefined) return "";
  if (value > 0) return "text-green-400";
  if (value < 0) return "text-red-400";
  return "";
};

const CLICKABLE_FIELDS = new Set(["callLtp", "putLtp"]);

function clickableCellClass(
  params: CellClassParams<OptionChainRow>,
): string[] {
  const classes: string[] = [];
  const field = params.colDef.field;
  if (!field || !CLICKABLE_FIELDS.has(field)) return classes;

  classes.push("cell-clickable");

  const activeLegSet = params.context?.activeLegSet as Set<string> | undefined;
  if (!activeLegSet || activeLegSet.size === 0) return classes;

  const strike = params.data?.strike;
  if (strike === undefined) return classes;

  if (field === "callLtp") {
    if (activeLegSet.has(`${strike}-CE-BUY`)) classes.push("cell-leg-buy");
    else if (activeLegSet.has(`${strike}-CE-SELL`)) classes.push("cell-leg-sell");
  } else if (field === "putLtp") {
    if (activeLegSet.has(`${strike}-PE-BUY`)) classes.push("cell-leg-buy");
    else if (activeLegSet.has(`${strike}-PE-SELL`)) classes.push("cell-leg-sell");
  }

  return classes;
}

// Toggleable column groups — each key controls a call+put column pair
const COLUMN_TOGGLES = [
  { key: "delta", label: "Delta" },
  { key: "iv", label: "IV" },
  { key: "svi", label: "SVI" },
  { key: "heston", label: "Heston" },
  { key: "vg", label: "VG" },
  { key: "edge", label: "Edge" },
  { key: "fair", label: "Fair" },
] as const;

type ColumnToggleKey = typeof COLUMN_TOGGLES[number]["key"];

const COLUMN_KEY_TO_FIELDS: Record<ColumnToggleKey, string[]> = {
  delta: ["callDelta", "putDelta"],
  iv: ["callIv", "putIv"],
  svi: ["callSviIv", "putSviIv"],
  heston: ["callHestonIv", "putHestonIv"],
  vg: ["callVgIv", "putVgIv"],
  edge: ["callIvDiff", "putIvDiff"],
  fair: ["callFair", "putFair"],
};

const STORAGE_KEY = "oc-visible-columns";

function loadVisibleColumns(): Set<ColumnToggleKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      return new Set(arr.filter((k) => COLUMN_TOGGLES.some((t) => t.key === k)) as ColumnToggleKey[]);
    }
  } catch {}
  // Default: LTP, Strike always shown; Delta + IV visible
  return new Set<ColumnToggleKey>(["delta", "iv"]);
}

function saveVisibleColumns(cols: Set<ColumnToggleKey>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...cols]));
}

interface OptionChainGridProps {
  onCellClicked?: (event: CellClickedEvent) => void;
  activeLegSet?: Set<string>;
}

export const OptionChainGrid = memo(function OptionChainGrid({
  onCellClicked,
  activeLegSet,
}: OptionChainGridProps) {
  const [visibleColumns, setVisibleColumns] = useState<Set<ColumnToggleKey>>(loadVisibleColumns);

  const toggleColumn = useCallback((key: ColumnToggleKey) => {
    setVisibleColumns((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      saveVisibleColumns(next);
      return next;
    });
  }, []);
  const gridRef = useRef<AgGridReact<OptionChainRow>>(null);
  const apiRef = useRef<GridApi<OptionChainRow> | null>(null);
  const rowsByIdRef = useRef<Map<string, OptionChainRow>>(new Map());
  const rowOrderRef = useRef<string[]>([]);
  const strikeMapRef = useRef<Map<number, OptionStrike>>(new Map());
  const symbolToStrikeRef = useRef<Map<string, number>>(new Map());
  const chainKeyRef = useRef("");
  const userScrolledRef = useRef(false);
  const programmaticScrollUntilRef = useRef(0);
  const pendingSyncRef = useRef<number | null>(null);
  const scrollingUntilRef = useRef(0);
  const pendingStrikeFlushRef = useRef<number | null>(null);
  const pendingStrikeUpdatesRef = useRef<Set<number>>(new Set());

  const priceFormatter = useCallback(
    (p: { value: unknown }) =>
      p.value != null ? (p.value as number).toFixed(2) : "",
    [],
  );

  const ivFormatter = useCallback(
    (p: { value: unknown }) =>
      p.value != null ? `${(p.value as number).toFixed(1)}%` : "",
    [],
  );

  // Collect hidden fields from toggle state
  const hiddenFields = useMemo(() => {
    const set = new Set<string>();
    for (const toggle of COLUMN_TOGGLES) {
      if (!visibleColumns.has(toggle.key)) {
        for (const f of COLUMN_KEY_TO_FIELDS[toggle.key]) set.add(f);
      }
    }
    return set;
  }, [visibleColumns]);

  const allColumnDefs = useMemo<ColDef<OptionChainRow>[]>(
    () => [
      { headerName: "Delta", field: "callDelta", flex: 1, minWidth: 55, type: "numericColumn", cellClass: deltaClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "IV", field: "callIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call" },
      { headerName: "SVI", field: "callSviIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-panel-faint" },
      { headerName: "Heston", field: "callHestonIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-orange-400/60" },
      { headerName: "VG", field: "callVgIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-cyan-400/60" },
      { headerName: "Edge", field: "callIvDiff", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: ivDiffClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "Fair", field: "callFair", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: priceFormatter, cellClass: fairCellClass("callFair"), headerClass: "ag-header-center ag-header-call" },
      { headerName: "Call LTP", field: "callLtp", flex: 1, minWidth: 70, type: "numericColumn", valueFormatter: priceFormatter, cellClass: clickableCellClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "Strike", field: "strike", width: 80, cellClass: "font-bold text-yellow-300 text-center", headerClass: "ag-header-strike", type: "numericColumn", suppressSizeToFit: true },
      { headerName: "Put LTP", field: "putLtp", flex: 1, minWidth: 70, type: "numericColumn", valueFormatter: priceFormatter, cellClass: clickableCellClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "Fair", field: "putFair", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: priceFormatter, cellClass: fairCellClass("putFair"), headerClass: "ag-header-center ag-header-put" },
      { headerName: "Edge", field: "putIvDiff", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: ivDiffClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "VG", field: "putVgIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-cyan-400/60" },
      { headerName: "Heston", field: "putHestonIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-orange-400/60" },
      { headerName: "SVI", field: "putSviIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-panel-faint" },
      { headerName: "IV", field: "putIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put" },
      { headerName: "Delta", field: "putDelta", flex: 1, minWidth: 55, type: "numericColumn", cellClass: deltaClass, headerClass: "ag-header-center ag-header-put" },
    ],
    [priceFormatter, ivFormatter],
  );

  const columnDefs = useMemo(
    () => allColumnDefs.filter((col) => !col.field || !hiddenFields.has(col.field)),
    [allColumnDefs, hiddenFields],
  );

  const defaultColDef = useMemo<ColDef>(
    () => ({
      sortable: true,
      resizable: true,
      suppressMovable: true,
    }),
    [],
  );

  const getRowId = useCallback(
    (params: GetRowIdParams<OptionChainRow>) =>
      params.data?._isSpotDivider ? "__spot__" : String(params.data.strike),
    [],
  );

  const isFullWidthRow = useCallback(
    (params: { rowNode: { data?: OptionChainRow } }) => !!params.rowNode.data?._isSpotDivider,
    [],
  );

  const fullWidthCellRenderer = useCallback(
    (params: { data?: OptionChainRow }) => {
      const spot = params.data?._spotPrice ?? 0;
      const chg = params.data?._spotChange ?? 0;
      const pct = params.data?._spotPctChange ?? 0;
      if (spot <= 0) return null;
      const isUp = chg >= 0;
      return (
        <div className="spot-divider-row">
          <div className="spot-divider-line" />
          <div className="spot-divider-pill">
            <span>Spot {spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}</span>
            {chg !== 0 && (
              <span className={isUp ? "spot-change-up" : "spot-change-down"}>
                {" "}{isUp ? "+" : ""}{chg.toFixed(2)} ({isUp ? "+" : ""}{pct.toFixed(2)}%)
              </span>
            )}
          </div>
          <div className="spot-divider-line" />
        </div>
      );
    },
    [],
  );

  const syncRows = useCallback((api: GridApi<OptionChainRow>) => {
    const marketState = useMarketDataStore.getState();
    const chain = marketState.optionChain;
    if (!chain) {
      rowsByIdRef.current = new Map();
      rowOrderRef.current = [];
      strikeMapRef.current = new Map();
      symbolToStrikeRef.current = new Map();
      api.setGridOption("rowData", []);
      return;
    }

    const { rows, strikeMap, symbolToStrike, dividerIdx } = buildRowsForChain(
      chain,
      marketState.sviParams,
      marketState.spotStatic?.prevClose ?? 0,
      marketState.modelPrices,
      useGreeksStore.getState().greeks,
      marketState.ticks,
    );

    strikeMapRef.current = strikeMap;
    symbolToStrikeRef.current = symbolToStrike;

    const nextRowsById = new Map<string, OptionChainRow>();
    const nextRowOrder: string[] = [];
    for (const row of rows) {
      const id = rowIdFor(row);
      nextRowsById.set(id, row);
      nextRowOrder.push(id);
    }

    const nextChainKey = `${chain.underlying}:${chain.expiry}`;
    const chainChanged = nextChainKey !== chainKeyRef.current;
    const orderChanged =
      nextRowOrder.length !== rowOrderRef.current.length ||
      nextRowOrder.some((id, idx) => id !== rowOrderRef.current[idx]);

    if (rowsByIdRef.current.size === 0 || chainChanged || orderChanged) {
      // Initial load, underlying/expiry switch, or divider/row order changed.
      api.setGridOption("rowData", rows);
    } else {
      for (const row of rows) {
        const id = rowIdFor(row);
        if (!rowChanged(rowsByIdRef.current.get(id), row)) continue;
        const rowNode = api.getRowNode(id);
        if (!rowNode) {
          api.setGridOption("rowData", rows);
          break;
        }
        patchRowNode(rowNode, rowsByIdRef.current.get(id), row);
      }
    }

    rowsByIdRef.current = nextRowsById;
    rowOrderRef.current = nextRowOrder;

    chainKeyRef.current = nextChainKey;

    // Re-center on spot divider unless user manually scrolled
    if (chainChanged) {
      userScrolledRef.current = false;
    }
    if (!userScrolledRef.current && dividerIdx >= 0) {
      requestAnimationFrame(() => {
        if (api.getDisplayedRowCount() > dividerIdx) {
          // Suppress user-scroll detection for 300ms after programmatic scroll
          programmaticScrollUntilRef.current = Date.now() + 300;
          api.ensureIndexVisible(dividerIdx, "middle");
        }
      });
    }
  }, []);

  const scheduleSyncRows = useCallback((api: GridApi<OptionChainRow>, delayMs = 48) => {
    if (pendingSyncRef.current !== null) {
      window.clearTimeout(pendingSyncRef.current);
    }

    function attemptSync() {
      pendingSyncRef.current = null;
      const remainingScrollMs = scrollingUntilRef.current - Date.now();
      if (remainingScrollMs > 0) {
        pendingSyncRef.current = window.setTimeout(attemptSync, remainingScrollMs + 16);
        return;
      }
      syncRows(api);
    }

    pendingSyncRef.current = window.setTimeout(attemptSync, delayMs);
  }, [syncRows]);

  const updateStrikeRow = useCallback((api: GridApi<OptionChainRow>, strike: number) => {
    const strikeEntry = strikeMapRef.current.get(strike);
    const chain = useMarketDataStore.getState().optionChain;
    if (!strikeEntry || !chain) return;

    const marketState = useMarketDataStore.getState();
    const expiryClose = new Date(chain.expiry + "T10:00:00Z").getTime();
    const expiryMs = expiryClose - Date.now();
    const t = Math.max(expiryMs / (365.25 * 86400_000), 1e-6);
    const row = strikeToRow(
      strikeEntry,
      marketState.sviParams,
      chain.underlyingPrice,
      t,
      useGreeksStore.getState().greeks,
      buildModelIvMap(marketState.modelPrices),
      marketState.ticks,
    );
    const rowId = String(strike);
    const rowNode = api.getRowNode(rowId);

    // Live Greeks/ticks can arrive before the current chain rows are mounted,
    // or immediately around a chain switch. In that case, don't send AG Grid
    // an invalid update transaction for a row id it doesn't currently have.
    if (!rowNode) {
      if (rowsByIdRef.current.has(rowId)) {
        syncRows(api);
      }
      return;
    }

    const prevRow = rowsByIdRef.current.get(rowId);
    rowsByIdRef.current.set(rowId, row);
    patchRowNode(rowNode, prevRow, row);
  }, [syncRows]);

  const flushStrikeUpdates = useCallback((api: GridApi<OptionChainRow>) => {
    pendingStrikeFlushRef.current = null;

    const strikes = [...pendingStrikeUpdatesRef.current];
    pendingStrikeUpdatesRef.current.clear();

    for (const strike of strikes) {
      updateStrikeRow(api, strike);
    }
  }, [updateStrikeRow]);

  const queueStrikeUpdate = useCallback((api: GridApi<OptionChainRow>, strike: number) => {
    pendingStrikeUpdatesRef.current.add(strike);
    if (pendingStrikeFlushRef.current !== null) return;

    pendingStrikeFlushRef.current = window.setTimeout(() => {
      flushStrikeUpdates(api);
    }, 24);
  }, [flushStrikeUpdates]);

  const updateSpotRow = useCallback((api: GridApi<OptionChainRow>) => {
    const chain = useMarketDataStore.getState().optionChain;
    if (!chain) return;

    const spotRow = buildSpotDivider(
      chain.underlyingPrice,
      useMarketDataStore.getState().spotStatic?.prevClose ?? 0,
    );
    const rowNode = api.getRowNode("__spot__");

    if (!spotRow) {
      if (rowNode || rowsByIdRef.current.has("__spot__")) {
        syncRows(api);
      }
      return;
    }

    if (!rowNode) {
      if (rowsByIdRef.current.has("__spot__")) {
        syncRows(api);
      }
      return;
    }

    rowsByIdRef.current.set("__spot__", spotRow);
    rowNode.setData(spotRow);
  }, [syncRows]);

  const onGridReady = useCallback((event: GridReadyEvent<OptionChainRow>) => {
    apiRef.current = event.api;
    syncRows(event.api);
  }, [syncRows]);

  useEffect(() => {
    const unsubMarket = useMarketDataStore.subscribe((state, prevState) => {
      if (!apiRef.current) return;

      const nextChain = state.optionChain;
      const prevChain = prevState.optionChain;
      const nextChainKey = nextChain ? `${nextChain.underlying}:${nextChain.expiry}` : "";
      const prevChainKey = prevChain ? `${prevChain.underlying}:${prevChain.expiry}` : "";
      const chainKeyChanged = nextChainKey !== prevChainKey;

      if (chainKeyChanged) {
        userScrolledRef.current = false;
        scheduleSyncRows(apiRef.current, 0);
        return;
      }

      if (
        state.modelPrices !== prevState.modelPrices ||
        state.sviParams !== prevState.sviParams
      ) {
        scheduleSyncRows(apiRef.current, 180);
        return;
      }

      if (state.optionChain !== prevState.optionChain && nextChain) {
        const prevStrikeMap = strikeMapRef.current;
        const prevDividerIndex = rowOrderRef.current.indexOf("__spot__");
        const { strikeMap, symbolToStrike } = buildChainIndexes(nextChain);
        const structureChanged = !hasSameStrikeStructure(nextChain, prevStrikeMap);
        const nextDividerIndex = computeDividerIndex(nextChain.strikes, nextChain.underlyingPrice);

        strikeMapRef.current = strikeMap;
        symbolToStrikeRef.current = symbolToStrike;

        if (rowsByIdRef.current.size === 0 || structureChanged || nextDividerIndex !== prevDividerIndex) {
          // Spot crossed a strike boundary — reset scroll so grid re-centers
          if (nextDividerIndex !== prevDividerIndex) {
            userScrolledRef.current = false;
          }
          scheduleSyncRows(apiRef.current);
        } else {
          updateSpotRow(apiRef.current);
        }
        return;
      }

      if (state.spotStatic !== prevState.spotStatic) {
        updateSpotRow(apiRef.current);
        return;
      }

      if (state.tickVersion !== prevState.tickVersion && state.lastTickSymbol) {
        const strike = symbolToStrikeRef.current.get(state.lastTickSymbol);
        if (strike !== undefined) {
          queueStrikeUpdate(apiRef.current, strike);
        }
      }
    });

    const unsubGreeks = useGreeksStore.subscribe((state, prevState) => {
      if (!apiRef.current) return;
      if (state.greeksVersion === prevState.greeksVersion) return;

      for (const symbol of state.lastUpdatedSymbols) {
        const strike = symbolToStrikeRef.current.get(symbol);
        if (strike !== undefined) {
          queueStrikeUpdate(apiRef.current, strike);
        }
      }
    });

    return () => {
      if (pendingSyncRef.current !== null) {
        window.clearTimeout(pendingSyncRef.current);
      }
      if (pendingStrikeFlushRef.current !== null) {
        window.clearTimeout(pendingStrikeFlushRef.current);
      }
      unsubMarket();
      unsubGreeks();
    };
  }, [queueStrikeUpdate, scheduleSyncRows, updateSpotRow]);

  // Refresh cells when activeLegSet changes so cellClass re-evaluates
  useEffect(() => {
    if (apiRef.current) {
      apiRef.current.refreshCells({ force: true });
    }
  }, [activeLegSet]);

  const context = useMemo(
    () => ({ activeLegSet }),
    [activeLegSet],
  );

  const rowClassRules = useMemo(
    () => ({
      "row-itm-call": (params: { data?: OptionChainRow }) => {
        if (params.data?._isSpotDivider) return false;
        return !!params.data?._isCallItm;
      },
      "row-has-leg": (params: { data?: OptionChainRow; context?: { activeLegSet?: Set<string> } }) => {
        const set = params.context?.activeLegSet;
        const strike = params.data?.strike;
        if (!set || set.size === 0 || strike === undefined || params.data?._isSpotDivider) return false;
        return (
          set.has(`${strike}-CE-BUY`) ||
          set.has(`${strike}-CE-SELL`) ||
          set.has(`${strike}-PE-BUY`) ||
          set.has(`${strike}-PE-SELL`)
        );
      },
    }),
    [],
  );

  return (
    <div className="flex h-full w-full flex-col">
      {/* Column toggle bar */}
      <div className="flex shrink-0 items-center gap-1 border-b border-panel-border bg-panel-header px-2 py-1">
        <span className="mr-1 text-[10px] uppercase tracking-wider text-panel-dim">Cols</span>
        {COLUMN_TOGGLES.map((t) => (
          <button
            key={t.key}
            onClick={() => toggleColumn(t.key)}
            className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
              visibleColumns.has(t.key)
                ? "bg-blue-500/20 text-blue-400"
                : "text-panel-dim hover:text-panel-subtle"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div className="ag-theme-alpine-dark min-h-0 flex-1">
      <AgGridReact<OptionChainRow>
        ref={gridRef}
        theme="legacy"
        rowData={[]}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={getRowId}
        onGridReady={onGridReady}
        onCellClicked={onCellClicked}
        context={context}
        rowClassRules={rowClassRules}
        isFullWidthRow={isFullWidthRow}
        fullWidthCellRenderer={fullWidthCellRenderer}
        animateRows={false}
        asyncTransactionWaitMillis={50}
        suppressScrollOnNewData
        suppressCellFocus
        headerHeight={32}
        rowHeight={28}
        onBodyScroll={() => {
          scrollingUntilRef.current = Date.now() + 150;
          // Ignore scroll events caused by programmatic ensureIndexVisible
          if (Date.now() < programmaticScrollUntilRef.current) return;
          // User manually scrolled — stop auto-centering until next chain change
          userScrolledRef.current = true;
        }}
      />
      </div>
    </div>
  );
});
