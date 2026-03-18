"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { fetchMarginPreview, fetchPositions, placeOrders } from "@/lib/api-client";
import type { MarginPreviewResult, PlaceOrderLeg } from "@/lib/api-client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OptionTypeBadge, SideBadge } from "@/components/ui/trading-label";
import { usePositionStore } from "@/stores/position-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { Position } from "@/types/orders";
import type { ProductType } from "@/types/market-data";

type ActionDialog = "modify" | "sl" | "convert" | null;
type ModifyMode = "exit" | "add";

interface StagedPositionPlan {
  exitLabel?: string;
  stopLossLabel?: string;
  convertTo?: ProductType;
}


const STOP_LOSS_MODE_OPTIONS: { value: "SL" | "SL-M"; label: string }[] = [
  { value: "SL", label: "SL" },
  { value: "SL-M", label: "SL-M" },
];

const STOP_LOSS_BASIS_OPTIONS: { value: "ltp" | "cost"; label: string }[] = [
  { value: "ltp", label: "LTP" },
  { value: "cost", label: "Cost" },
];

const PRODUCT_TYPE_OPTIONS: { value: ProductType; label: string }[] = [
  { value: "NRML", label: "NRML" },
  { value: "MIS", label: "MIS" },
];

function parseSymbol(pos: Position): {
  underlying: string;
  strike: number;
  optionType: string;
  expiry: string;
} {
  // Use Kotak fields if available, otherwise parse from symbol string
  if (pos.optionType && pos.strikePrice) {
    const sym = pos.tradingSymbol || pos.symbol;
    // Extract underlying from trdSym like "NIFTY17MAR23100CE" → "NIFTY"
    const underlying = sym.replace(/\d.*/, "");
    return {
      underlying: underlying || pos.symbol,
      strike: Number(pos.strikePrice) || 0,
      optionType: pos.optionType === "CE" ? "CE" : pos.optionType === "PE" ? "PE" : pos.optionType,
      expiry: pos.expiry || "",
    };
  }
  // Fallback: parse "NIFTY 260317 23100 CE"
  const parts = pos.symbol.split(" ");
  if (parts.length === 4) {
    const raw = parts[1];
    const expiry = `20${raw.slice(0, 2)}-${raw.slice(2, 4)}-${raw.slice(4, 6)}`;
    return { underlying: parts[0], strike: Number(parts[2]), optionType: parts[3], expiry };
  }
  return { underlying: pos.symbol, strike: 0, optionType: "", expiry: "" };
}

