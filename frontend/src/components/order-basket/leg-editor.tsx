"use client";

import { useCallback } from "react";
import { priceTick, underlyingOfSymbol } from "@/lib/instruments";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { OptionTypeBadge, SideBadge } from "@/components/ui/trading-label";

import type { StrategyLeg } from "@/types/market-data";

interface LegEditorProps {
  leg: StrategyLeg;
  index: number;
  onUpdate: (index: number, update: Partial<StrategyLeg>) => void;
  onRemove: (index: number) => void;
}

export function LegEditor({ leg, index, onUpdate, onRemove }: LegEditorProps) {
  const handleChange = useCallback(
    (field: keyof StrategyLeg, value: string | number) => {
      onUpdate(index, { [field]: value });
    },
    [index, onUpdate],
  );

  const handleRemove = useCallback(() => {
    onRemove(index);
  }, [index, onRemove]);

  return (
    <div className="flex items-center gap-1.5 rounded-sm border border-panel-border bg-panel-header px-2 py-1.5">
      <span className="shrink-0 text-[10px] font-bold text-panel-subtle">
        L{index + 1}
      </span>

      <Input
        type="text"
        value={leg.symbol}
        onChange={(e) => handleChange("symbol", e.target.value)}
        placeholder="Symbol"
        className="h-7 w-20 border-panel-border bg-panel px-1.5 py-0.5 text-xs text-panel-muted placeholder:text-panel-faint"
      />

      <Input
        type="number"
        value={leg.strike || ""}
        onChange={(e) =>
          handleChange("strike", parseFloat(e.target.value) || 0)
        }
        placeholder="Strike"
        className="h-7 w-16 border-panel-border bg-panel px-1.5 py-0.5 text-xs text-panel-muted placeholder:text-panel-faint"
      />

      <SegmentedControl
        value={leg.optionType}
        onValueChange={(value) => handleChange("optionType", value)}
        options={[
          {
            value: "CE",
            label: <OptionTypeBadge optionType="CE" className="px-1 py-0 text-[11px]" />,
            title: "Call option",
          },
          {
            value: "PE",
            label: <OptionTypeBadge optionType="PE" className="px-1 py-0 text-[11px]" />,
            title: "Put option",
          },
        ]}
      />

      <SegmentedControl
        value={leg.side}
        onValueChange={(value) => handleChange("side", value)}
        options={[
          {
            value: "BUY",
            label: <SideBadge side="BUY" className="px-1 py-0 text-[11px]" />,
            title: "Buy side",
          },
          {
            value: "SELL",
            label: <SideBadge side="SELL" className="px-1 py-0 text-[11px]" />,
            title: "Sell side",
          },
        ]}
      />

      <Input
        type="number"
        value={leg.quantity || ""}
        onChange={(e) =>
          handleChange("quantity", parseInt(e.target.value, 10) || 0)
        }
        placeholder="Qty"
        min={1}
        className="h-7 w-12 border-panel-border bg-panel px-1.5 py-0.5 text-xs text-panel-muted placeholder:text-panel-faint"
      />

      <Input
        type="number"
        value={leg.premium || ""}
        onChange={(e) =>
          handleChange("premium", parseFloat(e.target.value) || 0)
        }
        placeholder="Premium"
        step={priceTick(underlyingOfSymbol(leg.symbol))}
        className="h-7 w-16 border-panel-border bg-panel px-1.5 py-0.5 text-xs text-panel-muted placeholder:text-panel-faint"
      />

      <Select
        value={leg.orderType}
        onChange={(e) => handleChange("orderType", e.target.value)}
        className="h-7 w-auto border-panel-border bg-panel px-1 py-0.5 text-xs text-panel-muted"
      >
        <option value="LIMIT">LMT</option>
        <option value="MARKET">MKT</option>
        <option value="SL">SL</option>
        <option value="SL-M">SL-M</option>
      </Select>

      <Button
        onClick={handleRemove}
        variant="ghost"
        size="xs"
        className="ml-auto shrink-0 text-red-400 hover:bg-red-500/20 hover:text-red-300"
        title="Remove leg"
      >
        X
      </Button>
    </div>
  );
}
