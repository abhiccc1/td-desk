"use client";

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  title?: string;
}

interface SegmentedControlProps<T extends string> {
  value: T;
  onValueChange: (value: T) => void;
  options: SegmentedOption<T>[];
  className?: string;
  itemClassName?: string;
  size?: "sm" | "default";
  fullWidth?: boolean;
}

function SegmentedControl<T extends string>({
  value,
  onValueChange,
  options,
  className,
  itemClassName,
  size = "sm",
  fullWidth = false,
}: SegmentedControlProps<T>) {
  return (
    <div
      role="group"
      className={cn(
        "inline-flex items-stretch overflow-hidden rounded-lg border border-input bg-transparent p-0",
        fullWidth ? "w-full" : "w-fit",
        className,
      )}
    >
      {options.map((option) => {
        const isSelected = option.value === value;

        return (
          <button
            key={option.value}
            type="button"
            title={option.title}
            aria-pressed={isSelected}
            onClick={() => onValueChange(option.value)}
            className={cn(
              "inline-flex items-center justify-center whitespace-nowrap border-0 text-sm font-medium outline-none transition-colors focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring/50",
              size === "sm" ? "h-7 px-2 text-[0.8rem]" : "h-8 px-2",
              fullWidth && "flex-1",
              itemClassName,
              isSelected
                ? "bg-blue-600 text-white hover:bg-blue-700 hover:text-white"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export { SegmentedControl };
