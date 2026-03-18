"use client";

import type { ReactNode } from "react";

import type { PanelId } from "@/types/panels";
import { OptionChainPanel } from "@/components/option-chain/option-chain-panel";
import { PriceChartPanel } from "@/components/charts/price-chart-panel";
import { PayoffDiagram } from "@/components/charts/payoff-diagram";
import { IvSkewChart } from "@/components/charts/iv-skew-chart";
import { VolSurface } from "@/components/charts/vol-surface";
import { PositionMonitor } from "@/components/positions/position-monitor";
import { BasketPanel } from "@/components/order-basket/basket-panel";
import { GreeksExposure } from "@/components/greeks/greeks-exposure";
import { ModelComparisonPanel } from "@/components/charts/model-comparison-panel";

export function renderPanelContent(id: PanelId): ReactNode {
  switch (id) {
    case "option-chain":
      return <OptionChainPanel />;
    case "price-chart":
      return <PriceChartPanel />;
    case "payoff-diagram":
      return <PayoffDiagram />;
    case "iv-skew":
      return <IvSkewChart />;
    case "vol-surface":
      return <VolSurface />;
    case "positions":
      return <PositionMonitor />;
    case "order-basket":
      return <BasketPanel />;
    case "greeks-exposure":
      return <GreeksExposure />;
    case "model-comparison":
      return <ModelComparisonPanel />;
    default: {
      const _exhaustive: never = id;
      return <div>Unknown panel: {_exhaustive}</div>;
    }
  }
}
