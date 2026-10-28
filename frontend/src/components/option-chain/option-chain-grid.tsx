"use client";

import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { AgGridReact } from "ag-grid-react";
import type {
  ColDef,
  CellClassParams,
  GetRowIdParams,
  GridReadyEvent,
  GridApi,
} from "ag-grid-community";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-alpine.css";
import "@/lib/ag-grid-setup";

import { useGreeksStore } from "@/stores/greeks-store";
import { useBasketStore } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type {
  GreeksResult,
  ModelPricesResult,
  OptionChainSnapshot,
  OptionStrike,
  OptionType,
  Side,
  SviParams,
  TickData,
} from "@/types/market-data";
import { modelPrice } from "@/lib/black-scholes";
import type { OptionModel } from "@/lib/black-scholes";
import { pricingModelOf, timeToExpiryYears, underlyingPriceLabel } from "@/lib/instruments";


const RISK_FREE_RATE = 0.065;

/** Stable empty array — avoids AG Grid re-processing rowData on every render. */
const EMPTY_ROW_DATA: OptionChainRow[] = [];

export interface OptionChainRow {
  strike: number;
  callLtp: number | null;
  callFair: number | null;
  callIv: number | null;
  callSviIv: number | null;
  callHestonIv: number | null;
  callVgIv: number | null;
  callHestonEdge: number | null;   // hestonIv - marketIv (positive = cheap, buy signal)
  callVgEdge: number | null;       // vgIv - marketIv
  callIvDiff: number | null;
  callDelta: number | null;
  callGamma: number | null;
  putDelta: number | null;
  putGamma: number | null;
  putIvDiff: number | null;
  putSviIv: number | null;
  putHestonIv: number | null;
  putVgIv: number | null;
  putHestonEdge: number | null;
  putVgEdge: number | null;
  putIv: number | null;
  putFair: number | null;
  putLtp: number | null;
  /** Position qty on this strike (negative = short) */
  callPosQty?: number;
  putPosQty?: number;
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
  "callHestonEdge",
  "callVgEdge",
  "callIvDiff",
  "callDelta",
  "callGamma",
  "putDelta",
  "putGamma",
  "putIvDiff",
  "putSviIv",
  "putHestonIv",
  "putVgIv",
  "putVgEdge",
  "putHestonEdge",
  "putIv",
  "putFair",
  "putLtp",
  "callPosQty",
  "putPosQty",
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
  modelMeta: { hestonCalibrated: boolean; vgCalibrated: boolean } | null,
  // BSM on spot for index options; Black-76 on the future for MCX
  model: OptionModel = "bsm",
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

  // Fair value from SVI IV + BSM (index) / Black-76 (futures) pricing
  const callFair = callSviIv !== null && spot > 0 && t > 0
    ? modelPrice(model, spot, s.strike, t, RISK_FREE_RATE, callSviIv / 100, "CE")
    : null;
  const putFair = putSviIv !== null && spot > 0 && t > 0
    ? modelPrice(model, spot, s.strike, t, RISK_FREE_RATE, putSviIv / 100, "PE")
    : null;

  // Model IVs from Heston/VG FFT pricing
  const modelIvs = modelIvMap.get(s.strike);
  const hestonIvPct = modelIvs?.hestonIv != null ? modelIvs.hestonIv * 100 : null;
  const vgIvPct = modelIvs?.vgIv != null ? modelIvs.vgIv * 100 : null;

  const callHestonEdge = modelMeta?.hestonCalibrated && hestonIvPct !== null && callMarketIv !== null
    ? hestonIvPct - callMarketIv : null;
  const callVgEdge = modelMeta?.vgCalibrated && vgIvPct !== null && callMarketIv !== null
    ? vgIvPct - callMarketIv : null;
  const putHestonEdge = modelMeta?.hestonCalibrated && hestonIvPct !== null && putMarketIv !== null
    ? hestonIvPct - putMarketIv : null;
  const putVgEdge = modelMeta?.vgCalibrated && vgIvPct !== null && putMarketIv !== null
    ? vgIvPct - putMarketIv : null;

