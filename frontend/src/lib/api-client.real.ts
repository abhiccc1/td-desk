import type {
  AdjustmentRecommendation,
  AdjustmentSuggestion,
  GreeksResult,
  ModelPricesResult,
  OptionChainSnapshot,
  PortfolioRiskResult,
  RegimeSnapshot,
  RiskFlag,
  RiskRegime,
  RiskSeverity,
  StrategyLeg,
  StrategyResult,
  SviParams,
  TradeQualityAssessment,
} from "@/types/market-data";
import { getConfig } from "@/lib/config";
import { isFuturesUnderlying, underlyingOfSymbol } from "@/lib/instruments";
import { getLotSize } from "@/lib/lot-sizes";

/** Recursively convert snake_case keys to camelCase */
function snakeToCamel(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(snakeToCamel);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, val]) => [
        key.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase()),
        snakeToCamel(val),
      ]),
    );
  }
  return obj;
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { apiUrl } = getConfig();
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...options,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(
      `API request failed: ${response.status} ${response.statusText} — ${errorBody}`,
    );
  }

  return response.json() as Promise<T>;
}

interface BackendRiskFlag {
  code: string;
  severity: RiskSeverity;
  title: string;
  message: string;
  underlying?: string | null;
  expiry?: string | null;
}

interface BackendAdjustmentSuggestion {
  ruleId: string;
  severity: RiskSeverity;
  title: string;
  rationale: string;
  action: string;
  estimatedImpact?: string | null;
  confidence: "low" | "medium" | "high";
  qualityRank?: number | null;
  prerequisites?: string[] | null;
  underlying?: string | null;
  expiry?: string | null;
}

interface BackendGreekExposure {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
}

interface BackendScenarioPnl {
  spotDown: number;
  spotUp: number;
  pnlDown: number;
  pnlUp: number;
  worstPnl: number;
}

interface BackendTailRisk {
  expectedMove?: number | null;
  expectedMovePct?: number | null;
  dailyExpectedMove?: number | null;
  dailyExpectedMovePct?: number | null;
  oneSigmaDeltaPnl?: number | null;
  oneSigmaGammaPnl?: number | null;
  oneSigmaTotalPnl?: number | null;
  projectedDeltaDown?: number | null;
  projectedDeltaUp?: number | null;
  spot?: number | null;
  atmIv?: number | null;
  ivRank?: number | null;
  vrp?: number | null;
  scenario1S?: BackendScenarioPnl | null;
  scenario2S?: BackendScenarioPnl | null;
  scenario3S?: BackendScenarioPnl | null;
}

interface BackendExpiryRiskSummary {
  underlying: string;
  expiry: string;
  spot?: number | null;
  dte?: number | null;
  positionCount: number;
  lotNotional?: number | null;
  exposures: BackendGreekExposure;
  tailRisk?: BackendTailRisk | null;
  riskLevel: RiskSeverity;
  flags: BackendRiskFlag[];
  strategy?: StrategyResult | null;
}

interface BackendUnderlyingRiskSummary {
  underlying: string;
  spot?: number | null;
  atmIv?: number | null;
  ivRank?: number | null;
  vrp?: number | null;
  positionCount: number;
  expiryCount: number;
  exposures: BackendGreekExposure;
  tailRisk?: BackendTailRisk | null;
  riskLevel: RiskSeverity;
  flags: BackendRiskFlag[];
  suggestions?: BackendAdjustmentSuggestion[];
  regimeSnapshot?: RegimeSnapshot | null;
  tradeQuality?: TradeQualityAssessment | null;
  expiries: BackendExpiryRiskSummary[];
  strategy?: StrategyResult | null;
  marginEstimate?: number | null;
  accountNetShare?: number | null;
  marginUtilization?: number | null;
}

