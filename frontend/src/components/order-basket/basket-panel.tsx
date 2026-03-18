"use client";

import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";

import { useBasketStore } from "@/stores/basket-store";
import { analyzeStrategy, submitBasket } from "@/lib/api-client";
import type { StrategyLeg } from "@/types/market-data";
import { LegEditor } from "./leg-editor";

const DEFAULT_LEG: StrategyLeg = {
  symbol: "",
  strike: 0,
  optionType: "CE",
  side: "BUY",
  quantity: 1,
  premium: 0,
  orderType: "LIMIT",
  productType: "NRML",
};

export function BasketPanel() {
  const legs = useBasketStore((s) => s.legs);
  const netCredit = useBasketStore((s) => s.netCredit);
  const basketId = useBasketStore((s) => s.basketId);
  const status = useBasketStore((s) => s.status);
  const addLeg = useBasketStore((s) => s.addLeg);
  const removeLeg = useBasketStore((s) => s.removeLeg);
  const updateLeg = useBasketStore((s) => s.updateLeg);
  const setStatus = useBasketStore((s) => s.setStatus);

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddLeg = useCallback(() => {
    addLeg({ ...DEFAULT_LEG });
  }, [addLeg]);

  const handleUpdateLeg = useCallback(
    (index: number, update: Partial<StrategyLeg>) => {
      updateLeg(index, update);
    },
    [updateLeg],
  );

  const handleRemoveLeg = useCallback(
    (index: number) => {
      removeLeg(index);
    },
    [removeLeg],
  );

  const handleAnalyze = useCallback(async () => {
    if (legs.length === 0) return;
    setIsAnalyzing(true);
    setError(null);
    try {
      await analyzeStrategy(legs);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Strategy analysis failed",
      );
    } finally {
      setIsAnalyzing(false);
    }
  }, [legs]);

  const handleSubmit = useCallback(async () => {
    if (!basketId || legs.length === 0) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await submitBasket(basketId);
      setStatus("SUBMITTED");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Basket submission failed");
    } finally {
      setIsSubmitting(false);
    }
  }, [basketId, legs.length, setStatus]);

  return (
    <div className="flex h-full flex-col bg-panel text-panel-muted">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {legs.length === 0 && (
          <p className="py-8 text-center text-xs text-panel-subtle">
            No legs added. Click &quot;Add Leg&quot; to start building a
            strategy.
          </p>
        )}

        <div className="flex flex-col gap-2">
          {legs.map((leg, index) => (
            <LegEditor
              key={index}
              leg={leg}
              index={index}
              onUpdate={handleUpdateLeg}
              onRemove={handleRemoveLeg}
            />
          ))}
        </div>
      </div>

      {error && (
        <div className="border-t border-red-500/30 bg-red-500/10 px-3 py-1.5">
          <p className="text-xs text-red-400">{error}</p>
        </div>
      )}

      <div className="border-t border-panel-border px-3 py-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-xs text-panel-subtle">
            {netCredit >= 0 ? "Net Credit" : "Net Debit"}
          </span>
          <span
            className={`text-sm font-bold ${
              netCredit >= 0 ? "text-green-400" : "text-red-400"
            }`}
          >
            {Math.abs(netCredit).toFixed(2)}
          </span>
        </div>

        <div className="mb-1 text-xs text-panel-subtle">
          Status: <span className="font-medium text-panel-muted">{status}</span>
        </div>

        <div className="flex items-center gap-2">
          <Button
            onClick={handleAddLeg}
            variant="outline"
            size="xs"
            className="border-panel-border bg-panel-header text-panel-muted hover:bg-panel-header"
          >
            Add Leg
          </Button>

          <Button
            onClick={handleAnalyze}
            disabled={isAnalyzing || legs.length === 0}
            size="xs"
            className="bg-blue-600 text-white hover:bg-blue-700"
          >
            {isAnalyzing ? "Analyzing..." : "Analyze"}
          </Button>

          <Button
            onClick={handleSubmit}
            disabled={isSubmitting || legs.length === 0 || !basketId}
            size="xs"
            className="bg-green-600 text-white hover:bg-green-700"
          >
            {isSubmitting ? "Submitting..." : "Submit"}
          </Button>
        </div>
      </div>
    </div>
  );
}
