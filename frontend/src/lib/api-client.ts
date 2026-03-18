import type {
  GreeksResult,
  ModelPricesResult,
  OptionChainSnapshot,
  StrategyLeg,
  StrategyResult,
  SviParams,
  TickData,
} from "@/types/market-data";

const IS_MOCK = process.env.NEXT_PUBLIC_MOCK_MODE === "true";

import type { MarginPreviewResult, PlaceOrderLeg, PlaceOrderResult } from "@/lib/api-client.real";

type ApiModule = {
  fetchOptionChain: (underlying: string, expiry: string) => Promise<OptionChainSnapshot>;
  fetchQuote: (symbol: string) => Promise<TickData>;
  fetchGreeks: (underlying: string, expiry: string) => Promise<GreeksResult[]>;
  fetchSvi: (underlying: string, expiry: string) => Promise<SviParams | null>;
  fetchModelPrices?: (underlying: string, expiry: string) => Promise<ModelPricesResult | null>;
  fetchOHLCV: (symbol: string, from: string, to: string, interval: string) => Promise<unknown[]>;
  createBasket: () => Promise<{ basket_id: string }>;
  addLeg: (basketId: string, leg: unknown) => Promise<unknown>;
  submitBasket: (basketId: string) => Promise<unknown>;
  placeOrders?: (orders: PlaceOrderLeg[]) => Promise<PlaceOrderResult[]>;
  fetchMarginPreview?: (orders: PlaceOrderLeg[]) => Promise<MarginPreviewResult>;
  fetchOrderBook?: () => Promise<{ open: unknown[]; closed: unknown[] }>;
  cancelOrder?: (orderId: string) => Promise<unknown>;
  modifyOrder?: (
    orderId: string,
    payload: {
      quantity: number;
      price: number;
      trigger_price: number;
      disclosed_quantity?: number;
      validity?: string;
      order_type: string;
    },
  ) => Promise<unknown>;
  fetchPositions: () => Promise<unknown>;
  analyzeStrategy: (legs: StrategyLeg[]) => Promise<StrategyResult>;
  fetchExpiries?: (underlying: string) => Promise<string[]>;
  fetchStaticData?: (symbol: string) => Promise<{ symbol: string; open: number; high: number; low: number; prevClose: number; change: number; pctChange: number } | null>;
};

// Lazy-load the appropriate module so mock code is tree-shaken in production builds.
let _mod: ApiModule | null = null;

async function getModule(): Promise<ApiModule> {
  if (_mod) return _mod;
  _mod = IS_MOCK
    ? await import("@/mocks/api-client.mock")
    : await import("@/lib/api-client.real");
  return _mod;
}

export async function fetchOptionChain(
  underlying: string,
  expiry: string,
): Promise<OptionChainSnapshot> {
  const mod = await getModule();
  return mod.fetchOptionChain(underlying, expiry);
}

export async function fetchQuote(symbol: string): Promise<TickData> {
  const mod = await getModule();
  return mod.fetchQuote(symbol);
}

export async function fetchGreeks(
  underlying: string,
  expiry: string,
): Promise<GreeksResult[]> {
  const mod = await getModule();
  return mod.fetchGreeks(underlying, expiry);
}

export async function fetchSvi(
  underlying: string,
  expiry: string,
): Promise<SviParams | null> {
  const mod = await getModule();
  return mod.fetchSvi(underlying, expiry);
}

export async function fetchOHLCV(
  symbol: string,
  from: string,
  to: string,
  interval: string,
): Promise<unknown[]> {
  const mod = await getModule();
  return mod.fetchOHLCV(symbol, from, to, interval);
}

export async function createBasket(): Promise<{ basket_id: string }> {
  const mod = await getModule();
  return mod.createBasket();
}

export async function addLeg(
  basketId: string,
  leg: unknown,
): Promise<unknown> {
  const mod = await getModule();
  return mod.addLeg(basketId, leg);
}

export async function submitBasket(basketId: string): Promise<unknown> {
  const mod = await getModule();
  return mod.submitBasket(basketId);
}

export type { MarginPreviewResult, PlaceOrderLeg, PlaceOrderResult } from "@/lib/api-client.real";

export async function placeOrders(
  orders: PlaceOrderLeg[],
): Promise<PlaceOrderResult[]> {
  const mod = await getModule();
  if (mod.placeOrders) return mod.placeOrders(orders);
  throw new Error("placeOrders not available in mock mode");
}

export async function fetchMarginPreview(
  orders: PlaceOrderLeg[],
): Promise<MarginPreviewResult | null> {
  const mod = await getModule();
  if (mod.fetchMarginPreview) return mod.fetchMarginPreview(orders);
  return null;
}

export async function fetchOrderBook(): Promise<{ open: unknown[]; closed: unknown[] }> {
  const mod = await getModule();
  if (mod.fetchOrderBook) return mod.fetchOrderBook();
  return { open: [], closed: [] };
}

export async function cancelOrder(orderId: string): Promise<unknown> {
  const mod = await getModule();
  if (mod.cancelOrder) return mod.cancelOrder(orderId);
  return { ok: false };
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
  const mod = await getModule();
  if (mod.modifyOrder) return mod.modifyOrder(orderId, payload);
  return { ok: false };
}

export async function fetchPositions(): Promise<unknown> {
  const mod = await getModule();
  return mod.fetchPositions();
}

export async function analyzeStrategy(
  legs: StrategyLeg[],
): Promise<StrategyResult> {
  const mod = await getModule();
  return mod.analyzeStrategy(legs);
}

export async function fetchExpiries(
  underlying: string,
): Promise<string[]> {
  const mod = await getModule();
  if (mod.fetchExpiries) return mod.fetchExpiries(underlying);
  return [];
}

export async function fetchModelPrices(
  underlying: string,
  expiry: string,
): Promise<ModelPricesResult | null> {
  const mod = await getModule();
  if (mod.fetchModelPrices) return mod.fetchModelPrices(underlying, expiry);
  return null;
}

export async function fetchStaticData(
  symbol: string,
): Promise<{ symbol: string; open: number; high: number; low: number; prevClose: number; change: number; pctChange: number } | null> {
  const mod = await getModule();
  if (mod.fetchStaticData) return mod.fetchStaticData(symbol);
  return null;
}