interface BackendPortfolioRiskResult {
  asOf: string;
  accountNet?: number | null;
  availableMargin?: number | null;
  marginUsed?: number | null;
  collateral?: number | null;
  positionCount: number;
  underlyingCount: number;
  expiryCount: number;
  exposures: BackendGreekExposure;
  riskLevel: RiskSeverity;
  flags: BackendRiskFlag[];
  suggestions?: BackendAdjustmentSuggestion[];
  underlyings: BackendUnderlyingRiskSummary[];
}

function deriveRiskRegime(iv: number | null, ivRank: number | null): RiskRegime | null {
  if (ivRank !== null) {
    if (ivRank >= 70) return "high";
    if (ivRank <= 30) return "low";
    return "neutral";
  }
  if (iv === null) return null;
  if (iv >= 0.35) return "high";
  if (iv <= 0.18) return "low";
  return "neutral";
}

function mapRiskFlag(flag: BackendRiskFlag): RiskFlag {
  const context = [flag.underlying, flag.expiry].filter(Boolean).join(" • ");
  return {
    id: flag.code,
    severity: flag.severity,
    label: flag.title,
    detail: flag.message,
    context: context || undefined,
  };
}

function mapAdjustmentSuggestion(suggestion: BackendAdjustmentSuggestion): AdjustmentSuggestion {
  const context = [suggestion.underlying, suggestion.expiry].filter(Boolean).join(" • ");
  return {
    id: suggestion.ruleId,
    severity: suggestion.severity,
    label: suggestion.title,
    rationale: suggestion.rationale,
    action: suggestion.action,
    estimatedImpact: suggestion.estimatedImpact ?? undefined,
    confidence: suggestion.confidence,
    qualityRank: suggestion.qualityRank ?? null,
    prerequisites: suggestion.prerequisites ?? [],
    context: context || undefined,
  };
}

