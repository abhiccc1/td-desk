"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type OptionType = "CE" | "PE";
type Side = "BUY" | "SELL";

interface OptionTypeBadgeProps {
  optionType: OptionType;
  className?: string;
}

interface SideBadgeProps {
  side: Side;
  className?: string;
  short?: boolean;
}

function OptionTypeBadge({ optionType, className }: OptionTypeBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "border-transparent px-1.5 py-0.5 text-[10px] font-bold text-white",
        optionType === "CE"
          ? "bg-green-600"
          : "bg-red-600",
        className,
      )}
    >
      {optionType}
    </Badge>
  );
}

function SideBadge({ side, className, short = false }: SideBadgeProps) {
  return (
    <Badge
      variant="secondary"
      className={cn(
        "px-1.5 py-0.5 text-[10px] font-bold",
        side === "BUY"
          ? "bg-green-500/20 text-green-400"
          : "bg-red-500/20 text-red-400",
        className,
      )}
    >
      {short ? side.charAt(0) : side}
    </Badge>
  );
}

export { OptionTypeBadge, SideBadge };
