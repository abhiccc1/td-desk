/**
 * Mock API client — mirrors all 9 functions from api-client.ts
 * with simulated 50-200ms delays and generated data.
 */

import type {
  GreeksResult,
  OptionChainSnapshot,
  StrategyLeg,
  StrategyResult,
  SviParams,
  TickData,
} from "@/types/market-data";
import type { Position } from "@/types/orders";
import type { MarginPreviewResult, PlaceOrderLeg, PlaceOrderResult } from "@/lib/api-client.real";
import { generateGreeks } from "./generators/greeks";
import { generateOHLCV } from "./generators/ohlcv";
import { generateOptionChain } from "./generators/option-chain";
import { generatePositions } from "./generators/positions";
import { generateQuote } from "./generators/quotes";
import { mockAnalyzeStrategy } from "./generators/strategy";
import { API_DELAY } from "./seed/constants";

function delay(): Promise<void> {
  const [min, max] = API_DELAY;
  const ms = Math.round(Math.random() * (max - min) + min);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let cachedChain: OptionChainSnapshot | null = null;

export async function fetchOptionChain(
  underlying: string,
  expiry: string,
): Promise<OptionChainSnapshot> {
  await delay();
  cachedChain = generateOptionChain(underlying, expiry);
  return cachedChain;
}

export async function fetchQuote(symbol: string): Promise<TickData> {
  await delay();
  return generateQuote(symbol);
}

export async function fetchGreeks(
  underlying: string,
  expiry: string,
): Promise<GreeksResult[]> {
  await delay();
  const chain = cachedChain ?? generateOptionChain(underlying, expiry);
  return generateGreeks(chain);
}

export async function fetchSvi(): Promise<SviParams | null> {
  // Mock mode: return null (no SVI surface in mock)
  return null;
}

export async function fetchOHLCV(
  symbol: string,
  from: string,
  to: string,
  interval: string,
): Promise<unknown[]> {
  await delay();
  return generateOHLCV(symbol, from, to, interval);
}

let basketCounter = 0;

export async function createBasket(): Promise<{ basket_id: string }> {
  await delay();
  basketCounter += 1;
  return { basket_id: `mock-basket-${basketCounter}` };
}

export async function addLeg(
  basketId: string,
  leg: unknown,
): Promise<unknown> {
  await delay();
  return { basketId, leg, status: "added" };
}

export async function submitBasket(basketId: string): Promise<unknown> {
  await delay();
  return { basketId, status: "SUBMITTED", message: "Mock order submitted" };
}

export async function fetchOrderBook(): Promise<{ open: unknown[]; closed: unknown[] }> {
  await delay();
  return { open: [], closed: [] };
}

export async function cancelOrder(orderId: string): Promise<unknown> {
  await delay();
  return { ok: true, orderId, status: "cancelled" };
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
  await delay();
  return { ok: true, orderId, ...payload, status: "modified" };
}

export async function placeOrders(
  orders: PlaceOrderLeg[],
): Promise<PlaceOrderResult[]> {
  await delay();
  return orders.map((order, index) => ({
    index,
    success: true,
    orderNumber: `mock-order-${index + 1}`,
    tradingSymbol: order.tradingSymbol,
  }));
}

export async function fetchMarginPreview(
  orders: PlaceOrderLeg[],
): Promise<MarginPreviewResult> {
  await delay();
  const legs = orders.map((order, index) => {
    const required = Number((Math.max(order.quantity, 1) * Math.max(order.price || 100, 100) * 0.15).toFixed(2));
    return {
      index,
      success: true,
      tradingSymbol: order.tradingSymbol ?? null,
      exchangeSegment: "nse_fo",
      requiredMargin: required,
      availableCash: 250000,
      availableMargin: 250000,
      orderMargin: required,
      marginUsed: 50000,
      insufficientFund: 0,
      validation: "OK",
      error: null,
    };
  });
  return {
    legs,
    totalRequiredMargin: legs.reduce((sum, leg) => sum + (leg.requiredMargin ?? 0), 0),
    availableCash: 250000,
    availableMargin: 250000,
    accountNet: 250000,
    accountMarginUsed: 50000,
    rawLimits: null,
  };
}

export async function fetchPositions(): Promise<Position[]> {
  await delay();
  return generatePositions();
}

export async function analyzeStrategy(
  legs: StrategyLeg[],
): Promise<StrategyResult> {
  await delay();
  return mockAnalyzeStrategy(legs);
}