function mapBackendPortfolioRisk(raw: BackendPortfolioRiskResult): PortfolioRiskResult {
  const totalMarginEstimate = raw.underlyings.reduce(
    (sum, group) => sum + (group.marginEstimate ?? 0),
    0,
  );

  const groups = raw.underlyings.map((group) => {
    const strategy = group.strategy
      ?? group.expiries.find((expiry) => expiry.strategy != null)?.strategy
      ?? null;
    const dteValues = group.expiries
      .map((expiry) => expiry.dte)
      .filter((value): value is number => typeof value === "number");
    const concentrationPct = totalMarginEstimate > 0 && group.marginEstimate != null
      ? group.marginEstimate / totalMarginEstimate
      : null;

    return {
      underlying: group.underlying,
      spot: group.spot ?? group.tailRisk?.spot ?? null,
      iv: group.atmIv ?? group.tailRisk?.atmIv ?? null,
      ivRank: group.ivRank ?? group.tailRisk?.ivRank ?? null,
      ivRegime: deriveRiskRegime(
        group.atmIv ?? group.tailRisk?.atmIv ?? null,
        group.ivRank ?? group.tailRisk?.ivRank ?? null,
      ),
      dteMin: dteValues.length > 0 ? Math.min(...dteValues) : null,
      openLegCount: group.positionCount,
      expiryCount: group.expiryCount,
      exposureValue: group.marginEstimate ?? null,
      netDelta: group.exposures.delta,
      netGamma: group.exposures.gamma,
      netTheta: group.exposures.theta,
      netVega: group.exposures.vega,
      netVanna: group.exposures.vanna,
      netCharm: group.exposures.charm,
      netVomma: group.exposures.vomma,
      expectedMove: group.tailRisk?.dailyExpectedMove ?? group.tailRisk?.expectedMove ?? null,
      expectedMovePct: group.tailRisk?.dailyExpectedMovePct ?? group.tailRisk?.expectedMovePct ?? null,
      var5: strategy?.var5 ?? null,
      es5: strategy?.es5 ?? null,
      riskNeutralPop: strategy?.riskNeutralPop ?? null,
      vgPop: strategy?.vgPop ?? null,
      marketPop: strategy?.marketPop ?? null,
      popEdge: strategy?.popEdge ?? null,
      marginUsed: raw.marginUsed ?? null,
      marginHeadroom: raw.availableMargin ?? null,
      concentrationPct,
      scenario1s: group.tailRisk?.scenario1S ?? null,
      scenario2s: group.tailRisk?.scenario2S ?? null,
      scenario3s: group.tailRisk?.scenario3S ?? null,
      regimeSnapshot: group.regimeSnapshot ?? null,
      tradeQuality: group.tradeQuality ?? null,
      flags: group.flags.map(mapRiskFlag),
      suggestions: (group.suggestions ?? []).map(mapAdjustmentSuggestion),
      legs: [],
    };
  });

  const totalVar5 = groups.reduce((sum, group) => sum + (group.var5 ?? 0), 0);
  const totalEs5 = groups.reduce((sum, group) => sum + (group.es5 ?? 0), 0);
  const totalExpectedMove = groups.reduce((sum, group) => sum + Math.abs(group.expectedMove ?? 0), 0);

  return {
    source: "backend",
    generatedAt: raw.asOf,
    selectedUnderlying: null,
    selectedExpiry: null,
    accountNet: raw.accountNet ?? null,
    availableMargin: raw.availableMargin ?? null,
    marginUsed: raw.marginUsed ?? null,
    marginHeadroom: raw.availableMargin ?? null,
    openPositionCount: raw.positionCount,
    underlyingCount: raw.underlyingCount,
    groups,
    summary: {
      openPositionCount: raw.positionCount,
      underlyingCount: raw.underlyingCount,
      totalExposureValue: totalMarginEstimate > 0 ? totalMarginEstimate : null,
      totalExpectedMove: totalExpectedMove > 0 ? totalExpectedMove : null,
      totalVar5: totalVar5 !== 0 ? totalVar5 : null,
      totalEs5: totalEs5 !== 0 ? totalEs5 : null,
      netDelta: raw.exposures.delta,
      netGamma: raw.exposures.gamma,
      netTheta: raw.exposures.theta,
      netVega: raw.exposures.vega,
      netVanna: raw.exposures.vanna,
      netCharm: raw.exposures.charm,
      netVomma: raw.exposures.vomma,
      maxSeverity: raw.riskLevel,
      flags: raw.flags.map(mapRiskFlag),
      suggestions: (raw.suggestions ?? []).map(mapAdjustmentSuggestion),
    },
  };
}

export async function fetchOptionChain(
  underlying: string,
  expiry: string,
): Promise<OptionChainSnapshot> {
  return request<OptionChainSnapshot>(
    `/api/v1/option-chain/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
  );
}

export async function fetchGreeks(
  underlying: string,
  expiry: string,
): Promise<GreeksResult[]> {
  return request<GreeksResult[]>(
    `/api/v1/greeks/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
  );
}

export async function fetchStaticData(
  symbol: string,
): Promise<{ symbol: string; open: number; high: number; low: number; prevClose: number; change: number; pctChange: number } | null> {
  try {
    return await request<{ symbol: string; open: number; high: number; low: number; prevClose: number; change: number; pctChange: number }>(
      `/api/v1/static/${encodeURIComponent(symbol)}`,
    );
  } catch {
    return null;
  }
}

export async function fetchExpiries(
  underlying: string,
): Promise<string[]> {
  const data = await request<{ underlying: string; expiries: string[] }>(
    `/api/v1/expiries/${encodeURIComponent(underlying)}`,
  );
  return data.expiries;
}

export async function fetchAllExpiries(): Promise<{
  lastUpdated: string | null;
  expiriesByUnderlying: Record<string, string[]>;
}> {
  return request<{
    lastUpdated: string | null;
    expiriesByUnderlying: Record<string, string[]>;
  }>("/api/v1/expiries");
}

export async function createBasket(): Promise<{ basket_id: string }> {
  return request<{ basket_id: string }>("/api/v1/basket", {
    method: "POST",
  });
}

