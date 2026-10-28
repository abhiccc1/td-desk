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
  /** Options on futures (MCX): the future this expiry devolves into; underlyingPrice is its LTP. */
  underlyingFuture?: {
    symbol: string;
    tradingSymbol: string;
    token: string;
    expiry: string;
  } | null;
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
  vanna: number;
  charm: number;
  vomma: number;
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
  hestonPop: number | null;
  vgPop: number | null;
}

export interface ModelPricesResult {
  underlying: string;
  expiry: string;
  spot: number;
  hestonParams: Record<string, number>;
  vgParams: Record<string, number>;
  hestonCalibrated: boolean;
  vgCalibrated: boolean;
  hestonRmse: number | null;
  vgRmse: number | null;
  strikes: ModelStrikeResult[];
  hestonDensity: [number, number][] | null;
  vgDensity: [number, number][] | null;
  timestamp: string;
}

export interface VrpResult {
  underlying: string;
  atmIv: number;
  realizedVol: number;
  vrp: number;
  ivRank: number | null;  // 0-100 percentile
  windowDays: number;
  timestamp: string;
}

export type RiskSeverity = "safe" | "elevated" | "high" | "critical";
export type RiskRegime = "low" | "neutral" | "high";
export type RegimeLabel = "compressed" | "balanced" | "elevated" | "stressed" | "event_rich" | "unknown";
export type TradeQualityLabel = "poor" | "mixed" | "favorable" | "strong" | "unknown";

export interface RegimeSnapshot {
  underlying: string;
  expiry: string | null;
  regimeLabel: RegimeLabel;
  confidence: string;
  drivers: string[];
  termStructureSlopePctile: number | null;
  skewIndicatorPctile: number | null;
  convexityIndicatorPctile: number | null;
  eventTags: string[];
}

export interface TradeQualityAssessment {
  style: string;
  overallLabel: TradeQualityLabel;
  overallScore: number | null;
  regimeFitScore: number | null;
  edgeScore: number | null;
  confidence: string;
  qualityRank: number | null;
  rationale: string[];
  headwinds: string[];
}

export interface RiskFlag {
  id?: string;
  severity: RiskSeverity;
  label: string;
  detail: string;
  context?: string;
}

export type SuggestionConfidence = "low" | "medium" | "high";

export interface AdjustmentSuggestion {
  id?: string;
  severity: RiskSeverity;
  label: string;
  rationale: string;
  action: string;
  estimatedImpact?: string;
  confidence: SuggestionConfidence;
  qualityRank: number | null;
  prerequisites: string[];
  context?: string;
}

export type AdjustmentActionType = "roll" | "add_wing" | "close_partial" | "convert";

export interface AdjustmentRecLeg {
  symbol: string;
  strike: number;
  optionType: string;
  expiry: string;
  side: string;
  quantity: number;
  estimatedPrice: number;
  bid: number;
  ask: number;
}

export interface GreekExposureSummary {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
}

export interface AdjustmentRecommendation {
  id: string;
  title: string;
  description: string;
  actionType: AdjustmentActionType;
  legs: AdjustmentRecLeg[];
  currentGreeks: GreekExposureSummary;
  projectedGreeks: GreekExposureSummary;
  currentMaxLoss: number | null;
  projectedMaxLoss: number | null;
  currentPop: number | null;
  projectedPop: number | null;
  netCredit: number;
  efficiencyScore: number;
  profitImpactPct: number;
  riskImpactPct: number;
  trigger: string;
  confidence: SuggestionConfidence;
  warnings: string[];
}

export interface PortfolioRiskLeg {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: OptionType;
  side: Side;
  quantity: number;
  premium: number;
  ltp: number | null;
  iv: number | null;
  spot: number | null;
  dte: number | null;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
  exposureValue: number | null;
}

export interface ScenarioPnl {
  spotDown: number;
  spotUp: number;
  pnlDown: number;
  pnlUp: number;
  worstPnl: number;
}

export interface PortfolioRiskGroup {
  underlying: string;
  spot: number | null;
  iv: number | null;
  ivRank: number | null;
  ivRegime: RiskRegime | null;
  dteMin: number | null;
  openLegCount: number;
  expiryCount: number;
  exposureValue: number | null;
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netVanna: number;
  netCharm: number;
  netVomma: number;
  expectedMove: number | null;
  expectedMovePct: number | null;
  var5: number | null;
  es5: number | null;
  riskNeutralPop: number | null;
  vgPop: number | null;
  marketPop: number | null;
  popEdge: number | null;
  marginUsed: number | null;
  marginHeadroom: number | null;
  concentrationPct: number | null;
  scenario1s: ScenarioPnl | null;
  scenario2s: ScenarioPnl | null;
  scenario3s: ScenarioPnl | null;
  regimeSnapshot: RegimeSnapshot | null;
  tradeQuality: TradeQualityAssessment | null;
  flags: RiskFlag[];
  suggestions: AdjustmentSuggestion[];
  legs: PortfolioRiskLeg[];
}

export interface PortfolioRiskSummary {
  openPositionCount: number;
  underlyingCount: number;
  totalExposureValue: number | null;
  totalExpectedMove: number | null;
  totalVar5: number | null;
  totalEs5: number | null;
  netDelta: number;
  netGamma: number;
  netTheta: number;
  netVega: number;
  netVanna: number;
  netCharm: number;
  netVomma: number;
  maxSeverity: RiskSeverity;
  flags: RiskFlag[];
  suggestions: AdjustmentSuggestion[];
}

export interface PortfolioRiskResult {
  source: "backend" | "client";
  generatedAt: string;
  selectedUnderlying: string | null;
  selectedExpiry: string | null;
  accountNet: number | null;
  availableMargin: number | null;
  marginUsed: number | null;
  marginHeadroom: number | null;
  openPositionCount: number;
  underlyingCount: number;
  groups: PortfolioRiskGroup[];
  summary: PortfolioRiskSummary;
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
  underlying?: string;
  expiry?: string;
  spot?: number;
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
  riskNeutralPop: number | null;
  vgPop: number | null;
  densityX: number[] | null;
  densityY: number[] | null;
  var5: number | null;
  es5: number | null;
  marketPop: number | null;
  popEdge: number | null;
  regimeSnapshot: RegimeSnapshot | null;
  tradeQuality: TradeQualityAssessment | null;
}

