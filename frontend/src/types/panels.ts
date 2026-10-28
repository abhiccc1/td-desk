export type PanelId =
  | "option-chain"
  | "price-chart"
  | "payoff-diagram"
  | "iv-skew"
  | "vol-surface"
  | "positions"
  | "paper-positions"
  | "order-basket"
  | "risk-management"
  | "greeks-exposure"
  | "model-comparison"
  | "mispricing-scanner"
  | "adjustments";

export const PANEL_IDS: PanelId[] = [
  "option-chain",
  "price-chart",
  "payoff-diagram",
  "iv-skew",
  "vol-surface",
  "model-comparison",
  "mispricing-scanner",
  "positions",
  "paper-positions",
  "risk-management",
  "greeks-exposure",
  "adjustments",
];

export const PANEL_TITLES: Record<PanelId, string> = {
  "option-chain": "Option Chain",
  "price-chart": "Price Chart",
  "payoff-diagram": "Payoff Diagram",
  "iv-skew": "IV Skew",
  "vol-surface": "Vol Surface",
  "model-comparison": "Model Comparison",
  "mispricing-scanner": "Mispricing Scanner",
  positions: "Positions",
  "paper-positions": "Paper Positions",
  "order-basket": "Order Basket",
  "risk-management": "Risk Management",
  "greeks-exposure": "Greeks Exposure",
  adjustments: "Adjustments",
};