export async function addLeg(
  basketId: string,
  leg: unknown,
): Promise<unknown> {
  return request<unknown>(
    `/api/v1/basket/${encodeURIComponent(basketId)}/leg`,
    {
      method: "POST",
      body: JSON.stringify(leg),
    },
  );
}

export async function submitBasket(basketId: string): Promise<unknown> {
  return request<unknown>(
    `/api/v1/basket/${encodeURIComponent(basketId)}/submit`,
    {
      method: "POST",
    },
  );
}

export async function fetchOpenOrders(): Promise<unknown[]> {
  try {
    return await request<unknown[]>("/api/v1/open-orders");
  } catch {
    return [];
  }
}

export async function fetchOrderBook(): Promise<{ open: unknown[]; closed: unknown[] }> {
  try {
    return await request<{ open: unknown[]; closed: unknown[] }>("/api/v1/order-book");
  } catch {
    return { open: [], closed: [] };
  }
}

export async function cancelOrder(orderId: string): Promise<unknown> {
  return request<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
  });
}

export interface ModifyOrderPayload {
  /** Units; omit and send `lots` for MCX (backend converts). */
  quantity?: number;
  lots?: number;
  price: number;
  trigger_price: number;
  disclosed_quantity?: number;
  validity?: string;
  order_type: string;
  trading_symbol: string;
  transaction_type: string;
  exchange_segment?: string;
  product?: string;
  instrument_token?: string;
}

export async function modifyOrder(
  orderId: string,
  payload: ModifyOrderPayload,
): Promise<unknown> {
  return request<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/modify`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchPositions(): Promise<unknown> {
  return request<unknown>("/api/v1/positions");
}

/**
 * Paper-trading positions. Hits the fully-isolated paper endpoint — these
 * positions never touch the live broker or the live `positions` table.
 */
export async function fetchPaperPositions(): Promise<unknown> {
  return request<unknown>("/api/v1/paper/positions");
}

export async function fetchPositionGreeks(): Promise<GreeksResult[]> {
  return request<GreeksResult[]>("/api/v1/positions/greeks");
}

export async function fetchPortfolioRisk(): Promise<PortfolioRiskResult> {
  const raw = snakeToCamel(
    await request<unknown>("/api/v1/portfolio-risk"),
  ) as BackendPortfolioRiskResult;
  return mapBackendPortfolioRisk(raw);
}

export async function fetchSvi(
  underlying: string,
  expiry: string,
): Promise<SviParams | null> {
  try {
    return await request<SviParams>(
      `/api/v1/svi/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
    );
  } catch {
    return null;
  }
}

