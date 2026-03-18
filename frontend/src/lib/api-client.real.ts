import type {
  GreeksResult,
  ModelPricesResult,
  OptionChainSnapshot,
  StrategyLeg,
  StrategyResult,
  SviParams,
  TickData,
} from "@/types/market-data";
import { getConfig } from "@/lib/config";

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

export async function fetchOptionChain(
  underlying: string,
  expiry: string,
): Promise<OptionChainSnapshot> {
  return request<OptionChainSnapshot>(
    `/api/v1/option-chain/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
  );
}

export async function fetchQuote(symbol: string): Promise<TickData> {
  return request<TickData>(
    `/api/v1/quotes/${encodeURIComponent(symbol)}`,
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

export async function fetchOHLCV(
  symbol: string,
  from: string,
  to: string,
  interval: string,
): Promise<unknown[]> {
  return request<unknown[]>(
    `/api/v1/ohlcv/${encodeURIComponent(symbol)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&interval=${encodeURIComponent(interval)}`,
  );
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

export async function modifyOrder(
  orderId: string,
  payload: {
    quantity: number;
    price: number;
    trigger_price: number;
    disclosed_quantity?: number;
    validity?: string;
    order_type: string;
  },
): Promise<unknown> {
  return request<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/modify`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function fetchPositions(): Promise<unknown> {
  return request<unknown>("/api/v1/positions");
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
  quantity: number;
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

export async function placeOrders(
  orders: PlaceOrderLeg[],
): Promise<PlaceOrderResult[]> {
  return request<PlaceOrderResult[]>("/api/v1/place-orders", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map((o) => ({
        trading_symbol: o.tradingSymbol,
        underlying: o.underlying,
        expiry: o.expiry,
        strike: o.strike,
        option_type: o.optionType,
        transaction_type: o.transactionType,
        quantity: o.quantity,
        order_type: o.orderType,
        product: o.product,
        price: o.price ?? 0,
        trigger_price: o.triggerPrice ?? 0,
        disclosed_quantity: o.disclosedQuantity ?? 0,
        tag: o.tag,
      })),
    }),
  });
}

export async function fetchMarginPreview(
  orders: PlaceOrderLeg[],
): Promise<MarginPreviewResult> {
  return request<MarginPreviewResult>("/api/v1/margin-preview", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map((o) => ({
        trading_symbol: o.tradingSymbol,
        underlying: o.underlying,
        expiry: o.expiry,
        strike: o.strike,
        option_type: o.optionType,
        transaction_type: o.transactionType,
        quantity: o.quantity,
        order_type: o.orderType,
        product: o.product,
        price: o.price ?? 0,
        trigger_price: o.triggerPrice ?? 0,
        disclosed_quantity: o.disclosedQuantity ?? 0,
        tag: o.tag,
      })),
    }),
  });
}

export async function analyzeStrategy(
  legs: StrategyLeg[],
): Promise<StrategyResult> {
  return request<StrategyResult>("/api/v1/strategy/analyze", {
    method: "POST",
    body: JSON.stringify({ legs }),
  });
}
