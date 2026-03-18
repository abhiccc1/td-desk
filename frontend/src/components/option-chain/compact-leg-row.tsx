"use client";

import { useCallback, useRef, useState } from "react";
import type { OrderType, StrategyLeg } from "@/types/market-data";
import { getLotSize } from "@/lib/lot-sizes";
import { useMarketDataStore } from "@/stores/market-data-store";
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
  const effectiveLotSize = lotSize > 1 ? lotSize : getLotSize("");

  // Live LTP — targeted selector only re-renders when this strike's LTP changes
  const liveLtp = useMarketDataStore(
    useCallback((s) => {
      const chain = s.optionChain;
      if (!chain || leg.strike <= 0) return 0;
      const row = chain.strikes.find((r) => r.strike === leg.strike);
      if (!row) return 0;
      const tick = leg.optionType === "CE" ? row.call : row.put;
      return tick?.ltp ?? 0;
    }, [leg.strike, leg.optionType]),
  );

  const [editingPremium, setEditingPremium] = useState(false);
  const [editingQty, setEditingQty] = useState(false);

  const handlePremiumBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setEditingPremium(false);
      const val = parseFloat(e.target.value);
      if (!isNaN(val) && val !== leg.premium) {
        onUpdate(index, { premium: val });
      }
    },
    [index, leg.premium, onUpdate],
  );

  const handleQtyBlur = useCallback(
    (e: React.FocusEvent<HTMLInputElement>) => {
      setEditingQty(false);
      const raw = parseInt(e.target.value, 10);
      const quantity = isNaN(raw) || raw <= 0 ? effectiveLotSize : raw;
      const snapped = Math.max(
        effectiveLotSize,
        Math.round(quantity / effectiveLotSize) * effectiveLotSize,
      );
      if (snapped !== leg.quantity) {
        onUpdate(index, { quantity: snapped });
      }
    },
    [index, leg.quantity, onUpdate, effectiveLotSize],
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
      className={`order-leg-row flex items-center gap-2 px-3 py-1 text-sm text-panel-muted ${groupBorder} ${groupBg} ${groupMargin} ${isDragOver ? "border-t-2 border-blue-500" : ""}`}
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

      {editingPremium ? (
        <Input
          type="number"
          defaultValue={leg.premium}
          step={0.05}
          autoFocus
          onBlur={handlePremiumBlur}
          onKeyDown={handleKeyDown}
          className={`order-premium-input h-7 w-20 border-blue-500 bg-panel px-2 text-sm text-panel-muted ${NO_SPINNER}`}
        />
      ) : (
        <span
          className="order-premium-display w-20 cursor-pointer text-right hover:text-blue-400"
          onClick={() => setEditingPremium(true)}
        >
          {leg.premium.toFixed(2)}
        </span>
      )}
      {/* Live LTP — click to snap premium */}
      {liveLtp > 0 && liveLtp !== leg.premium && (
        <span
          className="cursor-pointer text-[10px] text-blue-400 hover:text-blue-300"
          title="Use live LTP"
          onClick={() => onUpdate(index, { premium: liveLtp })}
        >
          {liveLtp.toFixed(2)}
        </span>
      )}

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
            defaultValue={leg.quantity}
            min={effectiveLotSize}
            step={effectiveLotSize}
            autoFocus
            onBlur={handleQtyBlur}
            onKeyDown={handleKeyDown}
            className={`h-7 w-14 rounded-none border-x-0 border-panel-border bg-panel px-0 text-center text-xs text-panel-muted ${NO_SPINNER}`}
          />
        ) : (
          <span
            className="inline-flex h-7 w-14 cursor-pointer items-center justify-center border-y border-panel-border bg-panel text-center text-xs text-panel-muted hover:text-blue-400"
            onClick={() => setEditingQty(true)}
          >
            {leg.quantity}
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
      <span className="shrink-0 text-[10px] text-panel-faint">
        = {Math.round(leg.quantity / effectiveLotSize)}L
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
    </div>
    </>
  );
}