function formatExpiry(iso: string): string {
  if (!iso) return "";
  const value = iso.trim();

  const isoMatch = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoMatch) {
    const d = new Date(`${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase();
    }
  }

  const brokerMatch = value.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})$/);
  if (brokerMatch) {
    const day = brokerMatch[1].padStart(2, "0");
    const month = brokerMatch[2].toUpperCase();
    return `${day} ${month}`;
  }

  const parsed = new Date(value);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }).toUpperCase();
  }

  return value.toUpperCase();
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function PositionRow({
  pos,
  checked,
  onCheck,
  plan,
}: {
  pos: Position;
  checked: boolean;
  onCheck: (sym: string, val: boolean) => void;
  plan?: StagedPositionPlan;
}) {
  const [expanded, setExpanded] = useState(false);
  const greeksMap = useGreeksStore((s) => s.greeks);
  const spotPrice = useMarketDataStore(
    (s) => s.optionChain?.underlyingPrice ?? 0,
  );
  const chain = useMarketDataStore((s) => s.optionChain);

  const parsed = parseSymbol(pos);
  const greeks = greeksMap.get(pos.symbol);
  const isOpen = (pos as Record<string, unknown>).isOpen !== false;
  const optionTypeTag =
    parsed.optionType === "CE" || parsed.optionType === "PE"
      ? parsed.optionType
      : null;

  // Find live LTP from option chain (only for open positions whose expiry matches)
  let liveLtp = pos.ltp;
  if (isOpen && chain && parsed.strike > 0 && chain.expiry === parsed.expiry) {
    const strikeRow = chain.strikes.find((s) => s.strike === parsed.strike);
    if (strikeRow) {
      const tick = parsed.optionType === "CE" ? strikeRow.call : strikeRow.put;
      if (tick && tick.ltp > 0) liveLtp = tick.ltp;
    }
  }

  const bookedPnl = (pos as Record<string, unknown>).bookedPnl as number | undefined ?? 0;
  const adj = (pos as Record<string, unknown>).multiplier as number | undefined ?? 1;
  // For closed positions: pnl = bookedPnl (netQty is 0). For open: bookedPnl + mtm.
  const pnl = isOpen ? bookedPnl + (pos.quantity * liveLtp * adj) : bookedPnl;
  const pnlPct =
    pos.avgPrice !== 0 && liveLtp > 0 && isOpen
      ? ((liveLtp - pos.avgPrice) / pos.avgPrice) * 100 * (pos.quantity > 0 ? 1 : -1)
      : 0;
  const pnlColor =
    pnl > 0 ? "text-green-400" : pnl < 0 ? "text-red-400" : "text-panel-muted";
  const qtyDisplay = pos.quantity;
  const dimmed = !isOpen;

  return (
    <>
      <div
        className={`flex cursor-pointer items-center border-b border-panel-border/50 px-3 py-2.5 transition-colors hover:bg-panel-hover/40 ${dimmed ? "opacity-45" : ""}`}
        onClick={() => setExpanded((p) => !p)}
      >
        {/* Checkbox for open positions */}
        {isOpen && (
          <Checkbox
            checked={checked}
            onCheckedChange={(val) => onCheck(pos.symbol, !!val)}
            onClick={(e) => e.stopPropagation()}
            className="mr-2 h-3.5 w-3.5 shrink-0 border-panel-dim data-[state=checked]:border-blue-500 data-[state=checked]:bg-blue-500"
          />
        )}

        {/* Name column */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className={`text-sm font-medium ${dimmed ? "text-panel-faint" : "text-panel-muted"}`}>
            {parsed.underlying}
          </span>
          {parsed.strike > 0 && optionTypeTag && (
            <div className="inline-flex items-center gap-1">
              <span className="text-[10px] font-bold text-panel-subtle">{parsed.strike}</span>
              <OptionTypeBadge optionType={optionTypeTag} />
              {parsed.expiry && (
                <Badge variant="secondary" className="bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                  {formatExpiry(parsed.expiry)}
                </Badge>
              )}
            </div>
          )}
          {plan?.exitLabel && (
            <Badge variant="secondary" className="bg-amber-500/15 text-amber-300">
              {plan.exitLabel}
            </Badge>
          )}
          {plan?.stopLossLabel && (
            <Badge variant="secondary" className="bg-red-500/15 text-red-300">
              {plan.stopLossLabel}
            </Badge>
          )}
          {plan?.convertTo && (
            <Badge variant="secondary" className="bg-cyan-500/15 text-cyan-300">
              TO {plan.convertTo}
            </Badge>
          )}
        </div>

        {/* Type */}
        <span className="w-16 text-center text-xs text-panel-subtle">{pos.productType || "NRML"}</span>

        {/* Quantity */}
        <span
          className={`w-20 text-right text-sm font-medium ${qtyDisplay < 0 ? "text-red-400" : "text-panel-muted"}`}
        >
          {qtyDisplay}
        </span>

        {/* Avg Cost */}
        <span className="w-20 text-right text-sm text-panel-muted">
          {pos.avgPrice.toFixed(2)}
        </span>

        {/* LTP */}
        <span className="w-20 text-right text-sm text-panel-muted">
          {liveLtp.toFixed(2)}
        </span>

        {/* P&L */}
        <span className={`w-28 text-right text-sm font-semibold ${pnlColor}`}>
          {pnl >= 0 ? "+" : ""}
          {pnl.toLocaleString("en-IN", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
        </span>

        {/* Expand chevron */}
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          className={`ml-2 shrink-0 text-panel-dim transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          <path
            d="M6 4l4 4-4 4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>

      {/* Expanded detail row — same style as compact-leg-row */}
      {expanded && (
        <div className="flex items-center gap-4 border-b border-panel-border/50 bg-panel-header/50 px-3 py-1.5 text-[11px]">
          <span className="ml-2 text-panel-quiet">
            Delta{" "}
            <span className="text-panel-strong">
              {greeks ? greeks.delta.toFixed(3) : "—"}
            </span>
          </span>
          <span className="text-panel-quiet">
            IV{" "}
            <span className="text-panel-strong">
              {greeks ? `${(greeks.iv * 100).toFixed(1)}%` : "—"}
            </span>
          </span>
          <span className="text-panel-quiet">
            Expiry{" "}
            {parsed.expiry ? (
              <Badge variant="secondary" className="bg-orange-500/10 px-1.5 py-0.5 text-[10px] font-semibold text-orange-300">
                {formatExpiry(parsed.expiry)}
              </Badge>
            ) : (
              <span className="text-panel-strong">—</span>
            )}
          </span>
          <span className="text-panel-quiet">
            Offset{" "}
            {spotPrice > 0 && parsed.strike > 0 ? (
              <span
                className={
                  parsed.strike >= spotPrice
                    ? "text-orange-400"
                    : "text-cyan-400"
                }
              >
                {parsed.strike >= spotPrice ? "+" : ""}
                {parsed.strike - spotPrice}
                {" "}
                ({parsed.optionType === "CE"
                  ? parsed.strike > spotPrice
                    ? "OTM"
                    : parsed.strike < spotPrice
                      ? "ITM"
                      : "ATM"
                  : parsed.strike < spotPrice
                    ? "OTM"
                    : parsed.strike > spotPrice
                      ? "ITM"
                      : "ATM"})
              </span>
            ) : (
              <span className="text-panel-strong">—</span>
            )}
          </span>
          <span className="text-panel-quiet">
            P&L%{" "}
            <span className={pnlColor}>
              {pnlPct >= 0 ? "+" : ""}
              {pnlPct.toFixed(2)}%
            </span>
          </span>
        </div>
      )}
    </>
  );
}

