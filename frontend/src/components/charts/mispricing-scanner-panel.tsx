"use client";

import { useMemo, useState } from "react";
import { CircleHelp } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { useBasketStore } from "@/stores/basket-store";
import type { OptionType, Side } from "@/types/market-data";

interface MispricingRow {
  strike: number;
  optionType: "CE" | "PE";
  symbol: string;
  marketIv: number;
  hestonIv: number | null;
  vgIv: number | null;
  hestonEdge: number | null;
  vgEdge: number | null;
  consensusEdge: number;
  delta: number | null;
  ltp: number | null;
  bid: number | null;
  ask: number | null;
  oi: number | null;
  volume: number | null;
  moneyness: number;  // strike / spot
  action: "BUY" | "SELL";
  avgPop: number | null;
  confidence: "High" | "Med" | "Low";
  confidenceWeight: number;
  spreadPct: number | null;  // bid-ask spread as % of mid
  edgeVsSpread: number | null;  // |edge| / spread — >1 means edge exceeds spread cost
}

/** Default practical filters */
const DEFAULT_FILTERS = {
  minMarketIv: 5,        // % — skip strikes with no real IV
  moneynessBand: 8,      // % — only ±8% from spot (practical trading range)
  minAbsDelta: 0.05,     // skip deep OTM (delta ≈ 0)
  maxAbsDelta: 0.80,     // skip deep ITM (nobody trades delta > 0.80)
  minLtp: 1,             // ₹ — must have a real quote
  minOi: 0,              // open interest filter (0 = off)
  minEdgeVsSpread: 0.5,  // edge must be at least 50% of spread
  otmOnly: true,         // only show OTM strikes (the practical ones)
};

type MispricingFilters = typeof DEFAULT_FILTERS;

const STORAGE_KEY = "td-desk:mispricing-filters";

const EDGE_VS_SPREAD_TOOLTIP =
  "Edge / Bid-Ask Spread. This is |consensus edge| divided by the current bid-ask spread. Above 1x means the modeled mispricing is larger than the quoted transaction cost.";

function TooltipHint({ text }: { text: string }) {
  return (
    <span className="group relative inline-flex">
      <span
        tabIndex={0}
        aria-label={text}
        className="inline-flex cursor-help text-panel-subtle/80 outline-none hover:text-panel-subtle focus:text-panel-subtle"
      >
        <CircleHelp className="h-3 w-3" />
      </span>
      <span className="pointer-events-none absolute left-1/2 top-full z-50 mt-1 hidden w-64 -translate-x-1/2 rounded-md border border-panel-border bg-panel-header px-2 py-1.5 text-[10px] normal-case leading-relaxed text-panel-muted shadow-lg group-hover:block group-focus-within:block">
        {text}
      </span>
    </span>
  );
}

function loadFilters(): { filters: MispricingFilters; threshold: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { filters: DEFAULT_FILTERS, threshold: 1.0 };
    const parsed = JSON.parse(raw);
    return {
      filters: { ...DEFAULT_FILTERS, ...parsed.filters },
      threshold: typeof parsed.threshold === "number" ? parsed.threshold : 1.0,
    };
  } catch {
    return { filters: DEFAULT_FILTERS, threshold: 1.0 };
  }
}

function saveFilters(filters: MispricingFilters, threshold: number): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ filters, threshold }));
  } catch { /* quota exceeded — ignore */ }
}

