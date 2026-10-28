"use client";

import { useCallback, useRef, useState } from "react";
import { isFuturesUnderlying } from "@/lib/instruments";
import type { OrderType, StrategyLeg } from "@/types/market-data";
import { getLotSize } from "@/lib/lot-sizes";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OptionTypeBadge, SideBadge } from "@/components/ui/trading-label";

const ORDER_TYPE_OPTIONS: { value: OrderType; label: string }[] = [
  { value: "LIMIT", label: "LMT" },
  { value: "MARKET", label: "MKT" },
  { value: "SL", label: "SL" },
  { value: "SL-M", label: "SL-M" },
];

export interface SpreadGroupInfo {
  type: "call" | "put";
  position: "first" | "middle" | "last";
}

interface CompactLegRowProps {
  leg: StrategyLeg;
  index: number;
  lotSize: number;
  onUpdate: (index: number, update: Partial<StrategyLeg>) => void;
  onRemove: (index: number) => void;
  onStrikeStep: (index: number, direction: 1 | -1) => void;
  onDragStart: (index: number) => void;
  onDragOver: (index: number) => void;
  onDragEnd: () => void;
  isDragOver: boolean;
  spreadGroup: SpreadGroupInfo | null;
}

const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

export function CompactLegRow({
  leg,
  index,
  lotSize,
  onUpdate,
  onRemove,
  onStrikeStep,
  onDragStart,
  onDragOver,
  onDragEnd,
  isDragOver,
  spreadGroup,
}: CompactLegRowProps) {
  const legUnderlying = leg.symbol.split(" ")[0] || "";
  const effectiveLotSize = getLotSize(legUnderlying) || (lotSize > 1 ? lotSize : 1);
  // MCX legs are entered in lots (orders go to the backend as lots); NSE/BSE
  // keep the unit quantity input. leg.quantity stays in units either way.
  const inLots = isFuturesUnderlying(legUnderlying);
  const legLots = Math.round(leg.quantity / effectiveLotSize);

  // Live LTP — try option chain first, fall back to position ticks Map
  const liveLtp = useMarketDataStore(
    useCallback((s) => {
      const chain = s.optionChain;
      if (chain && leg.strike > 0) {
        const row = chain.strikes.find((r) => r.strike === leg.strike);
        if (row) {
          const tick = leg.optionType === "CE" ? row.call : row.put;
          if (tick?.ltp) return tick.ltp;
        }
      }
      // Fall back to ticks Map (position subscriptions, cross-underlying)
      const posTick = s.ticks.get(leg.symbol);
      return posTick?.ltp ?? 0;
    }, [leg.strike, leg.optionType, leg.symbol]),
  );
  useMarketDataStore((s) => s.tickVersion);
  const spotPrice = useMarketDataStore((s) => s.optionChain?.underlyingPrice ?? 0);
  const greeks = useGreeksStore(
    useCallback((s) => s.greeks.get(leg.symbol) ?? null, [leg.symbol]),
  );
  useGreeksStore((s) => s.greeksVersion);

  const [expanded, setExpanded] = useState(false);
  const [editingQty, setEditingQty] = useState(false);

  const handleQtyBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setEditingQty(false);
      const raw = parseInt(e.target.value, 10);
      const entered = isNaN(raw) || raw <= 0 ? (inLots ? 1 : effectiveLotSize) : raw;
      const quantity = inLots ? entered * effectiveLotSize : entered;
      const snapped = Math.max(
        effectiveLotSize,
        Math.round(quantity / effectiveLotSize) * effectiveLotSize,
      );
      if (snapped !== leg.quantity) {
        onUpdate(index, { quantity: snapped });
      }
    },
    [index, leg.quantity, onUpdate, effectiveLotSize, inLots],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        (e.target as HTMLInputElement).blur();
      }
    },
    [],
  );

  const handleQtyIncrement = useCallback(() => {
    onUpdate(index, { quantity: leg.quantity + effectiveLotSize });
  }, [index, leg.quantity, effectiveLotSize, onUpdate]);

  const handleQtyDecrement = useCallback(() => {
    const newQty = Math.max(effectiveLotSize, leg.quantity - effectiveLotSize);
    if (newQty !== leg.quantity) {
      onUpdate(index, { quantity: newQty });
    }
  }, [index, leg.quantity, effectiveLotSize, onUpdate]);

  const rowRef = useRef<HTMLDivElement>(null);

  const handleHandleMouseDown = useCallback(() => {
    if (rowRef.current) rowRef.current.draggable = true;
  }, []);

  const handleHandleMouseUp = useCallback(() => {
    if (rowRef.current) rowRef.current.draggable = false;
  }, []);

  const handleDragStartCb = useCallback(
    (e: React.DragEvent) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
      onDragStart(index);
    },
    [index, onDragStart],
  );

  const handleDragOverCb = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      onDragOver(index);
    },
    [index, onDragOver],
  );

  const handleDragEndCb = useCallback(() => {
    if (rowRef.current) rowRef.current.draggable = false;
    onDragEnd();
  }, [onDragEnd]);

  // Spread group styling
  let groupBorder = "";
  let groupBg = "";
  let groupMargin = "";
  if (spreadGroup) {
    const color = spreadGroup.type === "call" ? "border-l-blue-400/60" : "border-l-violet-400/60";
    const bg = spreadGroup.type === "call" ? "bg-blue-500/[0.04]" : "bg-violet-500/[0.04]";
    groupBorder = `border-l-2 ${color}`;
    groupBg = bg;
    if (spreadGroup.position === "last") {
      groupMargin = "mb-1";
    }
  }

  return (
    <>
    <div
      ref={rowRef}
      className={`order-leg-row flex items-center gap-1.5 text-sm text-panel-muted ${groupBorder} ${groupBg} ${groupMargin} ${isDragOver ? "border-t-2 border-blue-500" : ""}`}
      style={{ padding: "8px 10px" }}
      onDragStart={handleDragStartCb}
      onDragOver={handleDragOverCb}
      onDragEnd={handleDragEndCb}
    >
      {/* Drag handle */}
      <span
        className="order-drag-handle shrink-0 cursor-grab select-none text-panel-faint active:cursor-grabbing"
        onMouseDown={handleHandleMouseDown}
        onMouseUp={handleHandleMouseUp}
      >
        ⠿
      </span>
      {/* Underlying + expiry */}
      <span className="flex w-24 shrink-0 items-center gap-1">
        <span className="text-[11px] font-medium text-panel-muted">
          {leg.symbol.split(" ")[0] || "—"}
        </span>
        {(() => {
          const parts = leg.symbol.split(" ");
          if (parts.length >= 2 && /^\d{6}$/.test(parts[1])) {
            const raw = parts[1];
            const d = new Date(`20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}T00:00:00Z`);
            const label = !Number.isNaN(d.getTime())
              ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase()
              : raw;
            return (
              <span className="rounded bg-orange-500/10 px-1 py-0.5 text-[9px] font-semibold text-orange-300">
                {label}
              </span>
            );
          }
          return null;
        })()}
      </span>

      {/* BUY/SELL toggle */}
      <Button
        variant="ghost"
        size="xs"
        onClick={() => onUpdate(index, { side: leg.side === "BUY" ? "SELL" : "BUY" })}
        className="h-7 w-auto px-0.5"
        title={`Click to switch to ${leg.side === "BUY" ? "SELL" : "BUY"}`}
      >
        <SideBadge side={leg.side} className="min-w-[3.25rem] justify-center px-2 py-0.5 text-[11px]" />
      </Button>

      {/* CE/PE toggle */}
      <Button
        variant="ghost"
        size="xs"
        onClick={() => onUpdate(index, { optionType: leg.optionType === "CE" ? "PE" : "CE" })}
        className="h-7 w-auto px-0.5"
        title={`Click to switch to ${leg.optionType === "CE" ? "PE" : "CE"}`}
      >
        <OptionTypeBadge optionType={leg.optionType} className="min-w-[2.75rem] justify-center px-2 py-0.5 text-[11px]" />
      </Button>

      {/* Strike with +/- steppers — same input group style as lots */}
      <div className="flex items-center">
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onStrikeStep(index, -1)}
          title="Lower strike"
          className="h-7 w-7 rounded-r-none border-panel-border bg-panel"
        >
          −
        </Button>
        <span className="inline-flex h-7 w-20 items-center justify-center border-y border-panel-border bg-panel text-center text-xs font-medium text-yellow-300">
          {leg.strike}
        </span>
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onStrikeStep(index, 1)}
          title="Higher strike"
          className="h-7 w-7 rounded-l-none border-panel-border bg-panel"
        >
          +
        </Button>
      </div>

      <span className="text-panel-faint">@</span>

      <div className="flex items-center">
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onUpdate(index, { premium: Math.max(0, Number((leg.premium - 0.05).toFixed(2))) })}
          className="h-7 w-7 rounded-r-none border-panel-border bg-panel"
        >
          −
        </Button>
        <Input
          type="number"
          value={leg.premium}
          step={0.05}
          min={0}
          onChange={(e) => {
            const val = parseFloat(e.target.value);
            if (!isNaN(val)) onUpdate(index, { premium: val });
          }}
          className={`h-7 w-14 rounded-none border-x-0 border-panel-border bg-panel px-0 text-center text-xs text-panel-muted ${NO_SPINNER}`}
        />
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onUpdate(index, { premium: Number((leg.premium + 0.05).toFixed(2)) })}
          className="h-7 w-7 rounded-l-none border-panel-border bg-panel"
        >
          +
        </Button>
      </div>
      {/* Live LTP — click to snap premium */}
      <span
        className={`w-14 text-center text-[10px] ${liveLtp > 0 ? (liveLtp === leg.premium ? "cursor-pointer text-green-400" : "cursor-pointer text-blue-400 hover:text-blue-300") : "text-panel-dim"}`}
        title={liveLtp > 0 ? "Use live LTP" : ""}
        onClick={liveLtp > 0 ? () => onUpdate(index, { premium: liveLtp }) : undefined}
      >
        {liveLtp > 0 ? liveLtp.toFixed(2) : "—"}
      </span>

      <span className="text-panel-faint">x</span>

      {/* Quantity stepper */}
      <div className="flex items-center">
        <Button
          variant="outline"
          size="icon-xs"
          onClick={handleQtyDecrement}
          title="Decrease quantity"
          className="h-7 w-7 rounded-r-none border-panel-border bg-panel"
        >
          −
        </Button>
        {editingQty ? (
          <Input
            type="number"
            defaultValue={inLots ? legLots : leg.quantity}
            min={inLots ? 1 : effectiveLotSize}
            step={inLots ? 1 : effectiveLotSize}
            autoFocus
            onBlur={handleQtyBlur}
            onKeyDown={handleKeyDown}
            className={`h-7 w-14 rounded-none border-x-0 border-panel-border bg-panel px-0 text-center text-xs text-panel-muted ${NO_SPINNER}`}
          />
        ) : (
          <span
            className="inline-flex h-7 w-14 cursor-pointer items-center justify-center border-y border-panel-border bg-panel text-center text-xs text-panel-muted hover:text-blue-400"
            onClick={() => setEditingQty(true)}
            title={inLots ? `${legLots} lot(s) = ${leg.quantity} units` : undefined}
          >
            {inLots ? legLots : leg.quantity}
          </span>
        )}
        <Button
          variant="outline"
          size="icon-xs"
          onClick={handleQtyIncrement}
          title="Increase quantity"
          className="h-7 w-7 rounded-l-none border-panel-border bg-panel"
        >
          +
        </Button>
      </div>
      <span className="-ml-1 w-8 shrink-0 text-center text-[10px] text-panel-faint">
        {inLots ? "lots" : `=${legLots}L`}
      </span>

      {/* Per-leg order type */}
      <SegmentedControl
        value={leg.orderType}
        onValueChange={(value) => onUpdate(index, { orderType: value })}
        options={ORDER_TYPE_OPTIONS}
        itemClassName="text-[11px] text-panel-faint hover:text-panel-muted"
      />

      <Button variant="ghost" size="icon-xs" onClick={() => onRemove(index)} title="Remove leg"
        className="ml-auto text-white hover:bg-red-500/15 hover:text-red-400">
        <svg viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" className="size-3.5">
          <path d="M1 4h1.333m0 0H13M2.333 4v9.333a1.333 1.333 0 001.334 1.334h6.666a1.333 1.333 0 001.334-1.334V4H2.333zm2 0V2.667a1.333 1.333 0 011.334-1.334h2.666a1.333 1.333 0 011.334 1.334V4M5.667 7.333v4M8.333 7.333v4" stroke="currentColor" strokeWidth="1.33" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </Button>

      {/* Expand chevron */}
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className={`shrink-0 cursor-pointer text-panel-dim transition-transform ${expanded ? "rotate-90" : ""}`}
        onClick={() => setExpanded((p) => !p)}
      >
        <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>

    {/* Expanded detail row */}
    {expanded && (
      <LegDetailRow
        leg={leg}
        liveLtp={liveLtp}
        greeks={greeks}
        spotPrice={spotPrice}
      />
    )}
    </>
  );
}

