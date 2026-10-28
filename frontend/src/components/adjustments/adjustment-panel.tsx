"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchAdjustments } from "@/lib/api-client";
import { useBasketStore } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { AdjustmentRecommendation, AdjustmentRecLeg } from "@/types/market-data";

const REFRESH_INTERVAL = 60_000;

const ACTION_LABELS: Record<string, string> = {
  roll: "Roll",
  add_wing: "Hedge",
  close_partial: "Trim",
  convert: "Convert",
};

const ACTION_COLORS: Record<string, string> = {
  roll: "bg-blue-500/20 text-blue-400",
  add_wing: "bg-amber-500/20 text-amber-400",
  close_partial: "bg-red-500/20 text-red-400",
  convert: "bg-purple-500/20 text-purple-400",
};

function fmtMoney(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}Rs ${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function fmtPct(v: number): string {
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtGreek(v: number, digits = 1): string {
  if (Math.abs(v) < 0.01) return "0";
  return v.toFixed(digits);
}

function EfficiencyBar({ score }: { score: number }) {
  const pct = Math.min(100, (score / 10) * 100);
  const color =
    score >= 5 ? "bg-emerald-500" : score >= 3 ? "bg-amber-500" : "bg-red-400";
  return (
    <div className="h-1.5 w-20 rounded-full bg-white/10">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

function GreekDelta({
  label,
  current,
  projected,
}: {
  label: string;
  current: number;
  projected: number;
}) {
  const diff = projected - current;
  if (Math.abs(diff) < 0.05) return null;
  const color = diff > 0 ? "text-emerald-400" : "text-red-400";
  return (
    <div className="flex items-center gap-1.5 text-[11px]">
      <span className="text-white/40">{label}</span>
      <span className="text-white/60">{fmtGreek(current)}</span>
      <span className="text-white/30">&rarr;</span>
      <span className={color}>{fmtGreek(projected)}</span>
    </div>
  );
}

function LegRow({ leg }: { leg: AdjustmentRecLeg }) {
  const sideColor = leg.side === "BUY" ? "text-emerald-400" : "text-red-400";
  return (
    <div className="flex items-center gap-2 text-[11px]">
      <span className={`font-medium ${sideColor}`}>{leg.side}</span>
      <span className="text-white/70">
        {leg.quantity}x {Math.round(leg.strike)} {leg.optionType}
      </span>
      <span className="text-white/40">{leg.expiry}</span>
      <span className="ml-auto text-white/50">~{leg.estimatedPrice.toFixed(1)}</span>
    </div>
  );
}

function RecommendationCard({ rec }: { rec: AdjustmentRecommendation }) {
  const [expanded, setExpanded] = useState(false);
  const addLeg = useBasketStore((s) => s.addLeg);

  const handleExecute = useCallback(() => {
    for (const leg of rec.legs) {
      addLeg({
        symbol: leg.symbol,
        strike: leg.strike,
        optionType: leg.optionType as "CE" | "PE",
        side: leg.side as "BUY" | "SELL",
        quantity: leg.quantity,
        premium: leg.estimatedPrice,
        orderType: "LIMIT",
        productType: "NRML",
        underlying: leg.symbol.split(" ")[0],
        expiry: leg.expiry,
      });
    }
  }, [rec.legs, addLeg]);

  return (
    <div className="rounded-lg border border-white/8 bg-white/[0.03] p-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-1.5 py-0.5 text-[10px] font-semibold ${ACTION_COLORS[rec.actionType] ?? "bg-white/10 text-white/50"}`}
            >
              {ACTION_LABELS[rec.actionType] ?? rec.actionType}
            </span>
            <span className="text-xs font-medium text-white/90">
              {rec.title}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-white/50">
            {rec.description}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <EfficiencyBar score={rec.efficiencyScore} />
          <span className="text-[10px] text-white/30">
            eff {rec.efficiencyScore.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Metrics row */}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px]">
        <div>
          <span className="text-white/40">Credit: </span>
          <span
            className={
              rec.netCredit >= 0 ? "text-emerald-400" : "text-red-400"
            }
          >
            {fmtMoney(rec.netCredit)}
          </span>
        </div>
        {rec.riskImpactPct !== 0 && (
          <div>
            <span className="text-white/40">Risk: </span>
            <span
              className={
                rec.riskImpactPct > 0 ? "text-emerald-400" : "text-red-400"
              }
            >
              {fmtPct(rec.riskImpactPct)}
            </span>
          </div>
        )}
        {rec.profitImpactPct !== 0 && (
          <div>
            <span className="text-white/40">Profit: </span>
            <span
              className={
                rec.profitImpactPct >= 0 ? "text-emerald-400" : "text-amber-400"
              }
            >
              {fmtPct(rec.profitImpactPct)}
            </span>
          </div>
        )}
        {rec.projectedPop != null && rec.currentPop != null && (
          <div>
            <span className="text-white/40">POP: </span>
            <span className="text-white/60">
              {(rec.currentPop * 100).toFixed(0)}%
            </span>
            <span className="text-white/30"> &rarr; </span>
            <span className="text-white/80">
              {(rec.projectedPop * 100).toFixed(0)}%
            </span>
          </div>
        )}
      </div>

      {/* Greek changes */}
      <div className="mt-2 flex flex-wrap gap-3">
        <GreekDelta
          label="Delta"
          current={rec.currentGreeks.delta}
          projected={rec.projectedGreeks.delta}
        />
        <GreekDelta
          label="Gamma"
          current={rec.currentGreeks.gamma}
          projected={rec.projectedGreeks.gamma}
        />
        <GreekDelta
          label="Theta"
          current={rec.currentGreeks.theta}
          projected={rec.projectedGreeks.theta}
        />
        <GreekDelta
          label="Vega"
          current={rec.currentGreeks.vega}
          projected={rec.projectedGreeks.vega}
        />
      </div>

      {/* Expandable legs + execute */}
      <div className="mt-2 flex items-center gap-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-[11px] text-blue-400 hover:text-blue-300"
        >
          {expanded ? "Hide legs" : `Show ${rec.legs.length} leg${rec.legs.length > 1 ? "s" : ""}`}
        </button>
        <button
          onClick={handleExecute}
          className="ml-auto rounded bg-blue-600/80 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-blue-600"
        >
          Add to Basket
        </button>
      </div>

      {expanded && (
        <div className="mt-2 space-y-1 rounded bg-black/20 p-2">
          {rec.legs.map((leg, i) => (
            <LegRow key={i} leg={leg} />
          ))}
        </div>
      )}

      {/* Warnings */}
      {rec.warnings.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {rec.warnings.map((w, i) => (
            <div key={i} className="text-[10px] text-amber-400/70">
              {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AdjustmentPanel() {
  const underlying = useMarketDataStore((s) => s.selectedUnderlying);
  const [recommendations, setRecommendations] = useState<
    AdjustmentRecommendation[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!underlying) return;
    setLoading(true);
    try {
      const data = await fetchAdjustments(underlying);
      setRecommendations(data);
      setLastRefresh(Date.now());
    } finally {
      setLoading(false);
    }
  }, [underlying]);

  // Fetch on mount and when underlying changes
  useEffect(() => {
    setRecommendations([]);
    refresh();
  }, [refresh]);

  // Auto-refresh
  useEffect(() => {
    intervalRef.current = setInterval(refresh, REFRESH_INTERVAL);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [refresh]);

  if (!underlying) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="text-xs text-white/30">Select an underlying</span>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-1.5">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium text-white/70">
            {underlying} Adjustments
          </span>
          {loading && (
            <span className="text-[10px] text-white/30">Loading...</span>
          )}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded px-2 py-0.5 text-[11px] text-white/40 hover:bg-white/5 hover:text-white/60 disabled:opacity-50"
        >
          Refresh
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {recommendations.length === 0 && !loading && (
          <div className="flex h-full items-center justify-center">
            <span className="text-xs text-white/30">
              No adjustment recommendations — position risk is within bounds
            </span>
          </div>
        )}
        <div className="space-y-2">
          {recommendations.map((rec) => (
            <RecommendationCard key={rec.id} rec={rec} />
          ))}
        </div>
      </div>

      {/* Footer */}
      {lastRefresh > 0 && (
        <div className="border-t border-white/5 px-3 py-1">
          <span className="text-[10px] text-white/20">
            Updated {new Date(lastRefresh).toLocaleTimeString()}
          </span>
        </div>
      )}
    </div>
  );
}
