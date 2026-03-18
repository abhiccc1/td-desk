"use client";

import type { StrategyTemplate, ParamValues, StrikeMode } from "./strategy-templates";
import { getEffectiveParam } from "./strategy-templates";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";

const STRIKE_MODES: { value: StrikeMode; label: string }[] = [
  { value: "offset", label: "Offset" },
  { value: "delta", label: "Delta" },
  { value: "premium", label: "Premium" },
  { value: "svi-edge", label: "Edge" },
];

interface StrategyConfigBarProps {
  template: StrategyTemplate;
  paramValues: ParamValues;
  strikeMode: StrikeMode;
  onParamChange: (key: string, value: number) => void;
  onStrikeModeChange: (mode: StrikeMode) => void;
  onApply: () => void;
  onSave: () => void;
}

export function StrategyConfigBar({
  template,
  paramValues,
  strikeMode,
  onParamChange,
  onStrikeModeChange,
  onApply,
  onSave,
}: StrategyConfigBarProps) {
  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-panel-border bg-panel-header px-3 py-2">
      <SegmentedControl
        value={strikeMode}
        onValueChange={onStrikeModeChange}
        options={STRIKE_MODES}
        itemClassName="min-w-16 text-panel-faint hover:text-panel-subtle"
      />

      {strikeMode === "svi-edge" ? (
        <span className="text-[10px] text-panel-dim">Auto-selects strikes with max IV edge</span>
      ) : (
        template.params.map((p) => {
          const eff = getEffectiveParam(p, strikeMode);
          return (
            <label key={p.key} className="flex items-center gap-1.5">
              <span className="text-xs text-panel-faint">{eff.label}</span>
              <Input
                type="number"
                value={paramValues[p.key] ?? eff.default}
                min={eff.min}
                max={eff.max}
                step={eff.step}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  if (Number.isNaN(raw)) return;
                  const val = Math.round(raw * 100) / 100;
                  const clamped = Math.max(eff.min, Math.min(eff.max, val));
                  onParamChange(p.key, clamped);
                }}
                onBlur={(e) => {
                  const raw = Number(e.target.value);
                  if (Number.isNaN(raw) || raw < eff.min) {
                    onParamChange(p.key, eff.min);
                  } else if (raw > eff.max) {
                    onParamChange(p.key, eff.max);
                  }
                }}
                className="h-7 w-[4.5rem] border-panel-border bg-panel px-2 text-center text-sm text-panel-muted [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
              />
            </label>
          );
        })
      )}

      <div className="ml-auto flex items-center gap-2">
        <Button
          size="sm"
          onClick={onApply}
          className="h-7 rounded-sm bg-blue-600 text-white hover:bg-blue-700"
        >
          Apply
        </Button>
        <Button
          size="sm"
          onClick={onSave}
          className="h-7 rounded-sm bg-blue-600 text-white hover:bg-blue-700"
        >
          Save
        </Button>
      </div>
    </div>
  );
}