function LegDetailRow({
  leg,
  liveLtp,
  greeks,
  spotPrice,
}: {
  leg: StrategyLeg;
  liveLtp: number;
  greeks: { delta: number; iv: number } | null;
  spotPrice: number;
}) {
  const offset = leg.strike > 0 && spotPrice > 0 ? leg.strike - spotPrice : null;
  const moneyness =
    offset === null
      ? null
      : leg.optionType === "CE"
        ? leg.strike > spotPrice ? "OTM" : leg.strike < spotPrice ? "ITM" : "ATM"
        : leg.strike < spotPrice ? "OTM" : leg.strike > spotPrice ? "ITM" : "ATM";

  let pnlPct: number | null = null;
  if (leg.premium > 0 && liveLtp > 0) {
    pnlPct =
      ((liveLtp - leg.premium) / leg.premium) * 100 * (leg.side === "BUY" ? 1 : -1);
  }

  const offsetClass = offset !== null && offset >= 0 ? "text-orange-400" : "text-cyan-400";
  const pnlColor =
    pnlPct == null
      ? "text-panel-strong"
      : pnlPct > 0
        ? "text-green-400"
        : pnlPct < 0
          ? "text-red-400"
          : "text-panel-strong";

  // Parse expiry from symbol parts: "NIFTY 260319 22000 CE" → "260319"
  const parts = leg.symbol.split(" ");
  let expiryLabel: string | null = null;
  if (parts.length >= 2 && /^\d{6}$/.test(parts[1])) {
    const raw = parts[1];
    const d = new Date(`20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}T00:00:00Z`);
    expiryLabel = !Number.isNaN(d.getTime())
      ? d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase()
      : raw;
  }

  return (
    <div className="flex items-center gap-4 border-b border-panel-border/50 bg-panel-header/50 px-3 py-1.5 pl-8 text-[11px]">
      <span className="text-panel-quiet">
        Delta <span className="text-panel-strong">{greeks ? greeks.delta.toFixed(3) : "—"}</span>
      </span>
      <span className="text-panel-quiet">
        IV <span className="text-panel-strong">{greeks ? `${(greeks.iv * 100).toFixed(1)}%` : "—"}</span>
      </span>
      {expiryLabel && (
        <span className="text-panel-quiet">
          Expiry{" "}
          <Badge variant="secondary" className="bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
            {expiryLabel}
          </Badge>
        </span>
      )}
      {offset !== null && (
        <span className="text-panel-quiet">
          Offset{" "}
          <span className={offsetClass}>
            {offset >= 0 ? "+" : ""}{Math.round(offset)} ({moneyness})
          </span>
        </span>
      )}
      <span className="text-panel-quiet">
        P&amp;L%{" "}
        <span className={pnlColor}>
          {pnlPct == null ? "—" : `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`}
        </span>
      </span>
    </div>
  );
}
