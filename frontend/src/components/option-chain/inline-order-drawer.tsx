"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useBasketStore } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { analyzeStrategy, cancelOrder, fetchMarginPreview, fetchOrderBook, modifyOrder, placeOrders } from "@/lib/api-client";
import type { MarginPreviewResult, PlaceOrderLeg } from "@/lib/api-client";
import type { OrderType as BasketOrderType } from "@/types/market-data";
import { getLotSize } from "@/lib/lot-sizes";
import type { OrderType, ProductType, StrategyResult } from "@/types/market-data";
import { SpreadDiffsBar, computeSpreadDiffs } from "./spread-diffs-bar";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OptionTypeBadge, SideBadge } from "@/components/ui/trading-label";

const PRODUCT_TYPES: { value: ProductType; label: string; title: string }[] = [
  { value: "NRML", label: "NRML", title: "Normal — carry forward positions overnight" },
  { value: "MIS", label: "MIS", title: "Margin Intraday Square-off — auto-closes before market end" },
];
const ORDER_TYPE_OPTIONS: { value: OrderType; label: string }[] = [
  { value: "LIMIT", label: "LMT" },
  { value: "MARKET", label: "MKT" },
  { value: "SL", label: "SL" },
  { value: "SL-M", label: "SL-M" },
];
const BROKER_ORDER_TYPE_OPTIONS = [
  { value: "L", label: "LMT" },
  { value: "MKT", label: "MKT" },
  { value: "SL", label: "SL" },
  { value: "SL-M", label: "SL-M" },
] as const;
const VALIDITY_OPTIONS = [
  { value: "DAY", label: "DAY" },
  { value: "IOC", label: "IOC" },
  { value: "GTC", label: "GTC" },
  { value: "EOS", label: "EOS" },
  { value: "GTD", label: "GTD" },
] as const;
import { CompactLegRow } from "./compact-leg-row";
import type { SpreadGroupInfo } from "./compact-leg-row";
import {
  STRATEGY_TEMPLATES,
  applyTemplate,
  getDefaultParamValues,
  loadSavedParamValues,
  saveParamValues,
} from "./strategy-templates";
import type { StrategyTemplate, ParamValues, StrikeMode } from "./strategy-templates";
import { StrategyConfigBar } from "./strategy-config-bar";

interface InlineOrderDrawerProps {
  isCollapsed: boolean;
  onToggle: () => void;
}

interface BrokerOrder {
  orderId: string;
  tradingSymbol?: string;
  symbol?: string;
  exchange?: string;
  side?: string;
  quantity?: number;
  filledQty?: number;
  unfilledQty?: number;
  disclosedQty?: number;
  price?: number;
  triggerPrice?: number;
  avgPrice?: number;
  orderType?: string;
  productType?: string;
  validity?: string;
  status?: string;
  optionType?: string;
  strikePrice?: string | number;
  expiry?: string;
  time?: string;
}

function normalizeBrokerOrderType(value: string): string {
  const raw = value.trim().toUpperCase();
  if (raw === "LIMIT" || raw === "L") return "L";
  if (raw === "MARKET" || raw === "MKT" || raw === "M") return "MKT";
  if (raw === "SL") return "SL";
  if (raw === "SL-M" || raw === "SLM") return "SL-M";
  return raw || "L";
}

function normalizeValidity(value: string): string {
  const raw = value.trim().toUpperCase();
  return raw || "DAY";
}

function formatExpiryBadge(expiry: string | undefined): string {
  if (!expiry) return "";
  const date = new Date(expiry);
  if (Number.isNaN(date.getTime())) {
    return expiry.toUpperCase();
  }
  return date.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
  }).toUpperCase();
}

const NO_SPINNER =
  "[appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none";

function NumberStepper({
  label,
  value,
  onChange,
  step,
  min = 0,
  max,
  disabled = false,
  widthClass = "w-24",
}: {
  label: string;
  value: number;
  onChange: (next: number) => void;
  step: number;
  min?: number;
  max?: number;
  disabled?: boolean;
  widthClass?: string;
}) {
  const clamp = (next: number) => {
    if (Number.isNaN(next)) return min;
    if (max !== undefined && next > max) return max;
    return Math.max(min, next);
  };

  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-panel-dim">{label}</span>
      <div className="flex items-center">
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onChange(clamp(value - step))}
          disabled={disabled}
          className="h-7 w-7 rounded-r-none border-panel-border bg-panel"
        >
          −
        </Button>
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(clamp(Number(e.target.value) || 0))}
          className={`h-7 rounded-none border-x-0 border-panel-border bg-panel px-0 text-center text-xs text-panel-muted ${widthClass} ${NO_SPINNER}`}
        />
        <Button
          variant="outline"
          size="icon-xs"
          onClick={() => onChange(clamp(value + step))}
          disabled={disabled}
          className="h-7 w-7 rounded-l-none border-panel-border bg-panel"
        >
          +
        </Button>
      </div>
    </label>
  );
}

