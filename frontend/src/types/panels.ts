export type PanelId =
  | "option-chain"
  | "price-chart"
  | "payoff-diagram"
  | "iv-skew"
  | "vol-surface"
  | "positions"
  | "order-basket"
  | "greeks-exposure"
  | "model-comparison";

export const PANEL_IDS: PanelId[] = [
  "option-chain",
  "price-chart",
  "payoff-diagram",
  "iv-skew",
  "vol-surface",
  "model-comparison",
  "positions",
  "greeks-exposure",
];

export const PANEL_TITLES: Record<PanelId, string> = {
  "option-chain": "Option Chain",
  "price-chart": "Price Chart",
  "payoff-diagram": "Payoff Diagram",
  "iv-skew": "IV Skew",
  "vol-surface": "Vol Surface",
  "model-comparison": "Model Comparison",
  positions: "Positions",
  "order-basket": "Order Basket",
  "greeks-exposure": "Greeks Exposure",
};