  return {
    strike: s.strike,
    callLtp: callTick?.ltp ?? null,
    callFair,
    callIv: callMarketIv ?? callSviIv,
    callSviIv,
    callHestonIv: hestonIvPct,
    callVgIv: vgIvPct,
    callHestonEdge,
    callVgEdge,
    callIvDiff,
    callDelta: callGreeks?.delta ?? null,
    callGamma: callGreeks?.gamma ?? null,
    putDelta: putGreeks?.delta ?? null,
    putGamma: putGreeks?.gamma ?? null,
    putIvDiff,
    putSviIv,
    putHestonIv: hestonIvPct,
    putVgIv: vgIvPct,
    putHestonEdge,
    putVgEdge,
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
    callHestonEdge: null,
    callVgEdge: null,
    callIvDiff: null,
    callDelta: null,
    callGamma: null,
    putDelta: null,
    putGamma: null,
    putIvDiff: null,
    putSviIv: null,
    putHestonIv: null,
    putVgIv: null,
    putHestonEdge: null,
    putVgEdge: null,
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

/**
 * Estimate spot from put-call parity when the index feed gives no underlying
 * price (e.g. a missing/degraded index spot tick). Near the forward,
 * call.ltp ≈ put.ltp, so the dual-quoted strike that minimises |C − P| sits
 * closest to ATM and approximates spot well enough to anchor the chain view.
 * Returns -1 when no strike has both a call and a put quote.
 */
function estimateSpotFromParity(strikes: OptionStrike[]): number {
  let bestStrike = -1;
  let bestDiff = Infinity;
  for (const entry of strikes) {
    const call = entry.call?.ltp;
    const put = entry.put?.ltp;
    if (call == null || put == null || call <= 0 || put <= 0) continue;
    const diff = Math.abs(call - put);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestStrike = entry.strike;
    }
  }
  return bestStrike;
}

function computeDividerIndex(
  strikes: OptionStrike[],
  spot: number,
): number {
  // Fall back to a parity-implied ATM when the feed has no spot, so the chain
  // still centres on the tradeable strikes instead of the lowest strike.
  const ref = spot > 0 ? spot : estimateSpotFromParity(strikes);
  if (ref <= 0) return -1;
  for (let idx = 0; idx < strikes.length; idx += 1) {
    if (strikes[idx].strike > ref) return idx;
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
  posMap?: Map<string, number>,
): { rows: OptionChainRow[]; strikeMap: Map<number, OptionStrike>; symbolToStrike: Map<string, number>; dividerIdx: number } {
  const spot = chain.underlyingPrice;
  // 15:30 IST for NSE/BSE, MCX evening close for commodities
  const t = timeToExpiryYears(chain.underlying, chain.expiry);
  const model = pricingModelOf(chain.underlying);
  const modelIvMap = buildModelIvMap(modelPrices);
  const modelMeta = modelPrices ? { hestonCalibrated: modelPrices.hestonCalibrated, vgCalibrated: modelPrices.vgCalibrated } : null;
  const strikeMap = new Map<number, OptionStrike>();
  const symbolToStrike = new Map<string, number>();
  const dataRows = chain.strikes.map((strikeEntry) => {
    strikeMap.set(strikeEntry.strike, strikeEntry);
    if (strikeEntry.call) symbolToStrike.set(strikeEntry.call.symbol, strikeEntry.strike);
    if (strikeEntry.put) symbolToStrike.set(strikeEntry.put.symbol, strikeEntry.strike);
    return strikeToRow(strikeEntry, svi, spot, t, greeksMap, modelIvMap, liveTicks, modelMeta, model);
  });

  if (posMap && posMap.size > 0) {
    for (const row of dataRows) {
      const cq = posMap.get(`${row.strike}-CE`);
      const pq = posMap.get(`${row.strike}-PE`);
      if (cq) row.callPosQty = cq;
      if (pq) row.putPosQty = pq;
    }
  }

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

/** Model edge: positive = cheap (green/buy), negative = expensive (red/sell) */
const modelEdgeClass = (params: CellClassParams<OptionChainRow>): string => {
  const value = params.value as number | null;
  if (value === null || value === undefined) return "";
  if (value > 2) return "text-green-400 font-semibold";
  if (value > 0.5) return "text-green-400/70";
  if (value < -2) return "text-red-400 font-semibold";
  if (value < -0.5) return "text-red-400/70";
  return "text-[#808090]";
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

const gammaClass = (params: CellClassParams<OptionChainRow>): string => {
  const value = params.value as number | null;
  if (value === null || value === undefined) return "";
  if (value > 0) return "text-green-400";
  if (value < 0) return "text-red-400";
  return "";
};

const CALL_SIDE_FIELDS = [
  "callDelta",
  "callGamma",
  "callIv",
  "callSviIv",
  "callHestonIv",
  "callVgIv",
  "callHestonEdge",
  "callVgEdge",
  "callIvDiff",
  "callFair",
  "callLtp",
] as const;

const PUT_SIDE_FIELDS = [
  "putLtp",
  "putFair",
  "putIvDiff",
  "putVgEdge",
  "putHestonEdge",
  "putVgIv",
  "putHestonIv",
  "putSviIv",
  "putIv",
  "putDelta",
  "putGamma",
] as const;

function addLegFromOptionCell(
  strike: number,
  optionType: OptionType,
  side: Side,
  premium: number,
): void {
  const { selectedUnderlying, selectedExpiry } = useMarketDataStore.getState();
  if (!selectedUnderlying || !selectedExpiry) return;

  useBasketStore.getState().addLegFromChain({
    strike,
    optionType,
    side,
    premium,
    underlying: selectedUnderlying,
    expiry: selectedExpiry,
  });
}

function StrikeCellRenderer(params: { value: unknown; data?: OptionChainRow }) {
  if (params.data?._isSpotDivider) return null;
  const strike = params.value as number;
  const cq = params.data?.callPosQty;
  const pq = params.data?.putPosQty;
  return (
    <div className="relative flex items-center justify-center">
      {cq ? (
        <span className={`absolute left-0 text-[9px] font-semibold ${cq > 0 ? "text-green-400" : "text-red-400"}`}>
          {cq > 0 ? `+${cq}` : cq}
        </span>
      ) : null}
      <span>{strike}</span>
      {pq ? (
        <span className={`absolute right-0 text-[9px] font-semibold ${pq > 0 ? "text-green-400" : "text-red-400"}`}>
          {pq > 0 ? `+${pq}` : pq}
        </span>
      ) : null}
    </div>
  );
}

function OptionActionCellRenderer(params: {
  value: unknown;
  valueFormatted?: string | null;
  data?: OptionChainRow;
  colDef: { field?: string | null };
  context?: { activeLegSet?: Set<string> };
}) {
  const field = params.colDef.field;
  const value = params.value;

  if (!field || !params.data) {
    return params.valueFormatted ?? (value != null ? String(value) : "");
  }

  const strike = params.data?.strike;
  const optionType: OptionType = field.startsWith("call") ? "CE" : "PE";
  const premium = optionType === "CE" ? params.data.callLtp : params.data.putLtp;
  const activeLegSet = params.context?.activeLegSet;
  const buyActive = strike !== undefined && !!activeLegSet?.has(`${strike}-${optionType}-BUY`);
  const sellActive = strike !== undefined && !!activeLegSet?.has(`${strike}-${optionType}-SELL`);
  const displayValue = params.valueFormatted ?? (value != null ? String(value) : "");

  const handleAdd = (event: React.MouseEvent<HTMLButtonElement>, side: Side) => {
    event.preventDefault();
    event.stopPropagation();
    if (strike === undefined || premium == null) return;
    addLegFromOptionCell(strike, optionType, side, premium);
  };

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden px-1">
      <span className="option-action-value tabular-nums transition-opacity duration-150">
        {displayValue}
      </span>
      <div className="option-action-buttons pointer-events-none absolute inset-y-0 left-1 flex items-center gap-1 opacity-0 transition-opacity duration-150">
        <button
          type="button"
          title="Add buy leg"
          onClick={(event) => handleAdd(event, "BUY")}
          disabled={premium == null}
          className={`pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold text-white shadow-sm transition-colors ${
            buyActive ? "bg-emerald-400 text-[#052e16]" : "bg-emerald-500/95 hover:bg-emerald-400"
          }`}
        >
          B
        </button>
        <button
          type="button"
          title="Add sell leg"
          onClick={(event) => handleAdd(event, "SELL")}
          disabled={premium == null}
          className={`pointer-events-auto flex h-6 w-6 items-center justify-center rounded-md text-[10px] font-bold text-white shadow-sm transition-colors ${
            sellActive ? "bg-rose-400 text-[#3f0d12]" : "bg-rose-500/95 hover:bg-rose-400"
          }`}
        >
          S
        </button>
      </div>
    </div>
  );
}

function optionActionCellClass(
  params: CellClassParams<OptionChainRow>,
): string[] {
  const classes: string[] = [];
  const field = params.colDef.field;
  if (!field || params.data?._isSpotDivider) return classes;
  if (!field.startsWith("call") && !field.startsWith("put")) return classes;

  const optionType: OptionType = field.startsWith("call") ? "CE" : "PE";
  const premium = optionType === "CE" ? params.data?.callLtp : params.data?.putLtp;
  if (premium == null) return classes;

  classes.push("option-action-cell");

  const activeLegSet = params.context?.activeLegSet as Set<string> | undefined;
  if (!activeLegSet || activeLegSet.size === 0) return classes;

  const strike = params.data?.strike;
  if (strike === undefined) return classes;

  if (activeLegSet.has(`${strike}-${optionType}-BUY`)) classes.push("cell-leg-buy");
  else if (activeLegSet.has(`${strike}-${optionType}-SELL`)) classes.push("cell-leg-sell");

  return classes;
}

// Toggleable column groups — each key controls a call+put column pair
const COLUMN_TOGGLES = [
  { key: "delta", label: "Delta" },
  { key: "gamma", label: "Gamma" },
  { key: "iv", label: "IV" },
  { key: "svi", label: "SVI" },
  { key: "heston", label: "Heston" },
  { key: "vg", label: "VG" },
  { key: "hestonEdge", label: "H-Edge" },
  { key: "vgEdge", label: "V-Edge" },
  { key: "edge", label: "Edge" },
  { key: "fair", label: "Fair" },
] as const;

export type ColumnToggleKey = typeof COLUMN_TOGGLES[number]["key"];

const COLUMN_KEY_TO_FIELDS: Record<ColumnToggleKey, string[]> = {
  delta: ["callDelta", "putDelta"],
  gamma: ["callGamma", "putGamma"],
  iv: ["callIv", "putIv"],
  svi: ["callSviIv", "putSviIv"],
  heston: ["callHestonIv", "putHestonIv"],
  vg: ["callVgIv", "putVgIv"],
  hestonEdge: ["callHestonEdge", "putHestonEdge"],
  vgEdge: ["callVgEdge", "putVgEdge"],
  edge: ["callIvDiff", "putIvDiff"],
  fair: ["callFair", "putFair"],
};

const STORAGE_KEY = "oc-visible-columns";

export function loadVisibleColumns(): Set<ColumnToggleKey> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      const next = new Set(arr.filter((k) => COLUMN_TOGGLES.some((t) => t.key === k)) as ColumnToggleKey[]);
      // Schema upgrade: gamma is part of the default Greek view alongside delta.
      if (next.has("delta")) next.add("gamma");
      return next;
    }
  } catch {}
  // Default: LTP, Strike always shown; Delta + Gamma + IV visible
  return new Set<ColumnToggleKey>(["delta", "gamma", "iv"]);
}