function formatAmount(value: number): string {
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function estimateExecutionCharges(turnover: number, legs: number): number {
  if (turnover <= 0 || legs <= 0) return 0;
  return turnover * 0.00085 + legs * 1.5;
}

function mapOrderType(ot: BasketOrderType): "L" | "MKT" | "SL" | "SL-M" {
  switch (ot) {
    case "LIMIT": return "L";
    case "MARKET": return "MKT";
    case "SL": return "SL";
    case "SL-M": return "SL-M";
  }
}

export function InlineOrderDrawer({
  isCollapsed,
  onToggle,
}: InlineOrderDrawerProps) {
  const legs = useBasketStore((s) => s.legs);
  const netCredit = useBasketStore((s) => s.netCredit);
  const updateLeg = useBasketStore((s) => s.updateLeg);
  const removeLeg = useBasketStore((s) => s.removeLeg);
  const reorderLegs = useBasketStore((s) => s.reorderLegs);
  const clearBasket = useBasketStore((s) => s.clearBasket);
  const addLeg = useBasketStore((s) => s.addLeg);

  const selectedUnderlying = useMarketDataStore((s) => s.selectedUnderlying);
  const selectedExpiry = useMarketDataStore((s) => s.selectedExpiry);
  const feedMode = useMarketDataStore((s) => s.feedMode);
  // Only subscribe to strike structure (stable between ticks), not the full chain
  const strikeStep = useMarketDataStore((s) => {
    const chain = s.optionChain;
    if (!chain || chain.strikes.length < 2) return 100;
    return Math.abs(chain.strikes[1].strike - chain.strikes[0].strike);
  });
  const lotSize = getLotSize(selectedUnderlying);

  const spreadGroups = useMemo((): (SpreadGroupInfo | null)[] => {
    if (legs.length <= 1) return legs.map(() => null);
    // Find consecutive runs of same optionType
    const result: (SpreadGroupInfo | null)[] = legs.map(() => null);
    let runStart = 0;
    while (runStart < legs.length) {
      let runEnd = runStart;
      while (runEnd + 1 < legs.length && legs[runEnd + 1].optionType === legs[runStart].optionType) {
        runEnd++;
      }
      if (runEnd > runStart) {
        const type = legs[runStart].optionType === "CE" ? "call" as const : "put" as const;
        for (let i = runStart; i <= runEnd; i++) {
          let position: "first" | "middle" | "last";
          if (i === runStart) position = "first";
          else if (i === runEnd) position = "last";
          else position = "middle";
          result[i] = { type, position };
        }
      }
      runStart = runEnd + 1;
    }
    return result;
  }, [legs]);

  const spreadDiffs = useMemo(
    () => computeSpreadDiffs(legs, useGreeksStore.getState().greeks),
    // Recompute only when legs change, read greeks snapshot at compute time
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [legs],
  );

  const [basketOrderType, setBasketOrderType] = useState<OrderType>("LIMIT");
  const lots = useBasketStore((s) => s.lots);
  const setLots = useBasketStore((s) => s.setLots);
  const productType = useBasketStore((s) => s.productType);
  const setProductType = useBasketStore((s) => s.setProductType);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [analysisResult, setAnalysisResult] = useState<StrategyResult | null>(null);
  const [marginPreview, setMarginPreview] = useState<MarginPreviewResult | null>(null);
  const [marginPreviewError, setMarginPreviewError] = useState<string | null>(null);
  const [isLoadingMarginPreview, setIsLoadingMarginPreview] = useState(false);

  const [selectedTemplate, setSelectedTemplate] = useState<StrategyTemplate | null>(null);
  const [configParamValues, setConfigParamValues] = useState<ParamValues>({});
  const [strikeMode, setStrikeMode] = useState<StrikeMode>("offset");

  const dragFrom = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const handleDragStart = useCallback((index: number) => {
    dragFrom.current = index;
  }, []);

  const handleDragOver = useCallback((index: number) => {
    setDragOverIndex(index);
  }, []);

  const handleDragEnd = useCallback(() => {
    if (dragFrom.current !== null && dragOverIndex !== null && dragFrom.current !== dragOverIndex) {
      reorderLegs(dragFrom.current, dragOverIndex);
    }
    dragFrom.current = null;
    setDragOverIndex(null);
  }, [dragOverIndex, reorderLegs]);

  const handleAnalyze = useCallback(async () => {
    if (legs.length === 0) return;
    setIsAnalyzing(true);
    try {
      const result = await analyzeStrategy(legs);
      setAnalysisResult(result);
    } finally {
      setIsAnalyzing(false);
    }
  }, [legs]);

  const orderLegs = useMemo<PlaceOrderLeg[]>(
    () =>
      legs.map((leg) => ({
        underlying: selectedUnderlying,
        expiry: selectedExpiry,
        strike: leg.strike,
        optionType: leg.optionType,
        transactionType: leg.side === "BUY" ? "B" as const : "S" as const,
        quantity: leg.quantity,
        orderType: mapOrderType(leg.orderType),
        product: leg.productType as "NRML" | "MIS",
        price: leg.orderType === "LIMIT" || leg.orderType === "SL" ? leg.premium : 0,
        triggerPrice: leg.orderType === "SL" || leg.orderType === "SL-M" ? leg.premium : 0,
      })),
    [legs, selectedUnderlying, selectedExpiry],
  );

  const handleSubmit = useCallback(async () => {
    if (legs.length === 0) return;
    setIsSubmitting(true);
    setSubmitError(null);
    try {
      const results = await placeOrders(orderLegs);
      const failures = results.filter((r) => !r.success);
      if (failures.length > 0) {
        setSubmitError(failures.map((f) => `Leg ${f.index + 1}: ${f.error}`).join("; "));
      } else {
        clearBasket();
        // Refresh order book if on that tab
        ordersFetchedRef.current = false;
      }
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "Order placement failed");
    } finally {
      setIsSubmitting(false);
    }
  }, [clearBasket, legs.length, orderLegs]);

  const handleAddLeg = useCallback(() => {
    addLeg({
      symbol: "",
      strike: 0,
      optionType: "CE",
      side: "BUY",
      quantity: lotSize * lots,
      premium: 0,
      orderType: basketOrderType,
      productType,
    });
  }, [addLeg, lotSize, lots, basketOrderType, productType]);

  const handleBasketOrderTypeChange = useCallback(
    (newType: OrderType) => {
      setBasketOrderType(newType);
      // Apply to all existing legs
      legs.forEach((_, i) => updateLeg(i, { orderType: newType }));
    },
    [legs, updateLeg],
  );

  const handleChipClick = useCallback((t: StrategyTemplate) => {
    if (t.params.length === 0) {
      applyTemplate(t, {}, strikeMode);
      setSelectedTemplate(null);
    } else {
      setSelectedTemplate(t);
      const saved = loadSavedParamValues(t.name, strikeMode);
      setConfigParamValues(saved ?? getDefaultParamValues(t, strikeMode));
    }
  }, [strikeMode]);

  const handleParamChange = useCallback((key: string, value: number) => {
    setConfigParamValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleConfigApply = useCallback(() => {
    if (!selectedTemplate) return;
    applyTemplate(selectedTemplate, configParamValues, strikeMode);
  }, [selectedTemplate, configParamValues, strikeMode]);

  const handleConfigSave = useCallback(() => {
    if (!selectedTemplate) return;
    saveParamValues(selectedTemplate.name, configParamValues, strikeMode);
  }, [selectedTemplate, configParamValues, strikeMode]);

  const handleStrikeModeChange = useCallback((mode: StrikeMode) => {
    setStrikeMode(mode);
    if (selectedTemplate) {
      const saved = loadSavedParamValues(selectedTemplate.name, mode);
      setConfigParamValues(saved ?? getDefaultParamValues(selectedTemplate, mode));
    }
  }, [selectedTemplate]);

  const handleStrikeStep = useCallback(
    (index: number, direction: 1 | -1) => {
      const leg = legs[index];
      if (!leg) return;
      const newStrike = leg.strike + direction * strikeStep;
      // Read chain snapshot at call time (not via subscription) to avoid re-renders
      const chain = useMarketDataStore.getState().optionChain;
      if (chain && selectedUnderlying && selectedExpiry) {
        const strikeRow = chain.strikes.find((s) => s.strike === newStrike);
        if (!strikeRow) return; // don't step beyond available strikes
        const opt = leg.optionType === "CE" ? strikeRow.call : strikeRow.put;
        const premium = opt ? opt.ltp : leg.premium;
        const expiryCompact = selectedExpiry.replace(/-/g, "");
        const symbol = `${selectedUnderlying}${expiryCompact}${newStrike}${leg.optionType}`;
        updateLeg(index, { strike: newStrike, premium, symbol });
      } else {
        updateLeg(index, { strike: newStrike });
      }
    },
    [legs, selectedUnderlying, selectedExpiry, strikeStep, updateLeg],
  );

  const creditLabel = netCredit >= 0 ? "CR" : "DR";
  const creditColor = netCredit >= 0 ? "text-green-400" : "text-red-400";
  const legSignature = useMemo(
    () =>
      legs
        .map((leg) =>
          [
            leg.symbol,
            leg.side,
            leg.optionType,
            leg.strike,
            leg.quantity,
            leg.premium,
            leg.orderType,
            leg.productType,
          ].join(":"),
        )
        .join("|"),
    [legs],
  );
  const grossBuyValue = useMemo(
    () =>
      legs.reduce(
        (total, leg) =>
          leg.side === "BUY" ? total + leg.quantity * leg.premium : total,
        0,
      ),
    [legs],
  );
  const grossSellValue = useMemo(
    () =>
      legs.reduce(
        (total, leg) =>
          leg.side === "SELL" ? total + leg.quantity * leg.premium : total,
        0,
      ),
    [legs],
  );
  const turnover = grossBuyValue + grossSellValue;
  const premiumFlow = grossSellValue - grossBuyValue;
  const hasShortExposure = legs.some((leg) => leg.side === "SELL");
  const estimatedCharges = useMemo(
    () => estimateExecutionCharges(turnover, legs.length),
    [turnover, legs.length],
  );
  const estimatedMarginBlock = analysisResult?.margin.initialMargin ?? null;
  const fundsRequired = analysisResult
    ? Math.max(analysisResult.margin.initialMargin - Math.max(premiumFlow, 0), 0)
    : hasShortExposure
      ? null
      : Math.max(grossBuyValue - grossSellValue, 0);
  const brokerMarginRequired = marginPreview?.totalRequiredMargin ?? null;
  const brokerAvailableFunds = marginPreview?.availableCash ?? marginPreview?.accountNet ?? null;
  const brokerInsufficientFund = marginPreview
    ? marginPreview.legs
        .filter((l) => l.success)
        .reduce((sum, l) => sum + (l.insufficientFund ?? 0), 0)
    : null;

  useEffect(() => {
    setAnalysisResult(null);
  }, [legSignature, basketOrderType, productType]);

  useEffect(() => {
    setMarginPreview(null);
    setMarginPreviewError(null);
    setIsLoadingMarginPreview(false);
  }, [legSignature, selectedUnderlying, selectedExpiry, feedMode]);

  const refreshMarginPreview = useCallback(async () => {
    if (feedMode !== "broker" || !selectedUnderlying || !selectedExpiry || orderLegs.length === 0) {
      setMarginPreview(null);
      setMarginPreviewError(null);
      return;
    }

    setIsLoadingMarginPreview(true);
    try {
      const preview = await fetchMarginPreview(orderLegs);
      setMarginPreview(preview);
      setMarginPreviewError(null);
    } catch (error) {
      setMarginPreview(null);
      setMarginPreviewError(error instanceof Error ? error.message : "Margin preview unavailable");
    } finally {
      setIsLoadingMarginPreview(false);
    }
  }, [feedMode, orderLegs, selectedExpiry, selectedUnderlying]);

  const [activeTab, setActiveTab] = useState<"new" | "open" | "closed">("new");
  const [openOrders, setOpenOrders] = useState<BrokerOrder[]>([]);
  const [closedOrders, setClosedOrders] = useState<BrokerOrder[]>([]);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [refreshingOrders, setRefreshingOrders] = useState(false);
  const [actingOrderId, setActingOrderId] = useState<string | null>(null);
  const ordersFetchedRef = useRef(false);

  const refreshOrders = useCallback(async () => {
    setRefreshingOrders(true);
    setOrdersError(null);
    try {
      const data = await fetchOrderBook();
      setOpenOrders(Array.isArray(data.open) ? data.open as BrokerOrder[] : []);
      setClosedOrders(Array.isArray(data.closed) ? data.closed as BrokerOrder[] : []);
    } catch (error) {
      setOrdersError(error instanceof Error ? error.message : "Unable to refresh orders");
    } finally {
      setRefreshingOrders(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === "new") return;
    if (ordersFetchedRef.current) return;
    ordersFetchedRef.current = true;
    void refreshOrders();
  }, [activeTab, refreshOrders]);

  const handleCancelOrder = useCallback(async (orderId: string) => {
    setActingOrderId(orderId);
    setOrdersError(null);
    try {
      await cancelOrder(orderId);
      await refreshOrders();
    } catch (error) {
      setOrdersError(error instanceof Error ? error.message : `Unable to cancel order ${orderId}`);
    } finally {
      setActingOrderId(null);
    }
  }, [refreshOrders]);

  const handleModifyOrder = useCallback(async (
    orderId: string,
    payload: {
      quantity: number;
      price: number;
      trigger_price: number;
      disclosed_quantity: number;
      validity: string;
      order_type: string;
    },
  ) => {
    setActingOrderId(orderId);
    setOrdersError(null);
    try {
      await modifyOrder(orderId, {
        quantity: payload.quantity,
        price: payload.price,
        trigger_price: payload.trigger_price,
        order_type: payload.order_type,
        disclosed_quantity: payload.disclosed_quantity,
        validity: payload.validity,
      });
      await refreshOrders();
    } catch (error) {
      setOrdersError(error instanceof Error ? error.message : `Unable to modify order ${orderId}`);
      throw error;
    } finally {
      setActingOrderId(null);
    }
  }, [refreshOrders]);

  // Collapsed — clickable bar to expand
  if (isCollapsed) {
    return (
      <div
        onClick={onToggle}
        className="order-collapsed-bar flex h-full cursor-pointer items-center justify-between bg-panel-header px-4 hover:bg-panel-hover"
      >
        <div className="flex items-center gap-3 text-sm">
          <span className="text-panel-subtle">
            {legs.length === 0
              ? "Click bid/ask to add legs"
              : `${legs.length} leg${legs.length > 1 ? "s" : ""}`}
          </span>
          {legs.length > 0 && (
            <span className={`font-medium ${creditColor}`}>
              {Math.abs(netCredit).toFixed(2)} {creditLabel}
            </span>
          )}
        </div>
        <span className="text-xs text-panel-quiet">Click to expand</span>
      </div>
    );
  }

  // Expanded — always show full UI
  return (
    <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as "new" | "open" | "closed")} className="flex h-full flex-col bg-panel-header">
      {/* Tab bar */}
      <div className="flex shrink-0 items-center border-b border-panel-border">
        <TabsList
          variant="line"
          className="h-auto gap-0 rounded-none border-none bg-transparent p-0"
        >
          {(["new", "open", "closed"] as const).map((tab) => {
            const count = tab === "new" ? legs.length : tab === "open" ? openOrders.length : closedOrders.length;
            const isActive = activeTab === tab;
            return (
              <TabsTrigger
                key={tab}
                value={tab}
                className="flex items-center gap-1.5 rounded-none border-x-0 border-t-0 border-b-2 border-transparent px-4 py-2 text-xs font-medium text-panel-faint transition-colors hover:text-panel-muted data-active:border-blue-500 data-active:bg-transparent data-active:text-panel-muted data-active:shadow-none data-active:after:bg-blue-500 dark:data-active:border-blue-500 dark:data-active:bg-transparent"
              >
                {tab === "new" ? "New" : tab === "open" ? "Open" : "Closed"}
                {count > 0 && (
                  <Badge
                    variant="secondary"
                    className={
                      isActive
                        ? "h-4 rounded-sm bg-blue-500/15 px-1.5 text-[10px] text-blue-400"
                        : "h-4 rounded-sm bg-panel-border px-1.5 text-[10px] text-panel-subtle"
                    }
                  >
                    {count}
                  </Badge>
                )}
              </TabsTrigger>
            );
          })}
        </TabsList>
        <div className="ml-auto pr-2">
          <button
            onClick={onToggle}
            className="text-xs text-panel-subtle hover:text-panel-muted"
          >
            Collapse
          </button>
        </div>
      </div>

      {/* Tab content */}
      <TabsContent value="new" className="mt-0 flex min-h-0 flex-1 flex-col">
      {/* Template chips row */}
      <div className="order-template-bar flex shrink-0 items-center gap-1 overflow-x-auto border-b border-panel-border px-2 py-1 scrollbar-none">
        {STRATEGY_TEMPLATES.map((t) => {
          const isActive = selectedTemplate?.name === t.name;
          return (
            <button
              key={t.name}
              onClick={() => handleChipClick(t)}
              className={`order-template-chip shrink-0 rounded-sm border px-1.5 py-px text-[10px] leading-4 transition-colors ${
                isActive
                  ? "border-blue-500 bg-blue-500/20 text-blue-400"
                  : "border-panel-border bg-panel text-panel-subtle hover:border-blue-500 hover:text-blue-400"
              }`}
            >
              {t.name}
            </button>
          );
        })}
      </div>

      {/* Config bar — conditional on selected template with params */}
      {selectedTemplate && selectedTemplate.params.length > 0 && (
        <StrategyConfigBar
          template={selectedTemplate}
          paramValues={configParamValues}
          strikeMode={strikeMode}
          onParamChange={handleParamChange}
          onStrikeModeChange={handleStrikeModeChange}
          onApply={handleConfigApply}
          onSave={handleConfigSave}
        />
      )}

      {/* Order settings bar — always visible */}
      <div className="flex shrink-0 items-center gap-3 border-b border-panel-border px-3 py-1.5">
        <div className="flex items-center">
          <SegmentedControl
            value={basketOrderType}
            onValueChange={handleBasketOrderTypeChange}
            options={ORDER_TYPE_OPTIONS}
            itemClassName="text-[11px] text-panel-faint hover:text-panel-muted"
          />
        </div>

        <div className="h-3 w-px bg-panel-border" />

        <div className="flex items-center">
          <SegmentedControl
            value={productType}
            onValueChange={setProductType}
            options={PRODUCT_TYPES}
            itemClassName="text-[11px] font-semibold text-panel-faint hover:text-panel-muted"
          />
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <div className="flex items-center">
            <Button
              variant="outline"
              size="icon-xs"
              onClick={() => setLots(lots - 1)}
              className="rounded-r-none border-panel-border"
              title="Decrease lots"
            >
              −
            </Button>
            <Input
              type="number"
              value={lots}
              min={1}
              max={100}
              onChange={(e) => setLots(Number(e.target.value) || 1)}
              className="h-6 w-10 rounded-none border-x-0 border-panel-border bg-panel px-0 text-center text-xs text-panel-muted [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              title="Lots"
            />
            <Button
              variant="outline"
              size="icon-xs"
              onClick={() => setLots(lots + 1)}
              className="rounded-l-none border-panel-border"
              title="Increase lots"
            >
              +
            </Button>
          </div>
          <span className="text-[10px] text-panel-dim">= {lotSize * lots}</span>
        </div>
      </div>

      {/* Leg rows — scrollable, or empty state */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {legs.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-panel-quiet">
              Select a strategy template above or click bid/ask cells in the
              chain
            </span>
          </div>
        ) : (
          legs.map((leg, i) => (
            <CompactLegRow
              key={`${leg.strike}-${leg.optionType}-${leg.side}-${i}`}
              leg={leg}
              index={i}
              lotSize={lotSize}
              onUpdate={updateLeg}
              onRemove={removeLeg}
              onStrikeStep={handleStrikeStep}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragEnd={handleDragEnd}
              isDragOver={dragOverIndex === i}
              spreadGroup={spreadGroups[i]}
            />
          ))
        )}
      </div>

      {legs.length > 0 && (
        <div className="grid shrink-0 grid-cols-2 gap-px border-y border-panel-border bg-panel-border sm:grid-cols-5 xl:grid-cols-10">
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Premium Flow</div>
            <div className={`mt-1 text-sm font-semibold ${creditColor}`}>
              {premiumFlow >= 0 ? "+" : "-"}{formatAmount(Math.abs(premiumFlow))}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Gross Buy</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {formatAmount(grossBuyValue)}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Gross Sell</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {formatAmount(grossSellValue)}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Turnover</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {formatAmount(turnover)}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Strategy Margin</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {estimatedMarginBlock !== null ? formatAmount(estimatedMarginBlock) : "Run Analyze"}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Shortfall</div>
            <div className={`mt-1 text-sm font-semibold ${brokerInsufficientFund !== null && brokerInsufficientFund > 0 ? "text-red-400" : "text-green-400"}`}>
              {isLoadingMarginPreview
                ? "Loading..."
                : brokerInsufficientFund !== null
                  ? brokerInsufficientFund > 0 ? formatAmount(brokerInsufficientFund) : "None"
                  : "—"}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-panel-dim">
              <span>Broker Margin</span>
            </div>
            <Button
                variant="ghost"
                size="xs"
                onClick={() => void refreshMarginPreview()}
                disabled={isLoadingMarginPreview || feedMode !== "broker" || legs.length === 0}
                className="h-5 px-1 text-[10px] normal-case text-panel-subtle hover:text-panel-muted"
              >
                {isLoadingMarginPreview ? "..." : "Refresh"}
            </Button>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {isLoadingMarginPreview
                ? "Loading..."
                : brokerMarginRequired !== null
                  ? formatAmount(brokerMarginRequired)
                  : ""}
            </div>
            {marginPreviewError && (
              <div className="mt-1 text-[10px] text-red-400">Preview failed</div>
            )}
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Available Funds</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {isLoadingMarginPreview
                ? "Loading..."
                : brokerAvailableFunds !== null
                  ? formatAmount(brokerAvailableFunds)
                  : ""}
            </div>
            <div className="mt-1 text-[10px] text-panel-subtle">
              Kotak RMS
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="text-[10px] uppercase tracking-wider text-panel-dim">Charges Est.</div>
            <div className="mt-1 text-sm font-semibold text-panel-muted">
              {formatAmount(estimatedCharges)}
            </div>
          </div>
          <div className="bg-panel-inset px-3 py-2">
            <div className="flex items-center justify-between text-[10px] uppercase tracking-wider text-panel-dim">
              Review
              <Badge
                variant="secondary"
                className={analysisResult ? "bg-green-500/15 text-green-400" : "bg-yellow-500/15 text-yellow-400"}
              >
                {analysisResult ? "Analyzed" : "Draft"}
              </Badge>
            </div>
            <div className="mt-1 text-xs text-panel-subtle">
              {analysisResult
                ? `Max loss ${formatAmount(analysisResult.maxLoss)}`
                : "Local estimate vs broker preview."}
            </div>
          </div>
        </div>
      )}

      {/* Spread diffs info bar */}
      {spreadDiffs && <SpreadDiffsBar data={spreadDiffs} />}

      {/* Submit error */}
      {submitError && (
        <div className="shrink-0 border-t border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[11px] text-red-400">
          {submitError}
        </div>
      )}

      {/* Action bar — always at bottom */}
      <div className="order-action-bar flex shrink-0 items-center justify-between border-t border-panel-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Button variant="secondary" size="xs" onClick={handleAddLeg}>
            + Leg
          </Button>
          <Button variant="outline" size="xs" onClick={handleAnalyze} disabled={isAnalyzing || legs.length === 0}
            className="border-blue-600/40 text-blue-400 hover:bg-blue-600/20">
            {isAnalyzing ? "..." : "Analyze"}
          </Button>
          <Button size="xs" onClick={handleSubmit} disabled={isSubmitting || legs.length === 0}
            className="bg-green-600 text-white hover:bg-green-700">
            {isSubmitting ? "Placing..." : "Submit"}
          </Button>
          <Button variant="ghost" size="xs" onClick={clearBasket} disabled={legs.length === 0}
            className="text-red-400 hover:bg-red-500/20 hover:text-red-400">
            Clear
          </Button>
        </div>

        <div className="flex items-center gap-3">
          {legs.length > 0 && (
            <span className={`text-sm font-medium ${creditColor}`}>
              {Math.abs(netCredit).toFixed(2)} {creditLabel}
            </span>
          )}
        </div>
      </div>
      </TabsContent>

      <TabsContent value="open" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        <div className="flex items-center justify-between border-b border-panel-border/40 px-3 py-2 text-[11px]">
          <span className="text-panel-subtle">
            {ordersError ? ordersError : refreshingOrders ? "Refreshing orders..." : "Pending broker orders"}
          </span>
          <Button variant="ghost" size="xs" onClick={() => void refreshOrders()} disabled={refreshingOrders}>
            Refresh
          </Button>
        </div>
        {openOrders.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-panel-dim">No pending orders</span>
          </div>
        ) : (
          openOrders.map((o) => (
            <OrderRow
              key={String(o.orderId)}
              order={o}
              isOpen
              isBusy={actingOrderId === o.orderId}
              onCancel={handleCancelOrder}
              onModify={handleModifyOrder}
            />
          ))
        )}
      </TabsContent>

      <TabsContent value="closed" className="mt-0 min-h-0 flex-1 overflow-y-auto">
        {closedOrders.length === 0 ? (
          <div className="flex h-full items-center justify-center">
            <span className="text-sm text-panel-dim">No closed orders</span>
          </div>
        ) : (
          closedOrders.map((o) => (
            <OrderRow key={String(o.orderId)} order={o} />
          ))
        )}
      </TabsContent>
    </Tabs>
  );
}

