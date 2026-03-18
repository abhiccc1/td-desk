export interface TickData {
  symbol: string;
  exchange: string;
  ltp: number;
  bid: number;
  ask: number;
  bidQty: number;
  askQty: number;
  volume: number;
  oi: number;
  turnover: number;
  timestamp: string;
}

export interface OptionStrike {
  strike: number;
  call: TickData | null;
  put: TickData | null;
}

export interface OptionChainSnapshot {
  underlying: string;
  underlyingPrice: number;
  expiry: string;
  exchange: string;
  strikes: OptionStrike[];
  timestamp: string;
  sourceTimestamp?: string | null;
}

export interface GreeksResult {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: string;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  underlyingPrice: number;
  timestamp: string;
}

export interface SviParams {
  underlying: string;
  expiry: string;
  a: number;
  b: number;
  rho: number;
  m: number;
  sigma: number;
  rmse: number;
  arbitrageFree: boolean;
  timestamp: string;
}

export interface ModelStrikeResult {
  strike: number;
  hestonIv: number | null;
  vgIv: number | null;
  hestonCallPrice: number | null;
  hestonPutPrice: number | null;
  vgCallPrice: number | null;
  vgPutPrice: number | null;
}

export interface ModelPricesResult {
  underlying: string;
  expiry: string;
  spot: number;
  hestonParams: Record<string, number>;
  vgParams: Record<string, number>;
  strikes: ModelStrikeResult[];
  timestamp: string;
}

export type OptionType = "CE" | "PE";
export type Side = "BUY" | "SELL";
export type OrderType = "LIMIT" | "MARKET" | "SL" | "SL-M";
/** Kotak API product types for F&O: NRML = carry-forward, MIS = intraday auto-square-off */
export type ProductType = "NRML" | "MIS";

export interface StrategyLeg {
  symbol: string;
  strike: number;
  optionType: OptionType;
  side: Side;
  quantity: number;
  premium: number;
  orderType: OrderType;
  productType: ProductType;
}

export interface MarginInfo {
  initialMargin: number;
  maintenanceMargin: number;
  collateralUtilization: number;
}

export interface StrategyResult {
  legs: StrategyLeg[];
  netCredit: number;
  maxProfit: number;
  maxLoss: number;
  breakevenPoints: number[];
  probabilityOfProfit: number;
  margin: MarginInfo;
  payoffX: number[];
  payoffY: number[];
}
