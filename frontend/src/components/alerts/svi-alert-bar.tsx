"use client";

import { AlertTriangle, Info, XCircle, X } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useNow } from "@/hooks/use-now";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { SviAlert } from "@/stores/market-data-store";

const ICON_MAP: Record<string, typeof AlertTriangle> = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const VARIANT_MAP: Record<string, "default" | "destructive"> = {
  error: "destructive",
  warning: "default",
  info: "default",
};

const COLOR_MAP: Record<string, string> = {
  error: "border-red-500/40 bg-red-500/5 text-red-400",
  warning: "border-yellow-500/40 bg-yellow-500/5 text-yellow-400",
  info: "border-blue-500/40 bg-blue-500/5 text-blue-400",
};

function AlertItem({ alert, index }: { alert: SviAlert; index: number }) {
  const dismiss = useMarketDataStore((s) => s.dismissSviAlert);
  const now = useNow();
  const Icon = ICON_MAP[alert.level] || Info;
  const colorClass = COLOR_MAP[alert.level] || COLOR_MAP.info;

  const age = alert.timestamp ? Math.round((now - alert.timestamp) / 1000) : 0;
  const ageLabel = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;

  return (
    <Alert
      variant={VARIANT_MAP[alert.level]}
      className={`relative py-2 ${colorClass}`}
    >
      <Icon className="h-3.5 w-3.5" />
      <AlertTitle className="text-xs font-semibold leading-none">
        {alert.title}
        <span className="ml-2 text-[10px] font-normal opacity-60">{ageLabel}</span>
      </AlertTitle>
      <AlertDescription className="text-[11px] opacity-80">
        {alert.message}
      </AlertDescription>
      <button
        onClick={() => dismiss(index)}
        className="absolute right-2 top-2 text-current opacity-40 hover:opacity-100"
      >
        <X className="h-3 w-3" />
      </button>
    </Alert>
  );
}

export function SviAlertBar() {
  const alerts = useMarketDataStore((s) => s.sviAlerts);

  if (alerts.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-[#2a2a4a] bg-[#16213e] px-2 py-1.5">
      {alerts.slice(0, 3).map((alert, i) => (
        <AlertItem key={`${alert.title}-${alert.timestamp}`} alert={alert} index={i} />
      ))}
      {alerts.length > 3 && (
        <span className="text-center text-[10px] text-panel-subtle">
          +{alerts.length - 3} more alerts
        </span>
      )}
    </div>
  );
}
