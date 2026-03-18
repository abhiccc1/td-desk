"use client";

import { useCallback, useEffect, useState } from "react";
import { getConfig } from "@/lib/config";
import { LayoutGrid, RotateCcw, Settings, Wifi, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { BrokerStatus, FeedMode } from "@/stores/market-data-store";
import { useLayoutStore } from "@/stores/layout-store";

const FALLBACK_UNDERLYINGS = ["NIFTY", "BANKNIFTY", "FINNIFTY", "MIDCPNIFTY", "SENSEX"];


const FEED_BADGE: Record<
  Exclude<FeedMode, null>,
  { label: string; className: string }
> = {
  broker: {
    label: "LIVE",
    className: "bg-green-600/20 text-green-400 border-green-600/40",
  },
  mock: {
    label: "MOCK",
    className: "bg-blue-600/20 text-blue-400 border-blue-600/40",
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
}

export function GlobalToolbar({ onOpenSettings }: Props) {
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
  const resetLayout = useLayoutStore((s) => s.resetLayout);
  const showPanelBar = useLayoutStore((s) => s.showPanelBar);
  const togglePanelBar = useLayoutStore((s) => s.togglePanelBar);

  // Fetch IV Rank for selected underlying
  const [ivRankData, setIvRankData] = useState<{
    currentIv: number | null;
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

  // Compute live change from prevClose
  const prevClose = spotStatic?.prevClose ?? 0;
  const liveChange = prevClose > 0 && spotPrice > 0 ? spotPrice - prevClose : 0;
  const livePctChange = prevClose > 0 && spotPrice > 0 ? ((spotPrice - prevClose) / prevClose) * 100 : 0;
  const visibleIvRankData = selectedUnderlying && feedMode === "broker" ? ivRankData : null;

  const underlyings =
    storeUnderlyings.length > 0 ? storeUnderlyings : FALLBACK_UNDERLYINGS;

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

        <label className="flex items-center gap-1.5 text-xs font-medium text-panel-muted">
          Underlying
          <Select
            value={selectedUnderlying}
            onChange={handleUnderlyingChange}
            className="h-7 w-auto min-w-28 border-panel-border bg-panel px-2 py-1 text-xs text-panel-muted"
          >
            <option value="">Select...</option>
            {underlyings.map((u) => (
              <option key={u} value={u}>
                {u}
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
          <div className="flex items-center gap-1.5 rounded-sm border border-yellow-600/40 bg-yellow-600/10 px-2 py-0.5">
            <span className="text-[10px] font-medium text-yellow-400/70">SPOT</span>
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

        {visibleIvRankData && visibleIvRankData.currentIv !== null && (
          <div className="flex items-center gap-1.5 rounded-sm border border-[#2a2a4a] bg-[#1a1a2e] px-2 py-0.5">
            <span className="text-[10px] font-medium text-[#808090]">IV</span>
            <span className="text-xs font-bold tabular-nums text-[#e0e0e0]">
              {visibleIvRankData.currentIv?.toFixed(1)}%
            </span>
            <span
              className={`text-[10px] font-semibold tabular-nums ${
                visibleIvRankData.ivRank === null
                  ? "text-panel-dim"
                  : visibleIvRankData.ivRank > 70
                    ? "text-red-400"
                    : visibleIvRankData.ivRank > 30
                      ? "text-yellow-400"
                      : "text-green-400"
              }`}
              title={
                visibleIvRankData.ivRank === null
                  ? `IV Rank unavailable. Samples: ${visibleIvRankData.samples ?? 0}`
                  : `IV Rank: ${visibleIvRankData.ivRank}% | IV Percentile: ${visibleIvRankData.ivPercentile}%`
              }
            >
              R:{visibleIvRankData.ivRank ?? "--"}%
            </span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-3">
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
          onClick={resetLayout}
          variant="outline"
          size="xs"
          className="gap-1 border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
          title="Reset to default layout"
        >
          <RotateCcw size={11} />
          Reset
        </Button>

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