export function saveVisibleColumns(cols: Set<ColumnToggleKey>) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify([...cols]));
}

interface OptionChainGridProps {
  activeLegSet?: Set<string>;
  visibleColumns: Set<ColumnToggleKey>;
}

interface OptionChainColumnTogglesProps {
  visibleColumns: Set<ColumnToggleKey>;
  onToggleColumn: (key: ColumnToggleKey) => void;
}

export function OptionChainColumnToggles({
  visibleColumns,
  onToggleColumn,
}: OptionChainColumnTogglesProps) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-1 text-[10px] uppercase tracking-[0.2em] text-[#7f8aa9]">Cols</span>
      {COLUMN_TOGGLES.map((toggle) => (
        <button
          key={toggle.key}
          onClick={() => onToggleColumn(toggle.key)}
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            visibleColumns.has(toggle.key)
              ? "bg-blue-500/20 text-blue-300"
              : "text-[#8f96af] hover:text-[#d5dbef]"
          }`}
        >
          {toggle.label}
        </button>
      ))}
    </div>
  );
}

export const OptionChainGrid = memo(function OptionChainGrid({
  activeLegSet,
  visibleColumns,
}: OptionChainGridProps) {
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
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const viewportElRef = useRef<HTMLElement | null>(null);
  const lastUserScrollTopRef = useRef(0);

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

  const gammaFormatter = useCallback(
    (p: { value: unknown }) =>
      p.value != null ? (p.value as number).toFixed(4) : "",
    [],
  );

  const deltaFormatter = useCallback(
    (p: { value: unknown }) =>
      p.value != null ? (p.value as number).toFixed(2) : "",
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

  const actionAnchorFields = useMemo(() => {
    const callField = CALL_SIDE_FIELDS.find((field) => !hiddenFields.has(field)) ?? "callLtp";
    const putField = PUT_SIDE_FIELDS.find((field) => !hiddenFields.has(field)) ?? "putLtp";
    return new Set<string>([callField, putField]);
  }, [hiddenFields]);

  const withActionAnchor = useCallback((col: ColDef<OptionChainRow>): ColDef<OptionChainRow> => {
    if (!col.field || !actionAnchorFields.has(col.field)) return col;
    return {
      ...col,
      cellRenderer: OptionActionCellRenderer,
      cellClass: optionActionCellClass,
    };
  }, [actionAnchorFields]);

  const allColumnDefs = useMemo<ColDef<OptionChainRow>[]>(
    () => [
      { headerName: "Delta", field: "callDelta", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: deltaFormatter, cellClass: deltaClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "Gamma", field: "callGamma", flex: 1, minWidth: 60, type: "numericColumn", valueFormatter: gammaFormatter, cellClass: gammaClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "IV", field: "callIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call" },
      { headerName: "SVI", field: "callSviIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-panel-faint" },
      { headerName: "Heston", field: "callHestonIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-amber-400/60" },
      { headerName: "VG", field: "callVgIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-call", cellClass: "text-pink-400/60" },
      { headerName: "H-Edge", field: "callHestonEdge", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: modelEdgeClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "V-Edge", field: "callVgEdge", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: modelEdgeClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "Edge", field: "callIvDiff", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: ivDiffClass, headerClass: "ag-header-center ag-header-call" },
      { headerName: "Fair", field: "callFair", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: priceFormatter, cellClass: fairCellClass("callFair"), headerClass: "ag-header-center ag-header-call" },
      { headerName: "Call LTP", field: "callLtp", flex: 1, minWidth: 70, type: "numericColumn", valueFormatter: priceFormatter, headerClass: "ag-header-center ag-header-call" },
      {
        headerName: "Strike", field: "strike", width: 130, minWidth: 130,
        cellClass: "font-bold text-yellow-300 text-center",
        headerClass: "ag-header-strike", type: "numericColumn", suppressSizeToFit: true,
        cellRenderer: StrikeCellRenderer,
      },
      { headerName: "Put LTP", field: "putLtp", flex: 1, minWidth: 70, type: "numericColumn", valueFormatter: priceFormatter, headerClass: "ag-header-center ag-header-put" },
      { headerName: "Fair", field: "putFair", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: priceFormatter, cellClass: fairCellClass("putFair"), headerClass: "ag-header-center ag-header-put" },
      { headerName: "Edge", field: "putIvDiff", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: ivDiffClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "V-Edge", field: "putVgEdge", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: modelEdgeClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "H-Edge", field: "putHestonEdge", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: ivDiffFormatter, cellClass: modelEdgeClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "VG", field: "putVgIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-pink-400/60" },
      { headerName: "Heston", field: "putHestonIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-amber-400/60" },
      { headerName: "SVI", field: "putSviIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put", cellClass: "text-panel-faint" },
      { headerName: "IV", field: "putIv", flex: 1, minWidth: 50, type: "numericColumn", valueFormatter: ivFormatter, headerClass: "ag-header-center ag-header-put" },
      { headerName: "Gamma", field: "putGamma", flex: 1, minWidth: 60, type: "numericColumn", valueFormatter: gammaFormatter, cellClass: gammaClass, headerClass: "ag-header-center ag-header-put" },
      { headerName: "Delta", field: "putDelta", flex: 1, minWidth: 55, type: "numericColumn", valueFormatter: deltaFormatter, cellClass: deltaClass, headerClass: "ag-header-center ag-header-put" },
    ],
    [priceFormatter, ivFormatter, gammaFormatter, deltaFormatter],
  );

  const columnDefs = useMemo(
    () => allColumnDefs.filter((col) => !col.field || !hiddenFields.has(col.field)).map(withActionAnchor),
    [allColumnDefs, hiddenFields, withActionAnchor],
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
            <span>
              {underlyingPriceLabel(useMarketDataStore.getState().optionChain?.underlying)}{" "}
              {spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
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

    // Build position map: "strike-CE" / "strike-PE" → net qty for matching underlying+expiry
    // Position symbol format: "NIFTY 260319 22000 CE" — chain.expiry is "2026-03-19"
    const chainExpiryCompact = chain.expiry.replace(/-/g, "").slice(2); // "2026-03-19" → "260319"
    const posMap = new Map<string, number>();
    const positions = usePositionStore.getState().positions;
    for (const pos of positions) {
      if (!pos.isOpen) continue;
      const parts = pos.symbol.split(" ");
      // parts: ["NIFTY", "260319", "22000", "CE"]
      if (parts.length < 4) continue;
      if (parts[0] !== chain.underlying) continue;
      if (parts[1] !== chainExpiryCompact) continue;
      const strike = parseFloat(parts[2]);
      const ot = parts[3] === "CE" ? "CE" : "PE";
      if (isNaN(strike)) continue;
      posMap.set(`${strike}-${ot}`, (posMap.get(`${strike}-${ot}`) || 0) + pos.quantity);
    }

    const { rows, strikeMap, symbolToStrike, dividerIdx } = buildRowsForChain(
      chain,
      marketState.sviParams,
      marketState.spotStatic?.prevClose ?? 0,
      marketState.modelPrices,
      useGreeksStore.getState().greeks,
      marketState.ticks,
      posMap,
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

    // Determine if we should auto-center on the spot divider after update
    const willAutoCenter = (chainChanged || !userScrolledRef.current) && dividerIdx >= 0;

    // Helper: set row data while preserving scroll position
    const setDataKeepScroll = (newRows: OptionChainRow[]) => {
      if (willAutoCenter) {
        api.setGridOption("rowData", newRows);
        return;
      }
      if (!viewportElRef.current) {
        viewportElRef.current = gridContainerRef.current?.querySelector('.ag-body-viewport') as HTMLElement | null;
      }
      const vp = viewportElRef.current;
      const scrollTop = vp?.scrollTop ?? lastUserScrollTopRef.current;
      api.setGridOption("rowData", newRows);
      if (vp && scrollTop > 0) {
        programmaticScrollUntilRef.current = Date.now() + 300;
        vp.scrollTop = scrollTop;
        requestAnimationFrame(() => {
          vp.scrollTop = scrollTop;
          requestAnimationFrame(() => { vp.scrollTop = scrollTop; });
        });
      }
    };

    if (rowsByIdRef.current.size === 0 || chainChanged || orderChanged) {
      setDataKeepScroll(rows);
    } else {
      for (const row of rows) {
        const id = rowIdFor(row);
        if (!rowChanged(rowsByIdRef.current.get(id), row)) continue;
        const rowNode = api.getRowNode(id);
        if (!rowNode) {
          setDataKeepScroll(rows);
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
          programmaticScrollUntilRef.current = Date.now() + 300;
          api.ensureIndexVisible(dividerIdx, "middle");
        }
      });
    }
  }, []);

  const scheduleSyncRows = useCallback((api: GridApi<OptionChainRow>, delayMs = 16) => {
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
    const t = timeToExpiryYears(chain.underlying, chain.expiry);
    const row = strikeToRow(
      strikeEntry,
      marketState.sviParams,
      chain.underlyingPrice,
      t,
      useGreeksStore.getState().greeks,
      buildModelIvMap(marketState.modelPrices),
      marketState.ticks,
      marketState.modelPrices ? { hestonCalibrated: marketState.modelPrices.hestonCalibrated, vgCalibrated: marketState.modelPrices.vgCalibrated } : null,
      pricingModelOf(chain.underlying),
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
    }, 8);
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
    viewportElRef.current = gridContainerRef.current?.querySelector('.ag-body-viewport') as HTMLElement | null;
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
        scheduleSyncRows(apiRef.current, 80);
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

    // Re-sync when positions change so position highlights update
    const unsubPositions = usePositionStore.subscribe((state, prevState) => {
      if (!apiRef.current) return;
      if (state.positions !== prevState.positions) {
        scheduleSyncRows(apiRef.current, 100);
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
      unsubPositions();
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
      "row-has-position": (params: { data?: OptionChainRow }) => {
        if (params.data?._isSpotDivider) return false;
        return !!(params.data?.callPosQty || params.data?.putPosQty);
      },
    }),
    [],
  );

  const handleBodyScroll = useCallback(() => {
    scrollingUntilRef.current = Date.now() + 150;
    if (Date.now() < programmaticScrollUntilRef.current) return;
    userScrolledRef.current = true;
    const vp = viewportElRef.current;
    if (vp) lastUserScrollTopRef.current = vp.scrollTop;
  }, []);

  return (
    <div className="flex h-full w-full flex-col">
      <div ref={gridContainerRef} className="option-chain-grid ag-theme-alpine-dark min-h-0 flex-1">
      <AgGridReact<OptionChainRow>
        ref={gridRef}
        theme="legacy"
        rowData={EMPTY_ROW_DATA}
        columnDefs={columnDefs}
        defaultColDef={defaultColDef}
        getRowId={getRowId}
        onGridReady={onGridReady}
        context={context}
        rowClassRules={rowClassRules}
        isFullWidthRow={isFullWidthRow}
        fullWidthCellRenderer={fullWidthCellRenderer}
        animateRows={false}
        asyncTransactionWaitMillis={16}
        suppressScrollOnNewData
        suppressCellFocus
        headerHeight={32}
        rowHeight={28}
        onBodyScroll={handleBodyScroll}
      />
      </div>
    </div>
  );
});