export function MispricingScannerPanel() {
  const now = useNow(5000);
  const chain = useMarketDataStore((s) => s.optionChain);
  const modelPrices = useMarketDataStore((s) => s.modelPrices);
  const ticks = useMarketDataStore((s) => s.ticks);
  const greeksMap = useGreeksStore((s) => s.greeks);

  const [saved] = useState(loadFilters);
  const [threshold, _setThreshold] = useState(saved.threshold);
  const [showFilters, setShowFilters] = useState(false);
  const [filters, _setFilters] = useState(saved.filters);
  const [isDirty, setIsDirty] = useState(false);

  const setThreshold = (v: number) => { _setThreshold(v); setIsDirty(true); };
  const setFilters = (fn: (f: MispricingFilters) => MispricingFilters) => { _setFilters(fn); setIsDirty(true); };

  const underlying = chain?.underlying ?? "";
  const expiry = chain?.expiry ?? "";
  const selectedUnderlying = useMarketDataStore((s) => s.selectedUnderlying);
  const selectedExpiry = useMarketDataStore((s) => s.selectedExpiry);

  const { rows, filteredOutCount } = useMemo(() => {
    if (!chain || !chain.strikes.length || !modelPrices) return { rows: [] as MispricingRow[], filteredOutCount: 0 };
    if (!modelPrices.hestonCalibrated && !modelPrices.vgCalibrated) return { rows: [] as MispricingRow[], filteredOutCount: 0 };

    const spot = chain.underlyingPrice;

    // Build model IV + PoP lookup by strike
    const modelMap = new Map<number, {
      hestonIv: number | null;
      vgIv: number | null;
      hestonPop: number | null;
      vgPop: number | null;
    }>();
    for (const s of modelPrices.strikes) {
      modelMap.set(s.strike, {
        hestonIv: s.hestonIv,
        vgIv: s.vgIv,
        hestonPop: s.hestonPop,
        vgPop: s.vgPop,
      });
    }

    // Compute confidence from RMSE
    const hestonRmse = modelPrices.hestonRmse;
    const vgRmse = modelPrices.vgRmse;
    const avgRmse =
      hestonRmse != null && vgRmse != null
        ? (hestonRmse + vgRmse) / 2
        : hestonRmse ?? vgRmse ?? 999;
    const confidence: "High" | "Med" | "Low" =
      avgRmse < 0.01 ? "High" : avgRmse < 0.03 ? "Med" : "Low";
    const confidenceWeight = confidence === "High" ? 1.0 : confidence === "Med" ? 0.6 : 0.3;

    const result: MispricingRow[] = [];
    let dropped = 0;

    for (const entry of chain.strikes) {
      const sides: Array<{ optionType: OptionType; tick: typeof entry.call }> = [];
      if (entry.call) sides.push({ optionType: "CE", tick: entry.call });
      if (entry.put) sides.push({ optionType: "PE", tick: entry.put });

      const model = modelMap.get(entry.strike);

      for (const { optionType, tick } of sides) {
        if (!tick) continue;

        const liveTick = ticks.get(tick.symbol) ?? tick;
        const greeks = greeksMap.get(tick.symbol);
        const marketIv = greeks?.iv ? greeks.iv * 100 : null;
        if (marketIv === null) continue;

        const hestonIvPct = modelPrices.hestonCalibrated && model?.hestonIv != null
          ? model.hestonIv * 100 : null;
        const vgIvPct = modelPrices.vgCalibrated && model?.vgIv != null
          ? model.vgIv * 100 : null;

        const hestonEdge = hestonIvPct !== null ? hestonIvPct - marketIv : null;
        const vgEdge = vgIvPct !== null ? vgIvPct - marketIv : null;

        let consensusEdge: number | null = null;
        if (hestonEdge !== null && vgEdge !== null) {
          consensusEdge = (hestonEdge + vgEdge) / 2;
        } else if (hestonEdge !== null) {
          consensusEdge = hestonEdge;
        } else if (vgEdge !== null) {
          consensusEdge = vgEdge;
        }

        if (consensusEdge === null || Math.abs(consensusEdge) < threshold) continue;

        // ── Practical filters ──
        const ltp = liveTick?.ltp ?? 0;
        const bid = liveTick?.bid ?? 0;
        const ask = liveTick?.ask ?? 0;
        const oi = liveTick?.oi ?? 0;
        const volume = liveTick?.volume ?? 0;
        const delta = greeks?.delta ?? null;
        const moneyness = spot > 0 ? ((entry.strike / spot) - 1) * 100 : 0;

        // Spread metrics
        const mid = bid > 0 && ask > 0 ? (bid + ask) / 2 : ltp;
        const spreadPct = bid > 0 && ask > 0 && mid > 0 ? ((ask - bid) / mid) * 100 : null;
        const edgeVsSpread = spreadPct != null && spreadPct > 0
          ? Math.abs(consensusEdge) / spreadPct : null;

        // Apply filters
        if (marketIv < filters.minMarketIv) { dropped++; continue; }
        if (Math.abs(moneyness) > filters.moneynessBand) { dropped++; continue; }
        // No greeks = no actionable signal (can't assess delta, likely illiquid)
        if (delta === null) { dropped++; continue; }
        if (Math.abs(delta) < filters.minAbsDelta) { dropped++; continue; }
        if (Math.abs(delta) > filters.maxAbsDelta) { dropped++; continue; }
        // OTM filter: CE is OTM when strike > spot, PE is OTM when strike < spot
        // Allow ATM within ±1% of spot even with otmOnly on
        if (filters.otmOnly) {
          const isAtm = Math.abs(moneyness) < 1;
          const isOtm = optionType === "CE" ? entry.strike > spot : entry.strike < spot;
          if (!isAtm && !isOtm) { dropped++; continue; }
        }
        if (ltp < filters.minLtp) { dropped++; continue; }
        if (filters.minOi > 0 && oi < filters.minOi) { dropped++; continue; }
        if (filters.minEdgeVsSpread > 0 && edgeVsSpread !== null && edgeVsSpread < filters.minEdgeVsSpread) { dropped++; continue; }

        const action: Side = consensusEdge > 0 ? "BUY" : "SELL";

        const hPop = model?.hestonPop ?? null;
        const vPop = model?.vgPop ?? null;
        let avgPop: number | null = null;
        if (hPop != null && vPop != null) avgPop = (hPop + vPop) / 2;
        else if (hPop != null) avgPop = hPop;
        else if (vPop != null) avgPop = vPop;

        result.push({
          strike: entry.strike,
          optionType,
          symbol: tick.symbol,
          marketIv,
          hestonIv: hestonIvPct,
          vgIv: vgIvPct,
          hestonEdge,
          vgEdge,
          consensusEdge,
          delta,
          ltp: ltp > 0 ? ltp : null,
          bid: bid > 0 ? bid : null,
          ask: ask > 0 ? ask : null,
          oi: oi > 0 ? oi : null,
          volume: volume > 0 ? volume : null,
          moneyness,
          action,
          avgPop,
          confidence,
          confidenceWeight,
          spreadPct,
          edgeVsSpread,
        });
      }
    }

    // Sort: confidence-weighted |edge| descending, then edgeVsSpread as tiebreaker
    result.sort((a, b) => {
      const scoreA = Math.abs(a.consensusEdge) * a.confidenceWeight;
      const scoreB = Math.abs(b.consensusEdge) * b.confidenceWeight;
      if (Math.abs(scoreB - scoreA) > 0.01) return scoreB - scoreA;
      return (b.edgeVsSpread ?? 0) - (a.edgeVsSpread ?? 0);
    });
    return { rows: result, filteredOutCount: dropped };
  }, [chain, modelPrices, ticks, greeksMap, threshold, filters, now]);

  const buyCount = rows.filter((r) => r.action === "BUY").length;
  const sellCount = rows.filter((r) => r.action === "SELL").length;

  const handleAction = (row: MispricingRow) => {
    if (!selectedUnderlying || !selectedExpiry || row.ltp == null) return;
    useBasketStore.getState().addLegFromChain({
      strike: row.strike,
      optionType: row.optionType,
      side: row.action,
      premium: row.ltp,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
    });
  };

  const hestonCalibrated = modelPrices?.hestonCalibrated ?? false;
  const vgCalibrated = modelPrices?.vgCalibrated ?? false;

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      {/* Header */}
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-1.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-[#808090]">
              {underlying && expiry ? `${underlying} ${expiry}` : "No chain loaded"}
            </span>
            {modelPrices && (
              <div className="flex items-center gap-1">
                <span className={`rounded px-1 py-0.5 text-[9px] ${
                  hestonCalibrated
                    ? "bg-emerald-900/40 text-emerald-400"
                    : "bg-red-900/30 text-red-400"
                }`}>
                  H {hestonCalibrated ? "CAL" : "UNCAL"}
                </span>
                <span className={`rounded px-1 py-0.5 text-[9px] ${
                  vgCalibrated
                    ? "bg-emerald-900/40 text-emerald-400"
                    : "bg-red-900/30 text-red-400"
                }`}>
                  VG {vgCalibrated ? "CAL" : "UNCAL"}
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label
              className="flex items-center gap-1 text-[10px] text-[#808090]"
              title="Minimum |consensus edge| in IV% to show a signal. Consensus edge = average of (Heston IV − Market IV) and (VG IV − Market IV). Higher values show only stronger mispricings."
            >
              Edge
              <input
                type="number"
                min={0}
                step={0.5}
                value={threshold}
                onChange={(e) => setThreshold(Math.max(0, parseFloat(e.target.value) || 0))}
                className="w-12 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[11px] text-[#c0c0d0] outline-none focus:border-blue-500/50"
              />
            </label>
            <button
              type="button"
              onClick={() => setShowFilters((p) => !p)}
              className={`rounded px-1.5 py-0.5 text-[9px] font-medium transition-colors ${
                showFilters ? "bg-blue-600/30 text-blue-300" : "bg-[#2a2a4a] text-[#808090] hover:text-[#c0c0d0]"
              }`}
            >
              Filters{filteredOutCount > 0 ? ` (−${filteredOutCount})` : ""}
            </button>
            {rows.length > 0 && (
              <div className="flex items-center gap-1.5 text-[10px]">
                <span className="text-green-400">{buyCount} BUY</span>
                <span className="text-[#808090]">/</span>
                <span className="text-red-400">{sellCount} SELL</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Filter panel */}
      {showFilters && (
        <div className="shrink-0 border-b border-[#2a2a4a] bg-[#16213e] px-3 py-2">
          <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">Min Mkt IV %</span>
              <input type="number" min={0} step={1} value={filters.minMarketIv}
                onChange={(e) => setFilters((f) => ({ ...f, minMarketIv: Math.max(0, Number(e.target.value) || 0) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">Moneyness ±%</span>
              <input type="number" min={1} max={50} step={1} value={filters.moneynessBand}
                onChange={(e) => setFilters((f) => ({ ...f, moneynessBand: Math.max(1, Math.min(50, Number(e.target.value) || 15)) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">|Delta| min</span>
              <input type="number" min={0} max={1} step={0.05} value={filters.minAbsDelta}
                onChange={(e) => setFilters((f) => ({ ...f, minAbsDelta: Math.max(0, Math.min(1, Number(e.target.value) || 0)) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">|Delta| max</span>
              <input type="number" min={0} max={1} step={0.05} value={filters.maxAbsDelta}
                onChange={(e) => setFilters((f) => ({ ...f, maxAbsDelta: Math.max(0, Math.min(1, Number(e.target.value) || 0)) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">Min LTP ₹</span>
              <input type="number" min={0} step={0.5} value={filters.minLtp}
                onChange={(e) => setFilters((f) => ({ ...f, minLtp: Math.max(0, Number(e.target.value) || 0) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">Min OI</span>
              <input type="number" min={0} step={1000} value={filters.minOi}
                onChange={(e) => setFilters((f) => ({ ...f, minOi: Math.max(0, Number(e.target.value) || 0) }))}
                className="w-16 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="inline-flex items-center gap-1 text-[9px] uppercase tracking-wider text-panel-subtle">
                Edge/Spread
                <TooltipHint text={EDGE_VS_SPREAD_TOOLTIP} />
              </span>
              <input type="number" min={0} step={0.1} value={filters.minEdgeVsSpread}
                onChange={(e) => setFilters((f) => ({ ...f, minEdgeVsSpread: Math.max(0, Number(e.target.value) || 0) }))}
                className="w-14 rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-0.5 text-right text-[10px] text-[#c0c0d0] outline-none" />
            </label>
            <label className="flex flex-col gap-0.5">
              <span className="text-[9px] uppercase tracking-wider text-panel-subtle">OTM Only</span>
              <button
                type="button"
                onClick={() => setFilters((f) => ({ ...f, otmOnly: !f.otmOnly }))}
                className={`rounded px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  filters.otmOnly ? "bg-emerald-600/30 text-emerald-300" : "bg-[#2a2a4a] text-[#808090]"
                }`}
              >
                {filters.otmOnly ? "ON" : "OFF"}
              </button>
            </label>
            <button
              type="button"
              onClick={() => { setFilters(() => DEFAULT_FILTERS); _setThreshold(1.0); setIsDirty(true); }}
              className="rounded bg-[#2a2a4a] px-2 py-1 text-[9px] text-[#808090] hover:text-[#c0c0d0]"
            >
              Reset
            </button>
            <button
              type="button"
              onClick={() => { saveFilters(filters, threshold); setIsDirty(false); }}
              className={`rounded px-2 py-1 text-[9px] font-medium transition-colors ${
                isDirty
                  ? "bg-blue-600/40 text-blue-200 hover:bg-blue-600/60"
                  : "bg-[#2a2a4a] text-panel-subtle"
              }`}
            >
              {isDirty ? "Save" : "Saved"}
            </button>
          </div>
        </div>
      )}

      {/* Table */}
      <div className="min-h-0 flex-1 overflow-auto">
        {!modelPrices || (!hestonCalibrated && !vgCalibrated) ? (
          <div className="flex h-full items-center justify-center text-[11px] text-panel-subtle">
            No calibrated models available. Waiting for Heston/VG calibration...
          </div>
        ) : rows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-[11px] text-panel-subtle">
            No mispricing signals above {threshold.toFixed(1)}% threshold
          </div>
        ) : (
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[#16213e]">
              <tr className="text-[#808090]">
                <th className="px-2 py-1.5 text-right font-medium">Strike</th>
                <th className="px-2 py-1.5 text-center font-medium">Type</th>
                <th className="px-2 py-1.5 text-right font-medium">Mkt IV</th>
                <th className="px-2 py-1.5 text-right font-medium text-amber-400">H IV</th>
                <th className="px-2 py-1.5 text-right font-medium text-pink-400">VG IV</th>
                <th className="px-2 py-1.5 text-right font-medium">Edge</th>
                <th className="px-2 py-1.5 text-right font-medium">
                  <span className="inline-flex items-center justify-end gap-1">
                    E/S
                    <TooltipHint text={EDGE_VS_SPREAD_TOOLTIP} />
                  </span>
                </th>
                <th className="px-2 py-1.5 text-right font-medium">Delta</th>
                <th className="px-2 py-1.5 text-right font-medium">LTP</th>
                <th className="px-2 py-1.5 text-center font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const edgeAbs = Math.abs(row.consensusEdge);
                const isStrong = edgeAbs > 2;
                return (
                  <tr
                    key={`${row.strike}-${row.optionType}`}
                    className="border-b border-[#2a2a4a]/30 hover:bg-[#1e1e3a]"
                  >
                    <td className="px-2 py-1 text-right font-mono text-[#c0c0d0]">
                      {row.strike}
                    </td>
                    <td className={`px-2 py-1 text-center font-medium ${
                      row.optionType === "CE" ? "text-green-400/80" : "text-red-400/80"
                    }`}>
                      {row.optionType}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[#c0c0d0]">
                      {row.marketIv.toFixed(1)}%
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-amber-400/80">
                      {row.hestonIv !== null ? `${row.hestonIv.toFixed(1)}%` : "-"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-pink-400/80">
                      {row.vgIv !== null ? `${row.vgIv.toFixed(1)}%` : "-"}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono ${
                      row.consensusEdge > 0
                        ? isStrong ? "font-semibold text-green-400" : "text-green-400/70"
                        : isStrong ? "font-semibold text-red-400" : "text-red-400/70"
                    }`}>
                      {row.consensusEdge >= 0 ? "+" : ""}{row.consensusEdge.toFixed(1)}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono ${
                      row.edgeVsSpread !== null
                        ? row.edgeVsSpread >= 2 ? "font-semibold text-green-400"
                          : row.edgeVsSpread >= 1 ? "text-green-400/70"
                          : "text-yellow-400/60"
                        : "text-[#808090]"
                    }`} title={row.spreadPct !== null ? `Spread: ${row.spreadPct.toFixed(1)}%` : "No bid/ask"}>
                      {row.edgeVsSpread !== null ? `${row.edgeVsSpread.toFixed(1)}x` : "-"}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono ${
                      row.delta !== null && row.delta > 0 ? "text-green-400" : row.delta !== null && row.delta < 0 ? "text-red-400" : "text-[#808090]"
                    }`}>
                      {row.delta !== null ? row.delta.toFixed(2) : "-"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[#c0c0d0]">
                      {row.ltp !== null ? row.ltp.toFixed(2) : "-"}
                    </td>
                    <td className="px-2 py-1 text-center">
                      <button
                        type="button"
                        onClick={() => handleAction(row)}
                        disabled={row.ltp == null}
                        className={`rounded px-2 py-0.5 text-[10px] font-bold shadow-sm transition-colors ${
                          row.action === "BUY"
                            ? "bg-emerald-500/90 text-white hover:bg-emerald-400"
                            : "bg-rose-500/90 text-white hover:bg-rose-400"
                        } disabled:opacity-30`}
                      >
                        {row.action}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