function useLiveTotalUnrealized(positions: Position[]): number {
  const chain = useMarketDataStore((s) => s.optionChain);
  let total = 0;
  for (const pos of positions) {
    // Only compute unrealized for open positions
    if ((pos as Record<string, unknown>).isOpen === false) continue;

    const parsed = parseSymbol(pos);
    let ltp = pos.ltp;
    if (chain && parsed.strike > 0 && chain.expiry === parsed.expiry) {
      const strikeRow = chain.strikes.find((s) => s.strike === parsed.strike);
      if (strikeRow) {
        const tick = parsed.optionType === "CE" ? strikeRow.call : strikeRow.put;
        if (tick && tick.ltp > 0) ltp = tick.ltp;
      }
    }
    const bookedPnl = (pos as Record<string, unknown>).bookedPnl as number | undefined ?? 0;
    const adj = (pos as Record<string, unknown>).multiplier as number | undefined ?? 1;
    total += bookedPnl + (pos.quantity * ltp * adj);
  }
  return total;
}

export function PositionMonitor() {
  const positions = usePositionStore((s) => s.positions);
  const realizedPnl = usePositionStore((s) => s.realizedPnl);
  const feedMode = useMarketDataStore((s) => s.feedMode);
  const liveUnrealized = useLiveTotalUnrealized(positions);
  const totalPnl = liveUnrealized + realizedPnl;

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const openSymbols = useMemo(
    () => positions.filter((p) => (p as Record<string, unknown>).isOpen !== false).map((p) => p.symbol),
    [positions],
  );
  const allSelected = openSymbols.length > 0 && openSymbols.every((s) => selected.has(s));
  const someSelected = selected.size > 0;

  const handleCheck = useCallback((sym: string, val: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (val) next.add(sym); else next.delete(sym);
      return next;
    });
  }, []);

  const [showSquareOffDialog, setShowSquareOffDialog] = useState(false);
  const [isPlacingOrders, setIsPlacingOrders] = useState(false);
  const [placeOrderError, setPlaceOrderError] = useState<string | null>(null);

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(openSymbols));
    }
  }, [allSelected, openSymbols]);

  const selectedPositions = useMemo(
    () => positions.filter((p) => selected.has(p.symbol)),
    [positions, selected],
  );
  const [activeActionDialog, setActiveActionDialog] = useState<ActionDialog>(null);
  const [modifyMode, setModifyMode] = useState<ModifyMode>("exit");

  // Per-leg overrides for modify dialog
  interface LegOverride { side: "BUY" | "SELL"; qty: number; orderType: "MARKET" | "LIMIT"; price: number }
  const [legOverrides, setLegOverrides] = useState<Record<string, LegOverride>>({});
  const [modifyMargin, setModifyMargin] = useState<MarginPreviewResult | null>(null);
  const [isLoadingModifyMargin, setIsLoadingModifyMargin] = useState(false);
  const [stopLossMode, setStopLossMode] = useState<"SL" | "SL-M">("SL-M");
  const [stopLossBasis, setStopLossBasis] = useState<"ltp" | "cost">("ltp");
  const [stopLossBufferPct, setStopLossBufferPct] = useState(12);
  const [convertTarget, setConvertTarget] = useState<ProductType>("NRML");
  const [stagedPlans, setStagedPlans] = useState<Record<string, StagedPositionPlan>>({});
  const selectedExposure = useMemo(
    () =>
      selectedPositions.reduce(
        (total, pos) => total + Math.abs(pos.quantity) * Math.max(pos.ltp, pos.avgPrice, 0),
        0,
      ),
    [selectedPositions],
  );
  const selectedLivePnl = useMemo(
    () =>
      selectedPositions.reduce((total, pos) => {
        const bookedPnl =
          ((pos as Record<string, unknown>).bookedPnl as number | undefined) ?? 0;
        const adj =
          ((pos as Record<string, unknown>).multiplier as number | undefined) ?? 1;
        return total + bookedPnl + pos.quantity * pos.ltp * adj;
      }, 0),
    [selectedPositions],
  );
  // Tick version drives LTP refresh inside the dialog without subscribing to full chain
  const tickVersion = useMarketDataStore((s) => s.tickVersion);
  const modifyPreview = useMemo(
    () =>
      selectedPositions.map((pos) => {
        const parsed = parseSymbol(pos);
        const lot = Math.max(pos.lotSize ?? 1, 1);
        const override = legOverrides[pos.symbol];
        const side = override?.side ?? (pos.quantity > 0 ? "SELL" : "BUY");
        const qty = override?.qty ?? lot;
        const orderType = override?.orderType ?? "MARKET" as "MARKET" | "LIMIT";
        const price = override?.price ?? 0;

        // Resolve live LTP from option chain snapshot
        let ltp = pos.ltp;
        const chain = useMarketDataStore.getState().optionChain;
        if (chain && parsed.strike > 0 && chain.expiry === parsed.expiry) {
          const strikeRow = chain.strikes.find((s) => s.strike === parsed.strike);
          if (strikeRow) {
            const tick = parsed.optionType === "CE" ? strikeRow.call : strikeRow.put;
            if (tick && tick.ltp > 0) ltp = tick.ltp;
          }
        }

        return {
          symbol: pos.symbol,
          underlying: parsed.underlying,
          strike: parsed.strike,
          optionType:
            parsed.optionType === "CE" || parsed.optionType === "PE"
              ? parsed.optionType
              : null,
          side,
          qty,
          orderType,
          price,
          ltp,
          lot,
          productType: pos.productType || "NRML",
        };
      }),
    // tickVersion triggers recompute so LTP stays fresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedPositions, legOverrides, tickVersion],
  );
  const stopLossPreview = useMemo(
    () =>
      selectedPositions.map((pos) => {
        const reference = stopLossBasis === "cost" ? pos.avgPrice : pos.ltp;
        const trigger =
          pos.quantity > 0
            ? reference * (1 - stopLossBufferPct / 100)
            : reference * (1 + stopLossBufferPct / 100);
        return {
          symbol: pos.symbol,
          reference,
          trigger,
          direction: pos.quantity > 0 ? "below" : "above",
        };
      }),
    [selectedPositions, stopLossBasis, stopLossBufferPct],
  );
  const convertiblePositions = useMemo(
    () =>
      selectedPositions.filter(
        (pos) => (pos.productType || "NRML") !== convertTarget,
      ),
    [selectedPositions, convertTarget],
  );

  const handlePlaceModifyOrders = useCallback(async () => {
    setIsPlacingOrders(true);
    setPlaceOrderError(null);
    try {
      const orderLegs: PlaceOrderLeg[] = modifyPreview.map((item) => {
        const pos = selectedPositions.find((p) => p.symbol === item.symbol);
        return {
          tradingSymbol: pos?.tradingSymbol || undefined,
          underlying: item.underlying || undefined,
          expiry: pos?.expiry || undefined,
          strike: item.strike || undefined,
          optionType: item.optionType || undefined,
          transactionType: (item.side === "BUY" ? "B" : "S") as "B" | "S",
          quantity: item.qty,
          orderType: (item.orderType === "LIMIT" ? "L" : "MKT") as "L" | "MKT",
          product: item.productType as "NRML" | "MIS",
          price: item.orderType === "LIMIT" ? item.price : undefined,
        };
      });
      const results = await placeOrders(orderLegs);
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        setPlaceOrderError(failures.map((f) => `Leg ${f.index + 1}: ${f.error}`).join("; "));
      } else {
        setActiveActionDialog(null);
      }
    } catch (error) {
      setPlaceOrderError(error instanceof Error ? error.message : "Order placement failed");
    } finally {
      setIsPlacingOrders(false);
    }
  }, [selectedPositions, modifyPreview]);

  const stageStopLossPlan = useCallback(() => {
    const label = `${stopLossMode} ${stopLossBufferPct}%`;
    setStagedPlans((prev) => {
      const next = { ...prev };
      selectedPositions.forEach((pos) => {
        next[pos.symbol] = { ...next[pos.symbol], stopLossLabel: label };
      });
      return next;
    });
    setActiveActionDialog(null);
  }, [selectedPositions, stopLossMode, stopLossBufferPct]);

  const stageConvertPlan = useCallback(() => {
    setStagedPlans((prev) => {
      const next = { ...prev };
      convertiblePositions.forEach((pos) => {
        next[pos.symbol] = { ...next[pos.symbol], convertTo: convertTarget };
      });
      return next;
    });
    setActiveActionDialog(null);
  }, [convertiblePositions, convertTarget]);

  // Fetch positions once on mount — streaming updates arrive via WebSocket
  useEffect(() => {
    if (feedMode !== "broker") return;
    let cancelled = false;

    async function initialFetch() {
      try {
        const data = await fetchPositions();
        if (cancelled) return;
        if (data && typeof data === "object" && !Array.isArray(data)) {
          const { positions: pos, realizedPnl } = data as { positions: (Position & { isOpen?: boolean })[]; realizedPnl: number };
          if (Array.isArray(pos)) {
            const sorted = [...pos].sort((a, b) => {
              const aOpen = a.isOpen !== false ? 0 : 1;
              const bOpen = b.isOpen !== false ? 0 : 1;
              return aOpen - bOpen;
            });
            usePositionStore.getState().setPositions(sorted);
          }
          if (typeof realizedPnl === "number") {
            usePositionStore.getState().setRealizedPnl(realizedPnl);
          }
        } else if (Array.isArray(data)) {
          usePositionStore.getState().setPositions(data);
        }
      } catch {
        // Will be populated by WebSocket stream
      }
    }

    initialFetch();
    return () => { cancelled = true; };
  }, [feedMode]);

  const unrealColor = liveUnrealized > 0 ? "text-green-400" : liveUnrealized < 0 ? "text-red-400" : "text-panel-muted";
  const realColor = realizedPnl > 0 ? "text-green-400" : realizedPnl < 0 ? "text-red-400" : "text-panel-muted";
  const totalColor = totalPnl > 0 ? "text-green-400" : totalPnl < 0 ? "text-red-400" : "text-panel-muted";

  return (
    <div className="flex h-full flex-col bg-panel text-panel-muted">
      {/* Summary bar */}
      <div className="flex shrink-0 items-center gap-5 border-b border-panel-border px-3 py-2">
        <div>
          <div className="text-[10px] text-panel-faint">P&L</div>
          <div className={`text-sm font-bold ${totalColor}`}>
            {totalPnl >= 0 ? "+" : ""}
            {totalPnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-panel-faint">Unrealised</div>
          <div className={`text-sm font-bold ${unrealColor}`}>
            {liveUnrealized >= 0 ? "+" : ""}
            {liveUnrealized.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div>
          <div className="text-[10px] text-panel-faint">Realised</div>
          <div className={`text-sm font-bold ${realColor}`}>
            {realizedPnl >= 0 ? "+" : ""}
            {realizedPnl.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="ml-auto text-left">
          <div className="text-[10px] text-panel-faint">Positions</div>
          <div className="text-xs font-medium">
            {positions.filter((p) => (p as Record<string, unknown>).isOpen !== false).length} open
            <span className="text-panel-dim"> / {positions.length}</span>
          </div>
        </div>
      </div>

      {/* Header row */}
      <div className="flex shrink-0 items-center border-b border-panel-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wider text-panel-dim">
        <Checkbox
          checked={allSelected}
          onCheckedChange={handleSelectAll}
          className="mr-2 h-3.5 w-3.5 shrink-0 border-panel-dim data-[state=checked]:border-blue-500 data-[state=checked]:bg-blue-500"
        />
        <div className="flex-1">Name</div>
        <span className="w-16 text-center">Type</span>
        <span className="w-20 text-right">Qty</span>
        <span className="w-20 text-right">Avg.cost</span>
        <span className="w-20 text-right">LTP</span>
        <span className="w-28 text-right">Profit/loss</span>
        <span className="w-5" />
      </div>

      {/* Square off bar — visible when positions are selected */}
      {someSelected && (
        <div className="flex shrink-0 items-center justify-between border-b border-panel-border bg-panel-surface px-3 py-2">
          <div className="flex items-center gap-4">
            <span className="text-xs text-panel-subtle">
              {selected.size} position{selected.size > 1 ? "s" : ""} selected
            </span>
            <span className="text-xs text-panel-faint">
              Exposure <span className="font-medium text-panel-muted">{formatAmount(selectedExposure)}</span>
            </span>
            <span className="text-xs text-panel-faint">
              Live P&amp;L{" "}
              <span className={selectedLivePnl >= 0 ? "font-medium text-green-400" : "font-medium text-red-400"}>
                {selectedLivePnl >= 0 ? "+" : ""}{formatAmount(selectedLivePnl)}
              </span>
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="xs"
              className="border-amber-600/40 text-amber-300 hover:bg-amber-500/10"
              onClick={() => {
                const overrides: Record<string, LegOverride> = {};
                selectedPositions.forEach((pos) => {
                  const lot = Math.max(pos.lotSize ?? 1, 1);
                  overrides[pos.symbol] = {
                    side: pos.quantity > 0 ? "SELL" : "BUY",
                    qty: lot,
                    orderType: "MARKET",
                    price: 0,
                  };
                });
                setLegOverrides(overrides);
                setModifyMode("exit");
                setModifyMargin(null);
                setActiveActionDialog("modify");
              }}
            >
              Modify
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="border-red-600/40 text-red-300 hover:bg-red-500/10"
              onClick={() => setActiveActionDialog("sl")}
            >
              Add SL
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="border-cyan-600/40 text-cyan-300 hover:bg-cyan-500/10"
              onClick={() => setActiveActionDialog("convert")}
            >
              Convert
            </Button>
            <Button
              size="xs"
              className="bg-red-600 text-white hover:bg-red-700"
              onClick={() => setShowSquareOffDialog(true)}
            >
              Square Off
            </Button>
          </div>
        </div>
      )}

      {/* Position rows */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {positions.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-panel-dim">No positions</span>
          </div>
        ) : (
          positions.map((pos) => (
            <PositionRow
              key={pos.symbol}
              pos={pos}
              checked={selected.has(pos.symbol)}
              onCheck={handleCheck}
              plan={stagedPlans[pos.symbol]}
            />
          ))
        )}
      </div>

      <Dialog
        open={activeActionDialog === "modify"}
        onOpenChange={(open) => { setActiveActionDialog(open ? "modify" : null); if (!open) { setPlaceOrderError(null); setModifyMargin(null); } }}
      >
        <DialogContent className="border-panel-border bg-panel text-panel-muted sm:max-w-xl">
          <DialogHeader>
            <DialogTitle className="text-amber-300">Modify Positions</DialogTitle>
            <DialogDescription className="text-panel-subtle">
              {modifyMode === "exit" ? "Close part of" : "Add to"} the selected positions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Mode toggle */}
            <SegmentedControl
              value={modifyMode}
              onValueChange={(v) => {
                setModifyMode(v as ModifyMode);
                setModifyMargin(null);
                const overrides: Record<string, LegOverride> = {};
                selectedPositions.forEach((pos) => {
                  const lot = Math.max(pos.lotSize ?? 1, 1);
                  overrides[pos.symbol] = {
                    side: v === "exit" ? (pos.quantity > 0 ? "SELL" : "BUY") : (pos.quantity > 0 ? "BUY" : "SELL"),
                    qty: lot,
                    orderType: "MARKET",
                    price: 0,
                  };
                });
                setLegOverrides(overrides);
              }}
              options={[
                { value: "exit", label: "Partial Exit" },
                { value: "add", label: "Add More" },
              ]}
              fullWidth
            />

            {/* Per-leg editor */}
            <div className="rounded-md border border-panel-border bg-panel-surface">
              <div className="grid grid-cols-[1fr_auto_100px_auto_90px] gap-1.5 border-b border-panel-border px-3 py-2 text-[10px] uppercase tracking-wider text-panel-faint">
                <span>Instrument</span>
                <span>Side</span>
                <span className="text-center">Qty</span>
                <span className="text-center">Type</span>
                <span className="text-right">Price</span>
              </div>
              <div className="max-h-60 overflow-y-auto">
                {modifyPreview.map((item) => (
                  <div key={item.symbol} className="grid grid-cols-[1fr_auto_100px_auto_90px] items-center gap-1.5 border-b border-panel-border/30 px-3 py-1.5">
                    {/* Instrument + side badge */}
                    <div className="flex items-center gap-1.5 overflow-hidden">
                      <span className="truncate text-xs font-medium text-panel-muted">{item.underlying}</span>
                      {item.strike > 0 && item.optionType && (
                        <div className="inline-flex shrink-0 items-center gap-1">
                          <span className="text-[10px] font-bold text-panel-subtle">{item.strike}</span>
                          <OptionTypeBadge optionType={item.optionType as "CE" | "PE"} className="px-1 py-0.5" />
                        </div>
                      )}
                    </div>
                    {/* Side — fixed by mode */}
                    <SideBadge side={item.side} />
                    {/* Qty stepper */}
                    <div className="flex items-center justify-center">
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className="h-7 w-7 rounded-r-none border-panel-border bg-panel"
                        onClick={() => {
                          setLegOverrides((prev) => ({
                            ...prev,
                            [item.symbol]: { ...prev[item.symbol], qty: Math.max(item.lot, item.qty - item.lot) },
                          }));
                        }}
                      >
                        −
                      </Button>
                      <span className="inline-flex h-7 w-12 items-center justify-center border-y border-panel-border bg-panel text-center text-xs text-panel-muted">
                        {item.qty}
                      </span>
                      <Button
                        variant="outline"
                        size="icon-xs"
                        className="h-7 w-7 rounded-l-none border-panel-border bg-panel"
                        onClick={() => {
                          setLegOverrides((prev) => ({
                            ...prev,
                            [item.symbol]: { ...prev[item.symbol], qty: item.qty + item.lot },
                          }));
                        }}
                      >
                        +
                      </Button>
                    </div>
                    {/* Order type toggle */}
                    <SegmentedControl
                      value={item.orderType}
                      onValueChange={(v) => {
                        setLegOverrides((prev) => ({
                          ...prev,
                          [item.symbol]: {
                            ...prev[item.symbol],
                            orderType: v as "MARKET" | "LIMIT",
                            // Auto-fill LTP when switching to LIMIT
                            price: v === "LIMIT" ? (prev[item.symbol]?.price || item.ltp) : 0,
                          },
                        }));
                      }}
                      options={[
                        { value: "MARKET", label: "MKT" },
                        { value: "LIMIT", label: "LMT" },
                      ]}
                      itemClassName="text-[10px]"
                    />
                    {/* Price input + live LTP */}
                    {item.orderType === "LIMIT" ? (
                      <div className="flex items-center gap-1">
                        <Input
                          type="number"
                          min={0.05}
                          step={0.05}
                          value={item.price || ""}
                          placeholder="Price"
                          onChange={(e) => {
                            const val = Number(e.target.value) || 0;
                            setLegOverrides((prev) => ({
                              ...prev,
                              [item.symbol]: { ...prev[item.symbol], price: Math.max(0, val) },
                            }));
                          }}
                          className="h-7 w-16 bg-panel px-1.5 text-right text-xs"
                        />
                        <span
                          className="cursor-pointer text-[10px] text-blue-400 hover:text-blue-300"
                          title="Use live LTP"
                          onClick={() => {
                            setLegOverrides((prev) => ({
                              ...prev,
                              [item.symbol]: { ...prev[item.symbol], price: item.ltp },
                            }));
                          }}
                        >
                          {item.ltp.toFixed(2)}
                        </span>
                      </div>
                    ) : (
                      <span className="text-right text-[10px] text-panel-dim">
                        LTP {item.ltp.toFixed(2)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Margin check */}
            <div className="flex items-center justify-between rounded-md border border-panel-border bg-panel-surface px-3 py-2">
              <div className="flex items-center gap-4 text-xs">
                <span className="text-panel-faint">
                  Margin:{" "}
                  <span className="font-medium text-panel-muted">
                    {isLoadingModifyMargin
                      ? "..."
                      : modifyMargin?.totalRequiredMargin != null
                        ? formatAmount(modifyMargin.totalRequiredMargin)
                        : "—"}
                  </span>
                </span>
                <span className="text-panel-faint">
                  Available:{" "}
                  <span className="font-medium text-panel-muted">
                    {modifyMargin?.availableCash != null ? formatAmount(modifyMargin.availableCash) : "—"}
                  </span>
                </span>
                {modifyMargin && modifyMargin.legs.some((l) => (l.insufficientFund ?? 0) > 0) && (
                  <span className="font-medium text-red-400">
                    Shortfall: {formatAmount(modifyMargin.legs.reduce((s, l) => s + (l.insufficientFund ?? 0), 0))}
                  </span>
                )}
              </div>
              <Button
                variant="outline"
                size="xs"
                className="border-panel-border text-panel-subtle hover:text-panel-muted"
                disabled={isLoadingModifyMargin}
                onClick={async () => {
                  setIsLoadingModifyMargin(true);
                  try {
                    const legs: PlaceOrderLeg[] = modifyPreview.map((item) => {
                      const pos = selectedPositions.find((p) => p.symbol === item.symbol);
                      return {
                        tradingSymbol: pos?.tradingSymbol || undefined,
                        underlying: item.underlying || undefined,
                        expiry: pos?.expiry || undefined,
                        strike: item.strike || undefined,
                        optionType: item.optionType || undefined,
                        transactionType: (item.side === "BUY" ? "B" : "S") as "B" | "S",
                        quantity: item.qty,
                        orderType: (item.orderType === "LIMIT" ? "L" : "MKT") as "L" | "MKT",
                        product: item.productType as "NRML" | "MIS",
                        price: item.orderType === "LIMIT" ? item.price : 0,
                      };
                    });
                    const result = await fetchMarginPreview(legs);
                    setModifyMargin(result);
                  } catch {
                    setModifyMargin(null);
                  } finally {
                    setIsLoadingModifyMargin(false);
                  }
                }}
              >
                {isLoadingModifyMargin ? "..." : "Check Margin"}
              </Button>
            </div>
          </div>
          {placeOrderError && activeActionDialog === "modify" && (
            <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
              {placeOrderError}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setActiveActionDialog(null); setPlaceOrderError(null); setModifyMargin(null); }}>
              Close
            </Button>
            <Button className="bg-amber-600 text-white hover:bg-amber-700" onClick={handlePlaceModifyOrders} disabled={isPlacingOrders}>
              {isPlacingOrders ? "Placing..." : `Place ${modifyMode === "exit" ? "Exit" : "Add"} Orders`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={activeActionDialog === "sl"}
        onOpenChange={(open) => setActiveActionDialog(open ? "sl" : null)}
      >
        <DialogContent className="border-panel-border bg-panel text-panel-muted sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-red-300">Stage Protective Stop Loss</DialogTitle>
            <DialogDescription className="text-panel-subtle">
              Create a stop-loss plan for the selected positions. This is staged in the UI until broker-side protective order routes are wired.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-panel-faint">Mode</span>
                <SegmentedControl
                  value={stopLossMode}
                  onValueChange={setStopLossMode}
                  options={STOP_LOSS_MODE_OPTIONS}
                  fullWidth
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-panel-faint">Reference</span>
                <SegmentedControl
                  value={stopLossBasis}
                  onValueChange={setStopLossBasis}
                  options={STOP_LOSS_BASIS_OPTIONS}
                  fullWidth
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-[11px] uppercase tracking-wider text-panel-faint">Buffer %</span>
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={stopLossBufferPct}
                  onChange={(e) =>
                    setStopLossBufferPct(Math.max(1, Math.min(50, Number(e.target.value) || 1)))
                  }
                  className="bg-panel-surface"
                />
              </label>
            </div>
            <div className="rounded-md border border-panel-border bg-panel-surface">
              <div className="border-b border-panel-border px-3 py-2 text-[11px] uppercase tracking-wider text-panel-faint">
                Trigger Review
              </div>
              <div className="max-h-48 overflow-y-auto px-3 py-2">
                {stopLossPreview.map((item) => (
                  <div key={item.symbol} className="flex items-center justify-between py-1 text-xs">
                    <span className="font-medium text-panel-muted">{item.symbol}</span>
                    <span className="text-panel-subtle">
                      {item.direction} {formatAmount(item.trigger)} from {stopLossBasis === "ltp" ? "LTP" : "cost"} {formatAmount(item.reference)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveActionDialog(null)}>
              Close
            </Button>
            <Button className="bg-red-600 text-white hover:bg-red-700" onClick={stageStopLossPlan}>
              Stage Protection
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={activeActionDialog === "convert"}
        onOpenChange={(open) => setActiveActionDialog(open ? "convert" : null)}
      >
        <DialogContent className="border-panel-border bg-panel text-panel-muted sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-cyan-300">Stage Product Conversion</DialogTitle>
            <DialogDescription className="text-panel-subtle">
              Prepare product conversion instructions for the selected positions.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] uppercase tracking-wider text-panel-faint">Convert To</span>
              <SegmentedControl
                value={convertTarget}
                onValueChange={setConvertTarget}
                options={PRODUCT_TYPE_OPTIONS}
                fullWidth
              />
            </label>
            <div className="rounded-md border border-panel-border bg-panel-surface px-3 py-2 text-xs text-panel-subtle">
              {convertiblePositions.length} of {selectedPositions.length} selected position{selectedPositions.length === 1 ? "" : "s"} need conversion.
            </div>
            <div className="max-h-40 overflow-y-auto rounded-md border border-panel-border bg-panel-surface px-3 py-2">
              {convertiblePositions.map((pos) => (
                <div key={pos.symbol} className="flex items-center justify-between py-1 text-xs">
                  <span className="font-medium text-panel-muted">{pos.symbol}</span>
                  <span className="text-panel-subtle">{pos.productType || "NRML"} → {convertTarget}</span>
                </div>
              ))}
              {convertiblePositions.length === 0 && (
                <div className="py-2 text-xs text-panel-quiet">All selected positions are already on {convertTarget}.</div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActiveActionDialog(null)}>
              Close
            </Button>
            <Button
              className="bg-cyan-600 text-white hover:bg-cyan-700"
              onClick={stageConvertPlan}
              disabled={convertiblePositions.length === 0}
            >
              Stage Conversion
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Square Off confirmation dialog */}
      <Dialog open={showSquareOffDialog} onOpenChange={setShowSquareOffDialog}>
        <DialogContent className="border-panel-border bg-panel text-panel-muted sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-400">Square Off Positions</DialogTitle>
            <DialogDescription className="text-panel-subtle">
              This will place market orders to close the following {selectedPositions.length} position{selectedPositions.length > 1 ? "s" : ""}:
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-48 overflow-y-auto rounded-sm border border-panel-border bg-panel-header p-2">
            {selectedPositions.map((pos) => {
              const parts = pos.symbol.split(" ");
              const strike = parts.length >= 3 ? parts[2] : "";
              const optType = parts.length >= 4 ? parts[3] : "";
              return (
                <div key={pos.symbol} className="flex items-center justify-between py-1 text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{parts[0]}</span>
                    {strike && (optType === "CE" || optType === "PE") && (
                      <div className="inline-flex items-center gap-1">
                        <span className="text-[10px] font-bold text-panel-subtle">{strike}</span>
                        <OptionTypeBadge optionType={optType} className="px-1 py-0.5" />
                      </div>
                    )}
                  </div>
                  <div className="inline-flex items-center gap-1.5">
                    <SideBadge side={pos.quantity > 0 ? "SELL" : "BUY"} />
                    <span className="font-medium text-panel-muted">
                      {Math.abs(pos.quantity)}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {placeOrderError && (
            <div className="rounded-sm border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
              {placeOrderError}
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => { setShowSquareOffDialog(false); setPlaceOrderError(null); }}
              className="border-panel-border text-panel-subtle hover:bg-panel-border"
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPlacingOrders}
              onClick={async () => {
                setIsPlacingOrders(true);
                setPlaceOrderError(null);
                try {
                  const orderLegs: PlaceOrderLeg[] = selectedPositions.map((pos) => {
                    const parsed = parseSymbol(pos);
                    return {
                      tradingSymbol: pos.tradingSymbol || undefined,
                      underlying: parsed.underlying || undefined,
                      expiry: parsed.expiry || undefined,
                      strike: parsed.strike || undefined,
                      optionType: parsed.optionType || undefined,
                      transactionType: (pos.quantity > 0 ? "S" : "B") as "B" | "S",
                      quantity: Math.abs(pos.quantity),
                      orderType: "MKT" as const,
                      product: (pos.productType || "NRML") as "NRML" | "MIS",
                    };
                  });
                  const results = await placeOrders(orderLegs);
                  const failures = results.filter((r) => !r.success);
                  if (failures.length > 0) {
                    setPlaceOrderError(failures.map((f) => `Leg ${f.index + 1}: ${f.error}`).join("; "));
                  } else {
                    setShowSquareOffDialog(false);
                    setSelected(new Set());
                  }
                } catch (error) {
                  setPlaceOrderError(error instanceof Error ? error.message : "Square off failed");
                } finally {
                  setIsPlacingOrders(false);
                }
              }}
            >
              {isPlacingOrders ? "Placing..." : "Confirm Square Off"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
