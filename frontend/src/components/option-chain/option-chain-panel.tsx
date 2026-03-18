"use client";

import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, TimerReset } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { useBasketStore } from "@/stores/basket-store";
import { buildActiveLegSet } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { OptionChainGrid } from "./option-chain-grid";
import { InlineOrderDrawer } from "./inline-order-drawer";
import { useCellClickHandler } from "./use-cell-click-handler";
import { SviAlertBar } from "@/components/alerts/svi-alert-bar";

const MIN_DRAWER_H = 80;
const MIN_GRID_H = 100;
const DEFAULT_DRAWER_H = 600;
const COLLAPSED_H = 32;

function formatLatency(ms: number | null): string {
  if (ms === null || Number.isNaN(ms)) return "--";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function ChainLatencyReadout() {
  const now = useNow(250);
  const optionChain = useMarketDataStore((s) => s.optionChain);

  if (!optionChain?.timestamp) return null;

  const publishedAt = new Date(optionChain.timestamp).getTime();
  const sourceAt = optionChain.sourceTimestamp
    ? new Date(optionChain.sourceTimestamp).getTime()
    : null;

  const snapshotLagMs =
    sourceAt !== null && Number.isFinite(sourceAt)
      ? Math.max(0, publishedAt - sourceAt)
      : null;
  const uiLagMs = Number.isFinite(publishedAt)
    ? Math.max(0, now - publishedAt)
    : null;
  const liveAgeMs =
    sourceAt !== null && Number.isFinite(sourceAt)
      ? Math.max(0, now - sourceAt)
      : null;

  return (
    <div className="flex items-center justify-end gap-2 border-b border-[#2a2a4a] bg-[#16213e] px-3 py-1 text-[10px] text-[#9090a8]">
      <span className="font-medium text-[#b7b7c8]">Latency</span>
      <span className="inline-flex items-center gap-1 rounded-sm border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 tabular-nums text-emerald-300">
        <Activity className="h-3 w-3" />
        Live {formatLatency(liveAgeMs)}
      </span>
      <span className="inline-flex items-center gap-1 rounded-sm border border-blue-500/30 bg-blue-500/10 px-1.5 py-0.5 tabular-nums text-blue-300">
        <TimerReset className="h-3 w-3" />
        Snapshot {formatLatency(snapshotLagMs)}
      </span>
      <span className="rounded-sm border border-[#38415d] bg-[#20263d] px-1.5 py-0.5 tabular-nums text-[#c7cada]">
        UI {formatLatency(uiLagMs)}
      </span>
    </div>
  );
}

export function OptionChainPanel() {
  const legs = useBasketStore((s) => s.legs);
  const activeLegSet = useMemo(() => buildActiveLegSet(legs), [legs]);
  const onCellClicked = useCellClickHandler();

  const containerRef = useRef<HTMLDivElement>(null);
  const [drawerHeight, setDrawerHeight] = useState(COLLAPSED_H);
  const dragging = useRef(false);
  const prevLegCount = useRef(0);
  const isCollapsed = drawerHeight <= COLLAPSED_H;

  // Auto-expand when first leg is added, auto-collapse on clear
  useEffect(() => {
    if (legs.length > 0 && prevLegCount.current === 0) {
      startTransition(() => {
        setDrawerHeight(DEFAULT_DRAWER_H);
      });
    }
    if (legs.length === 0 && prevLegCount.current > 0 && isCollapsed) {
      startTransition(() => {
        setDrawerHeight(COLLAPSED_H);
      });
    }
    prevLegCount.current = legs.length;
  }, [legs.length, isCollapsed]);

  const toggleDrawer = useCallback(() => {
    setDrawerHeight((h) => (h <= COLLAPSED_H ? DEFAULT_DRAWER_H : COLLAPSED_H));
  }, []);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const yFromBottom = rect.bottom - ev.clientY;
      const maxDrawer = rect.height - MIN_GRID_H - 6; // 6 = handle height
      const clamped = Math.max(MIN_DRAWER_H, Math.min(yFromBottom, maxDrawer));
      setDrawerHeight(clamped);
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div
      ref={containerRef}
      className="flex h-full flex-col bg-panel text-panel-muted"
    >
      <SviAlertBar />
      <ChainLatencyReadout />
      <div className="min-h-0 flex-1">
        <OptionChainGrid
          onCellClicked={onCellClicked}
          activeLegSet={activeLegSet}
        />
      </div>

      <div
        onMouseDown={onMouseDown}
        className="flex h-1.5 shrink-0 cursor-row-resize items-center justify-center bg-panel hover:bg-panel-header active:bg-blue-500/30"
      >
        <div className="h-px w-8 rounded-sm bg-panel-faint" />
      </div>

      <div className="shrink-0 overflow-hidden" style={{ height: drawerHeight }}>
        <InlineOrderDrawer
          isCollapsed={isCollapsed}
          onToggle={toggleDrawer}
        />
      </div>
    </div>
  );
}
