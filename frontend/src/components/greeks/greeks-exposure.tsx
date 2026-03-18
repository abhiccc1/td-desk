"use client";

import { useGreeksStore } from "@/stores/greeks-store";

interface GreekCardProps {
  label: string;
  value: number;
  decimals?: number;
}

function GreekCard({ label, value, decimals = 2 }: GreekCardProps) {
  const color =
    value > 0
      ? "text-green-400"
      : value < 0
        ? "text-red-400"
        : "text-panel-muted";

  return (
    <div className="flex flex-col items-center justify-center rounded-lg border border-panel-border bg-panel-header px-4 py-3">
      <span className="mb-1 text-[10px] font-medium uppercase tracking-wider text-panel-subtle">
        {label}
      </span>
      <span className={`text-xl font-bold tabular-nums ${color}`}>
        {value >= 0 ? "+" : ""}
        {value.toFixed(decimals)}
      </span>
    </div>
  );
}

export function GreeksExposure() {
  const netDelta = useGreeksStore((s) => s.netDelta);
  const netGamma = useGreeksStore((s) => s.netGamma);
  const netTheta = useGreeksStore((s) => s.netTheta);
  const netVega = useGreeksStore((s) => s.netVega);

  return (
    <div className="flex h-full w-full items-center justify-center bg-panel p-4">
      <div className="grid w-full max-w-md grid-cols-2 gap-3">
        <GreekCard label="Delta" value={netDelta} decimals={2} />
        <GreekCard label="Gamma" value={netGamma} decimals={4} />
        <GreekCard label="Theta" value={netTheta} decimals={2} />
        <GreekCard label="Vega" value={netVega} decimals={2} />
      </div>
    </div>
  );
}
