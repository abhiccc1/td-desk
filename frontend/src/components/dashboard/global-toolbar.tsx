"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getConfig } from "@/lib/config";
import { LayoutGrid, LogOut, RotateCcw, Settings, ShieldAlert, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SEGMENT_LABELS, segmentOfExchange } from "@/lib/instruments";
import type { Segment } from "@/lib/instruments";
import { useSegmentStore } from "@/stores/segment-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { BrokerStatus, FeedMode } from "@/stores/market-data-store";
import { useLayoutStore } from "@/stores/layout-store";
import { usePositionStore } from "@/stores/position-store";
import { fetchLimits } from "@/lib/api-client";
import type { AccountLimits } from "@/lib/api-client";

const FALLBACK_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];

function formatCompact(value: number | null): string {
  if (value === null) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_00_00_000) return `${(value / 1_00_00_000).toFixed(2)}Cr`;
  if (abs >= 1_00_000) return `${(value / 1_00_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}


const FEED_BADGE: Record<
  Exclude<FeedMode, null>,
  { label: string; className: string }
> = {
  broker: {
    label: "LIVE",
    className: "bg-green-600/20 text-green-400 border-green-600/40",
  },
};

const BROKER_INDICATOR: Record<
  Exclude<BrokerStatus, null>,
  { label: string; className: string; dotClass: string }
> = {
  connected: {
    label: "Kotak",
    className: "text-green-400",
    dotClass: "bg-green-400",
  },
  disconnected: {
    label: "Kotak",
    className: "text-red-400",
    dotClass: "bg-red-400",
  },
  authenticating: {
    label: "Kotak",
    className: "text-yellow-400",
    dotClass: "bg-yellow-400 animate-pulse",
  },
};

interface Props {
  onOpenSettings?: () => void;
  onSwitchAccount?: () => void;
  activeUcc?: string;
}

export function GlobalToolbar({ onOpenSettings, onSwitchAccount, activeUcc }: Props) {
  const selectedUnderlying = useMarketDataStore((s) => s.selectedUnderlying);
  const selectedExpiry = useMarketDataStore((s) => s.selectedExpiry);
  const setSelectedUnderlying = useMarketDataStore(
    (s) => s.setSelectedUnderlying,
  );
  const setSelectedExpiry = useMarketDataStore((s) => s.setSelectedExpiry);
  const feedMode = useMarketDataStore((s) => s.feedMode);
  const brokerStatus = useMarketDataStore((s) => s.brokerStatus);
  const availableExpiries = useMarketDataStore((s) => s.availableExpiries);
  const spotPrice = useMarketDataStore((s) => s.optionChain?.underlyingPrice ?? 0);
  const spotStatic = useMarketDataStore((s) => s.spotStatic);
  const storeUnderlyings = useMarketDataStore((s) => s.availableUnderlyings);
  const underlyingMeta = useMarketDataStore((s) => s.underlyingMeta);
  const underlyingFuture = useMarketDataStore((s) => s.optionChain?.underlyingFuture ?? null);
  const segment = useSegmentStore((s) => s.segment);
  const setSegment = useSegmentStore((s) => s.setSegment);
  const wsVrp = useMarketDataStore((s) => s.vrp);
  const setRiskWorkspace = useLayoutStore((s) => s.setRiskWorkspace);
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const showPanelBar = useLayoutStore((s) => s.showPanelBar);
  const togglePanelBar = useLayoutStore((s) => s.togglePanelBar);
  const orderUpdateVersion = usePositionStore((s) => s.orderUpdateVersion);

  // Fetch account margin limits — refresh on order fills
  const [limits, setLimits] = useState<AccountLimits | null>(null);
  useEffect(() => {
    if (feedMode !== "broker") return;
    let cancelled = false;
    async function load() {
      try {
        const data = await fetchLimits();
        if (!cancelled && data) setLimits(data);
      } catch { /* ignore */ }
    }
    load();
    // Periodic refresh every 60s
    const interval = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [feedMode, orderUpdateVersion]);

  // Fetch IV Rank for selected underlying
  const [ivRankData, setIvRankData] = useState<{
    currentIv: number | null;
    prevCloseIv: number | null;
    ivRank: number | null;
    ivPercentile: number | null;
    samples?: number;
  } | null>(null);
  useEffect(() => {
    if (!selectedUnderlying || feedMode !== "broker") {
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const { apiUrl } = getConfig();
        const resp = await fetch(`${apiUrl}/api/v1/iv-rank/${encodeURIComponent(selectedUnderlying)}`);
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled && data.currentIv !== null) setIvRankData(data);
        }
      } catch { /* ignore */ }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedUnderlying, feedMode]);

  // Fetch VRP for selected underlying
  const [vrpData, setVrpData] = useState<{
    atmIv: number | null;
    realizedVol: number | null;
    vrp: number | null;
    samples: number;
    window: number;
  } | null>(null);
  useEffect(() => {
    if (!selectedUnderlying || feedMode !== "broker") {
      return;
    }
    let cancelled = false;
    async function load() {
      try {
        const { apiUrl } = getConfig();
        const resp = await fetch(`${apiUrl}/api/v1/vrp/${encodeURIComponent(selectedUnderlying)}`);
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled) setVrpData(data);
        }
      } catch { /* ignore */ }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selectedUnderlying, feedMode]);

  // Compute live change from prevClose
  const prevClose = spotStatic?.prevClose ?? 0;
  const liveChange = prevClose > 0 && spotPrice > 0 ? spotPrice - prevClose : 0;
  const livePctChange = prevClose > 0 && spotPrice > 0 ? ((spotPrice - prevClose) / prevClose) * 100 : 0;
  const visibleIvRankData = selectedUnderlying && feedMode === "broker" ? ivRankData : null;

  // Merge WS real-time VRP with REST-polled fallback; WS takes priority
  const mergedVrpData = selectedUnderlying && feedMode === "broker"
    ? (wsVrp && wsVrp.underlying === selectedUnderlying
      ? { atmIv: wsVrp.atmIv * 100, realizedVol: wsVrp.realizedVol * 100, vrp: wsVrp.vrp * 100, ivRank: wsVrp.ivRank, window: wsVrp.windowDays }
      : vrpData
        ? { atmIv: vrpData.atmIv, realizedVol: vrpData.realizedVol, vrp: vrpData.vrp, ivRank: null as number | null, window: vrpData.window }
        : null)
    : null;

  // The segment toggle only appears once the backend exposes MCX; until then
  // everything behaves exactly as before (NSE+BSE only).
  const hasMcx = underlyingMeta.some((u) => segmentOfExchange(u.exchange) === "MCX");
  const activeSegment: Segment = hasMcx ? segment : "EQ_IDX";

  const underlyingOptions = useMemo(() => {
    if (underlyingMeta.length === 0) {
      const names = storeUnderlyings.length > 0 ? storeUnderlyings : FALLBACK_UNDERLYINGS;
      return names.map((name) => ({ name, label: name }));
    }
    return underlyingMeta
      .filter((u) => segmentOfExchange(u.exchange) === activeSegment)
      .map((u) => ({ name: u.name, label: u.name }));
  }, [underlyingMeta, storeUnderlyings, activeSegment]);

  // Switching segment re-selects an underlying from that segment so an MCX
  // chain never stays subscribed under the NSE+BSE view (and vice versa).
  useEffect(() => {
    if (underlyingMeta.length === 0 || !selectedUnderlying) return;
    if (underlyingOptions.some((u) => u.name === selectedUnderlying)) return;
    setSelectedUnderlying(underlyingOptions[0]?.name ?? "");
    setSelectedExpiry("");
  }, [underlyingMeta.length, underlyingOptions, selectedUnderlying, setSelectedUnderlying, setSelectedExpiry]);

  const handleSegmentChange = useCallback(
    (next: Segment) => {
      setSegment(next);
    },
    [setSegment],
  );

  const isFuturesChain = !!underlyingFuture;

  const expiries = availableExpiries;

  const handleUnderlyingChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedUnderlying(e.target.value);
      setSelectedExpiry("");
    },
    [setSelectedUnderlying, setSelectedExpiry],
  );

  const handleExpiryChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      setSelectedExpiry(e.target.value);
    },
    [setSelectedExpiry],
  );

  const badge = feedMode ? FEED_BADGE[feedMode] : null;
  const broker = brokerStatus ? BROKER_INDICATOR[brokerStatus] : null;

  return (
    <div className="flex items-center justify-between border-b border-panel-border bg-panel-header px-3 py-1.5">
      <div className="flex items-center gap-3">
        {badge && (
          <Badge
            variant="outline"
            className={`rounded-sm px-1.5 py-0.5 text-[10px] font-bold tracking-wider ${badge.className}`}
          >
            {badge.label}
          </Badge>
        )}

        {hasMcx && (
          <SegmentedControl<Segment>
            value={activeSegment}
            onValueChange={handleSegmentChange}
            options={(["EQ_IDX", "MCX"] as const).map((v) => ({ value: v, label: SEGMENT_LABELS[v] }))}
            itemClassName="text-[11px]"
          />
        )}

        <label className="flex items-center gap-1.5 text-xs font-medium text-panel-muted">
          Underlying
          <Select
            value={selectedUnderlying}
            onChange={handleUnderlyingChange}
            className="h-7 w-auto min-w-28 border-panel-border bg-panel px-2 py-1 text-xs text-panel-muted"
          >
            <option value="">Select...</option>
            {underlyingOptions.map((u) => (
              <option key={u.name} value={u.name}>
                {u.label}
              </option>
            ))}
          </Select>
        </label>

        <label className="flex items-center gap-1.5 text-xs font-medium text-panel-muted">
          Expiry
          <Select
            value={selectedExpiry}
            onChange={handleExpiryChange}
            className="h-7 w-auto min-w-[8.5rem] border-panel-border bg-panel px-2 py-1 text-xs text-panel-muted"
          >
            <option value="">Select...</option>
            {expiries.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </Select>
        </label>

        {spotPrice > 0 && (
          <div
            className="flex items-center gap-1.5 rounded-sm border border-yellow-600/40 bg-yellow-600/10 px-2 py-0.5"
            title={underlyingFuture ? `Underlying future ${underlyingFuture.tradingSymbol} (expires ${underlyingFuture.expiry})` : undefined}
          >
            <span className="text-[10px] font-medium text-yellow-400/70">{isFuturesChain ? "FUT" : "SPOT"}</span>
            {underlyingFuture && (
              <span className="text-[10px] font-medium text-yellow-400/60">{underlyingFuture.tradingSymbol}</span>
            )}
            <span className="text-sm font-bold tabular-nums text-yellow-300">
              {spotPrice.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            </span>
            {prevClose > 0 && (
              <span className={`text-xs font-semibold tabular-nums ${liveChange >= 0 ? "text-green-400" : "text-red-400"}`}>
                {liveChange >= 0 ? "+" : ""}{liveChange.toFixed(2)} ({livePctChange >= 0 ? "+" : ""}{livePctChange.toFixed(2)}%)
              </span>
            )}
          </div>
        )}

        {visibleIvRankData && visibleIvRankData.currentIv !== null && (() => {
          const ivChange = visibleIvRankData.prevCloseIv !== null && visibleIvRankData.prevCloseIv > 0
            ? visibleIvRankData.currentIv! - visibleIvRankData.prevCloseIv
            : null;
          return (
            <div
              className="flex min-h-6 items-center gap-1.5 rounded-sm border border-[#2a2a4a] bg-[#1a1a2e] px-2 py-1"
              title={[
                `ATM IV: ${visibleIvRankData.currentIv?.toFixed(1)}%`,
                visibleIvRankData.prevCloseIv != null ? `Prev Close IV: ${visibleIvRankData.prevCloseIv.toFixed(1)}%` : null,
                ivChange !== null ? `Day Change: ${ivChange >= 0 ? "+" : ""}${ivChange.toFixed(1)}%` : null,
                visibleIvRankData.ivRank !== null ? `IV Rank: ${visibleIvRankData.ivRank}%` : null,
                visibleIvRankData.ivPercentile !== null ? `IV Percentile: ${visibleIvRankData.ivPercentile}%` : null,
              ].filter(Boolean).join(" | ")}
            >
              <span className="text-[10px] font-medium text-[#808090]">IV</span>
              <span className="text-[15px] font-bold tabular-nums leading-none text-[#e0e0e0]">
                {visibleIvRankData.currentIv?.toFixed(1)}%
              </span>
              {ivChange !== null && (
                <span className={`text-xs font-semibold tabular-nums leading-none ${
                  ivChange > 0.5 ? "text-red-400" : ivChange < -0.5 ? "text-green-400" : "text-yellow-400"
                }`}>
                  {ivChange >= 0 ? "+" : ""}{ivChange.toFixed(1)}%
                </span>
              )}
              <span
                className={`text-xs leading-none font-semibold tabular-nums ${
                  visibleIvRankData.ivRank === null
                    ? "text-panel-dim"
                    : visibleIvRankData.ivRank > 70
                      ? "text-red-400"
                      : visibleIvRankData.ivRank > 30
                        ? "text-yellow-400"
                        : "text-green-400"
                }`}
              >
                R:{visibleIvRankData.ivRank ?? "--"}%
              </span>
            </div>
          );
        })()}

        {mergedVrpData && mergedVrpData.vrp !== null && (
          <div
            className="flex min-h-6 items-center gap-1.5 rounded-sm border border-[#2a2a4a] bg-[#1a1a2e] px-2 py-1"
            title={[
              `ATM IV: ${mergedVrpData.atmIv !== null ? mergedVrpData.atmIv.toFixed(1) + "%" : "--"}`,
              `RV(${mergedVrpData.window}d): ${mergedVrpData.realizedVol !== null ? mergedVrpData.realizedVol.toFixed(1) + "%" : "--"}`,
              `VRP: ${mergedVrpData.vrp > 0 ? "+" : ""}${mergedVrpData.vrp.toFixed(1)}%`,
              mergedVrpData.ivRank !== null ? `IV Rank: ${mergedVrpData.ivRank.toFixed(0)}%` : "",
            ].filter(Boolean).join(" | ")}
          >
            <div className="flex flex-col items-start">
              <div className="flex items-center gap-1">
                <span className="text-[10px] font-medium text-[#808090]">VRP</span>
                <span
                  className={`text-[15px] font-bold tabular-nums leading-none ${
                    mergedVrpData.vrp > 5
                      ? "text-green-400"
                      : mergedVrpData.vrp > 0
                        ? "text-green-400/60"
                        : mergedVrpData.vrp >= -2
                          ? "text-yellow-400/80"
                          : "text-red-400"
                  }`}
                >
                  {mergedVrpData.vrp > 0 ? "+" : ""}{mergedVrpData.vrp.toFixed(1)}%
                </span>
              </div>
              {mergedVrpData.realizedVol !== null && (
                <span className="text-[9px] tabular-nums leading-tight text-[#808090]">
                  RV: {mergedVrpData.realizedVol.toFixed(1)}%
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
        {limits && (limits.marginFromShares !== null || limits.marginUsed !== null) && (
          <div
            className="flex min-h-7 items-center gap-1.5 rounded-sm border border-[#2a2a4a] bg-[#1a1a2e] px-2 py-1"
            title={`Margin from shares: ${formatCompact(limits.marginFromShares)}${limits.marginUsed !== null ? ` | Used: ${formatCompact(limits.marginUsed)}` : ""}`}
          >
            <span className="text-[10px] font-medium text-[#808090]">Net</span>
            <span className="text-sm font-bold tabular-nums text-panel-muted">
              {formatCompact((limits.collateral ?? 0) + (limits.marginFromShares ?? 0))}
            </span>
            {limits.marginUsed !== null && limits.marginUsed > 0 && (
              <>
                <span className="text-[10px] text-[#808090]">Used</span>
                <span className="text-sm font-bold tabular-nums text-orange-400">
                  {formatCompact(limits.marginUsed)}
                </span>
              </>
            )}
          </div>
        )}

        {broker && (
          <div
            className={`flex items-center gap-1.5 text-xs ${broker.className}`}
            title={`Broker: ${brokerStatus}`}
          >
            {brokerStatus === "connected" ? (
              <Wifi size={12} />
            ) : (
              <WifiOff size={12} />
            )}
            <span className="font-medium">{broker.label}</span>
            <span className={`h-1.5 w-1.5 rounded-full ${broker.dotClass}`} />
          </div>
        )}

        <Button
          onClick={togglePanelBar}
          variant="outline"
          size="xs"
          className={
            showPanelBar
              ? "gap-1 border-blue-500/50 bg-blue-500/15 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300"
              : "gap-1 border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
          }
          title="Show or hide panel visibility bar"
        >
          <LayoutGrid size={11} />
          Panels
        </Button>

        <Button
          onClick={setRiskWorkspace}
          variant="outline"
          size="xs"
          className="gap-1 border-amber-500/40 bg-amber-500/10 text-amber-300 hover:border-amber-400 hover:bg-amber-500/15 hover:text-amber-200"
          title="Switch to risk workspace layout"
        >
          <ShieldAlert size={11} />
          Risk
        </Button>

        <Button
          onClick={resetLayout}
          variant="outline"
          size="xs"
          className="gap-1 border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
          title="Reset to default layout"
        >
          <RotateCcw size={11} />
          Reset
        </Button>

        {onSwitchAccount && (
          <Button
            onClick={onSwitchAccount}
            variant="outline"
            size="xs"
            className="gap-1 border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
            title="Sign out and pick a different broker account"
          >
            <LogOut size={11} />
            {activeUcc || "Account"}
          </Button>
        )}

        {onOpenSettings && (
          <Button
            onClick={onOpenSettings}
            variant="outline"
            size="icon-xs"
            className="border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
            title="Settings"
          >
            <Settings size={13} />
          </Button>
        )}
      </div>
    </div>
  );
}