export async function fetchModelPrices(
  underlying: string,
  expiry: string,
): Promise<ModelPricesResult | null> {
  try {
    return await request<ModelPricesResult>(
      `/api/v1/model-prices/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
    );
  } catch {
    return null;
  }
}

export interface PlaceOrderLeg {
  tradingSymbol?: string;
  underlying?: string;
  expiry?: string;
  strike?: number;
  optionType?: string;
  transactionType: "B" | "S";
  /** Units (lots × lot size). For MCX the wire carries `lots` instead — see toWireLeg. */
  quantity: number;
  /** Explicit lot count; the backend converts to units with its own lot size. */
  lots?: number;
  orderType: "L" | "MKT" | "SL" | "SL-M";
  product: "NRML" | "MIS";
  price?: number;
  triggerPrice?: number;
  disclosedQuantity?: number;
  tag?: string;
}

export interface PlaceOrderResult {
  index: number;
  success: boolean;
  orderNumber?: string;
  error?: string;
  tradingSymbol?: string;
}

export interface MarginPreviewLeg {
  index: number;
  success: boolean;
  tradingSymbol?: string | null;
  exchangeSegment?: string | null;
  requiredMargin?: number | null;
  availableCash?: number | null;
  availableMargin?: number | null;
  orderMargin?: number | null;
  marginUsed?: number | null;
  insufficientFund?: number | null;
  validation?: string | null;
  error?: string | null;
}

export interface MarginPreviewResult {
  legs: MarginPreviewLeg[];
  totalRequiredMargin?: number | null;
  availableCash?: number | null;
  availableMargin?: number | null;
  accountNet?: number | null;
  accountMarginUsed?: number | null;
  rawLimits?: Record<string, unknown> | null;
}

/**
 * Serialize an order leg. MCX legs are sent as `lots` (quantity omitted) so
 * the backend converts with the scrip master's lot size — a stale client lot
 * size can then never mis-size a commodity order. NSE/BSE legs are unchanged.
 */
function toWireLeg(o: PlaceOrderLeg): Record<string, unknown> {
  const underlying = o.underlying || underlyingOfSymbol(o.tradingSymbol);
  let quantity: number | undefined = o.quantity;
  let lots = o.lots;
  if (lots === undefined && isFuturesUnderlying(underlying)) {
    const lotSize = getLotSize(underlying);
    const inferred = lotSize > 0 ? o.quantity / lotSize : NaN;
    // A non-whole lot count stays as quantity so the backend rejects it loudly
    if (Number.isInteger(inferred) && inferred > 0) lots = inferred;
  }
  if (lots !== undefined) quantity = undefined;
  return {
    trading_symbol: o.tradingSymbol,
    underlying: o.underlying,
    expiry: o.expiry,
    strike: o.strike,
    option_type: o.optionType,
    transaction_type: o.transactionType,
    quantity,
    lots,
    order_type: o.orderType,
    product: o.product,
    price: o.price ?? 0,
    trigger_price: o.triggerPrice ?? 0,
    disclosed_quantity: o.disclosedQuantity ?? 0,
    tag: o.tag,
  };
}

export async function placeOrders(
  orders: PlaceOrderLeg[],
): Promise<PlaceOrderResult[]> {
  return request<PlaceOrderResult[]>("/api/v1/place-orders", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map(toWireLeg),
    }),
  });
}

/**
 * Place SIMULATED (paper) orders. Routes to the isolated `/api/v1/paper`
 * endpoint which fills at the live LTP and can NEVER reach the live broker.
 * Same request shape as {@link placeOrders}.
 */
export async function placePaperOrders(
  orders: PlaceOrderLeg[],
): Promise<PlaceOrderResult[]> {
  return request<PlaceOrderResult[]>("/api/v1/paper/place-orders", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map(toWireLeg),
    }),
  });
}

export async function fetchMarginPreview(
  orders: PlaceOrderLeg[],
): Promise<MarginPreviewResult> {
  return request<MarginPreviewResult>("/api/v1/margin-preview", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map(toWireLeg),
    }),
  });
}

export async function analyzeStrategy(
  legs: StrategyLeg[],
): Promise<StrategyResult> {
  const raw = await request<unknown>("/api/v1/strategy/analyze", {
    method: "POST",
    body: JSON.stringify(legs),
  });
  return snakeToCamel(raw) as StrategyResult;
}

export async function fetchBasketRiskPreview(legs: StrategyLeg[]): Promise<PortfolioRiskResult> {
  const raw = snakeToCamel(
    await request<unknown>("/api/v1/strategy/risk-preview", {
      method: "POST",
      body: JSON.stringify(legs),
    }),
  ) as BackendPortfolioRiskResult;
  return mapBackendPortfolioRisk(raw);
}

export interface AccountLimits {
  net: number | null;
  marginUsed: number | null;
  collateral: number | null;
  marginFromShares: number | null;
}

export async function fetchLimits(): Promise<AccountLimits> {
  return request<AccountLimits>("/api/v1/limits");
}

export async function fetchAdjustments(
  underlying: string,
): Promise<AdjustmentRecommendation[]> {
  try {
    return await request<AdjustmentRecommendation[]>(
      `/api/v1/adjustments/${encodeURIComponent(underlying)}`,
    );
  } catch {
    return [];
  }
}