/** Order row for Open/Closed tabs */
function OrderRow({
  order,
  isOpen = false,
  isBusy = false,
  onCancel,
  onModify,
}: {
  order: BrokerOrder;
  isOpen?: boolean;
  isBusy?: boolean;
  onCancel?: (orderId: string) => void | Promise<void>;
  onModify?: (
    orderId: string,
    payload: {
      quantity: number;
      price: number;
      trigger_price: number;
      disclosed_quantity: number;
      validity: string;
      order_type: string;
    },
  ) => void | Promise<void>;
}) {
  const side = String(order.side || "");
  const optType = String(order.optionType || "");
  const filled = Number(order.filledQty || 0);
  const total = Number(order.quantity || 0);
  const unfilled = Number(order.unfilledQty || Math.max(total - filled, 0));
  const disclosedQty = Number(order.disclosedQty || 0);
  const price = Number(order.price || 0);
  const avgPrice = Number(order.avgPrice || 0);
  const orderType = normalizeBrokerOrderType(String(order.orderType || ""));
  const validity = normalizeValidity(String(order.validity || ""));
  const status = String(order.status || "").toLowerCase();
  const symbol = String(order.symbol || "");
  const tradingSymbol = String(order.tradingSymbol || symbol);
  const exchange = String(order.exchange || "");
  const productType = String(order.productType || "");
  const strike = String(order.strikePrice || "");
  const time = String(order.time || "");
  const orderId = String(order.orderId || "");
  const triggerPrice = Number(order.triggerPrice || 0);
  const expiryLabel = formatExpiryBadge(order.expiry);
  const [editing, setEditing] = useState(false);
  const [draftQty, setDraftQty] = useState(total);
  const [draftPrice, setDraftPrice] = useState(price);
  const [draftTriggerPrice, setDraftTriggerPrice] = useState(triggerPrice);
  const [draftDisclosedQty, setDraftDisclosedQty] = useState(disclosedQty);
  const [draftOrderType, setDraftOrderType] = useState(orderType);
  const [draftValidity, setDraftValidity] = useState(validity);
  const [localError, setLocalError] = useState<string | null>(null);

  // Convert "16-Mar-2026 15:10:30" → "3:10 PM"
  let timePart = "";
  const rawTime = time.includes(" ") ? time.split(" ").pop() || "" : time;
  if (rawTime) {
    const [hh, mm] = rawTime.split(":");
    const h = parseInt(hh, 10);
    const ampm = h >= 12 ? "PM" : "AM";
    const h12 = h % 12 || 12;
    timePart = `${h12}:${mm} ${ampm}`;
  }

  const statusStyle =
    status === "complete" ? "bg-green-500/15 text-green-400" :
    status === "rejected" ? "bg-red-500/15 text-red-400" :
    status === "cancelled" ? "bg-panel-border text-panel-faint" :
    "bg-yellow-500/15 text-yellow-400";

  const submitModify = async () => {
    if (!onModify || !orderId) return;
    if (draftQty <= 0) {
      setLocalError("Quantity must be greater than zero");
      return;
    }
    if (draftDisclosedQty < 0 || draftDisclosedQty > draftQty) {
      setLocalError("Disclosed quantity must be between 0 and quantity");
      return;
    }
    if ((draftOrderType === "SL" || draftOrderType === "SL-M") && draftTriggerPrice <= 0) {
      setLocalError("Trigger price is required for stop orders");
      return;
    }
    setLocalError(null);
    await onModify(orderId, {
      quantity: draftQty,
      price: draftOrderType === "MKT" || draftOrderType === "SL-M" ? 0 : draftPrice,
      trigger_price: draftOrderType === "SL" || draftOrderType === "SL-M" ? draftTriggerPrice : 0,
      disclosed_quantity: draftDisclosedQty,
      validity: draftValidity,
      order_type: draftOrderType,
    });
    setEditing(false);
  };

  return (
    <div className="border-b border-panel-border/30 px-3 py-2 text-xs">
      <div className="grid grid-cols-[minmax(0,2.2fr)_120px_100px_90px_120px_140px_auto] items-center gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-base font-semibold text-panel-muted">
              {symbol || tradingSymbol}
            </span>
            {strike && strike !== "0" && strike !== "0.00" && (
              <Badge variant="secondary" className="bg-orange-500/10 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
                {parseFloat(strike)} {optType === "CE" ? "CALL" : "PUT"}
              </Badge>
            )}
            {expiryLabel && (
              <Badge variant="secondary" className="bg-orange-500/10 px-2 py-0.5 text-[11px] font-semibold text-orange-300">
                {expiryLabel}
              </Badge>
            )}
            {exchange && <span className="text-sm text-panel-dim">{exchange}</span>}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-panel-subtle">
            {tradingSymbol && tradingSymbol !== symbol && <span>{tradingSymbol}</span>}
            {productType && <span>{productType}</span>}
            <span>ID {orderId}</span>
            {validity && <span>{validity}</span>}
          </div>
        </div>

        <div className="text-sm text-panel-muted">{timePart || "--"}</div>
        <div className="text-sm font-medium text-panel-muted">{productType || "--"}</div>
        <div className="text-sm">
          <span className={side === "BUY" ? "text-blue-400" : "text-red-400"}>{side || "--"}</span>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-panel-muted">{filled}/{total}</div>
          <div className="text-[11px] text-panel-dim">{unfilled} pending</div>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold text-panel-muted">
            {(avgPrice > 0 ? avgPrice : price).toFixed(2)}
          </div>
          <div className="text-[11px] text-panel-dim">
            {orderType === "SL" || orderType === "SL-M" || triggerPrice > 0
              ? `${orderType} TRG. ${triggerPrice.toFixed(2)}`
              : orderType}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <Badge variant="secondary" className={`px-1.5 py-0.5 text-[10px] font-medium ${statusStyle}`}>
            {status}
          </Badge>
          {isOpen && onModify && onCancel && (
            <>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setLocalError(null);
                  if (!editing) {
                    setDraftQty(total);
                    setDraftPrice(price);
                    setDraftTriggerPrice(triggerPrice);
                    setDraftDisclosedQty(disclosedQty);
                    setDraftOrderType(orderType);
                    setDraftValidity(validity);
                  }
                  setEditing((value) => !value);
                }}
                disabled={isBusy}
              >
                {editing ? "Close" : "Modify"}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                onClick={() => void onCancel(orderId)}
                disabled={isBusy}
                className="text-red-400 hover:bg-red-500/20 hover:text-red-400"
              >
                {isBusy ? "..." : "Cancel"}
              </Button>
            </>
          )}
        </div>
      </div>
      {editing && isOpen && (
        <div className="mt-2 space-y-3 rounded-sm border border-panel-border bg-panel px-2 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="xs" disabled className="h-7 w-auto cursor-default px-0.5 opacity-100">
              <SideBadge side={side === "BUY" ? "BUY" : "SELL"} className="min-w-[3.25rem] justify-center px-2 py-0.5 text-[11px]" />
            </Button>
            <Button variant="ghost" size="xs" disabled className="h-7 w-auto cursor-default px-0.5 opacity-100">
              <OptionTypeBadge optionType={optType === "PE" ? "PE" : "CE"} className="min-w-[2.75rem] justify-center px-2 py-0.5 text-[11px]" />
            </Button>
            <SegmentedControl
              value={draftOrderType}
              onValueChange={(value) => setDraftOrderType(normalizeBrokerOrderType(value))}
              options={[...BROKER_ORDER_TYPE_OPTIONS]}
              itemClassName="text-[11px] text-panel-faint hover:text-panel-muted"
            />
            <SegmentedControl
              value={draftValidity}
              onValueChange={(value) => setDraftValidity(normalizeValidity(value))}
              options={[...VALIDITY_OPTIONS]}
              itemClassName="text-[11px] text-panel-faint hover:text-panel-muted"
            />
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <NumberStepper
              label="Qty"
              value={draftQty}
              onChange={setDraftQty}
              step={1}
              min={1}
              widthClass="w-20"
            />
            <NumberStepper
              label="Price"
              value={draftPrice}
              onChange={setDraftPrice}
              step={0.05}
              min={0}
              disabled={draftOrderType === "MKT" || draftOrderType === "SL-M"}
            />
            <NumberStepper
              label="Trigger"
              value={draftTriggerPrice}
              onChange={setDraftTriggerPrice}
              step={0.05}
              min={0}
              disabled={draftOrderType !== "SL" && draftOrderType !== "SL-M"}
            />
            <NumberStepper
              label="Disclosed"
              value={draftDisclosedQty}
              onChange={setDraftDisclosedQty}
              step={1}
              min={0}
              max={draftQty}
            />
          </div>
          <div className="flex items-center gap-2">
            {localError && <span className="text-[11px] text-red-400">{localError}</span>}
            <Button
              variant="outline"
              size="xs"
              onClick={() => {
                setLocalError(null);
                setDraftQty(total);
                setDraftPrice(price);
                setDraftTriggerPrice(triggerPrice);
                setDraftDisclosedQty(disclosedQty);
                setDraftOrderType(orderType);
                setDraftValidity(validity);
                setEditing(false);
              }}
              disabled={isBusy}
            >
              Reset
            </Button>
            <Button size="xs" onClick={() => void submitModify()} disabled={isBusy}>
              {isBusy ? "..." : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
