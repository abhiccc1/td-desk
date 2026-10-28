"use client";

import { useEffect, useMemo, useState } from "react";

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

function ParamInput({
  paramKey,
  label,
  value,
  min,
  max,
  step,
  allowAnyValue,
  onParamChange,
}: {
  paramKey: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  allowAnyValue: boolean;
  onParamChange: (key: string, value: number) => void;
}) {
  const [draftValue, setDraftValue] = useState(() => String(value));

  useEffect(() => {
    setDraftValue(String(value));
  }, [value]);

  return (
    <label className="flex items-center gap-1.5">
      <span className="text-xs text-panel-faint">{label}</span>
      <Input
        type="number"
        value={draftValue}
        min={allowAnyValue ? undefined : min}
        max={allowAnyValue ? undefined : max}
        step={step}
        onChange={(e) => {
          const nextValue = e.target.value;
          setDraftValue(nextValue);
          const raw = Number(nextValue);
          if (nextValue === "" || Number.isNaN(raw)) return;
          onParamChange(
            paramKey,
            allowAnyValue ? raw : Math.max(min, Math.min(max, raw)),
          );
        }}
        onBlur={(e) => {
          const raw = Number(e.target.value);
          if (Number.isNaN(raw)) {
            setDraftValue(String(value));
            return;
          }

          const nextValue = allowAnyValue ? raw : Math.max(min, Math.min(max, raw));
          onParamChange(paramKey, nextValue);
          setDraftValue(String(nextValue));
        }}
        className="h-7 w-[4.5rem] border-panel-border bg-panel px-2 text-center text-sm text-panel-muted [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
    </label>
  );
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
  const effectiveParams = useMemo(
    () =>
      template.params.map((param) => ({
        param,
        effective: getEffectiveParam(param, strikeMode),
      })),
    [template.params, strikeMode],
  );

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
        effectiveParams.map(({ param, effective }) => {
          const allowAnyValue =
            strikeMode === "premium" || strikeMode === "delta";
          const currentValue = paramValues[param.key] ?? effective.default;
          return (
            <ParamInput
              key={`${strikeMode}:${param.key}`}
              paramKey={param.key}
              label={effective.label}
              value={currentValue}
              min={effective.min}
              max={effective.max}
              step={effective.step}
              allowAnyValue={allowAnyValue}
              onParamChange={onParamChange}
            />
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
