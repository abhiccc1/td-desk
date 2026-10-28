import { useConnectionStore } from "@/stores/use-connection-store";
import { normalizeLotSizes } from "@/lib/lot-sizes";
import { mcxLotsFor, registerUnderlyings } from "@/lib/instruments";
import { extractUnderlying } from "@/lib/positions";
import type {
  BackendUnderlying,
  ContractMeta,
  LotSizesResponse,
  OptionChainSnapshot,
  OrderBookResponse,
  PlaceOrderLeg,
  PlaceOrderResponse,
  Position,
  PositionsEnvelope,
  Underlying,
} from "@/types/api";

export const underlyingsKey = ["underlyings"] as const;
export const lotSizesKey = ["lotSizes"] as const;
export const positionsKey = ["positions"] as const;
export const orderBookKey = ["order-book"] as const;
export const authSessionKey = (apiUrl: string) => ["auth-session", apiUrl] as const;
export const kotakAccountsKey = (apiUrl: string) => ["kotak-accounts", apiUrl] as const;
export const contractMetaKey = (underlying: string) => ["contract-meta", underlying] as const;
export const optionChainKey = (underlying: string, expiry: string) => ["option-chain", underlying, expiry] as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const { apiUrl } = useConnectionStore.getState().config;
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(`API ${response.status}: ${errorBody}`);
  }

  return response.json() as Promise<T>;
}

export async function fetchUnderlyings(): Promise<Underlying[]> {
  const data = await request<(BackendUnderlying | string)[]>("/api/v1/underlyings");
  if (!Array.isArray(data)) return [];
  const underlyings = data
    .filter((item) => typeof item === "string" || item.enabled !== false)
    .map(normalizeUnderlying)
    .filter((item) => Boolean(item.name));
  registerUnderlyings(underlyings);
  return underlyings;
}

function normalizeUnderlying(item: BackendUnderlying | string): Underlying {
  if (typeof item === "string") {
    return { name: item, displayName: item, exchange: "NSE", enabled: true, assetClass: "index" };
  }
  const exchange = (item.exchange || "NSE").toUpperCase();
  const assetClass = item.assetClass === "commodity" || item.assetClass === "index"
    ? item.assetClass
    : exchange === "MCX" ? "commodity" : "index";
  return {
    name: item.name,
    displayName: item.displayName || item.name,
    exchange,
    lotSize: Number(item.lotSize) || undefined,
    enabled: item.enabled !== false,
    assetClass,
    pnlMultiplier: Number(item.pnlMultiplier) || undefined,
    sessionClose: item.sessionClose,
  };
}

/** MCX contract specs per expiry. Returns empty expiries for non-MCX or on failure. */
export async function fetchContractMeta(underlying: string): Promise<ContractMeta> {
  try {
    const data = await request<ContractMeta>(`/api/v1/contract-meta/${encodeURIComponent(underlying)}`);
    return { underlying: data?.underlying ?? underlying, expiries: data?.expiries ?? {} };
  } catch {
    return { underlying, expiries: {} };
  }
}

export async function fetchExpiries(underlying: string): Promise<string[]> {
  const data = await request<{ underlying: string; expiries: string[] }>(
    `/api/v1/expiries/${encodeURIComponent(underlying)}`,
  );
  return data.expiries ?? [];
}

export async function fetchOptionChain(underlying: string, expiry: string): Promise<OptionChainSnapshot> {
  return request<OptionChainSnapshot>(
    `/api/v1/option-chain/${encodeURIComponent(underlying)}/${encodeURIComponent(expiry)}`,
  );
}

export async function fetchLotSizes(): Promise<LotSizesResponse> {
  const data = await request<LotSizesResponse>("/api/v1/lot-sizes");
  return normalizeLotSizes(data);
}

export async function fetchPositions(): Promise<PositionsEnvelope> {
  const data = await request<PositionsEnvelope | Position[]>("/api/v1/positions");
  if (Array.isArray(data)) {
    return { positions: data, realizedPnl: 0 };
  }
  return {
    positions: data.positions ?? [],
    realizedPnl: data.realizedPnl ?? 0,
  };
}

export async function fetchOrderBook(): Promise<OrderBookResponse> {
  try {
    return await request<OrderBookResponse>("/api/v1/order-book");
  } catch {
    return { open: [], closed: [] };
  }
}

export type ModifyOrderPayload = {
  quantity: number;
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
};

export async function modifyOrder(orderId: string, payload: ModifyOrderPayload) {
  return request<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/modify`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function cancelOrder(orderId: string) {
  return request<unknown>(`/api/v1/orders/${encodeURIComponent(orderId)}/cancel`, {
    method: "POST",
  });
}

export type KotakSessionInfo = {
  state: string;
  version: number;
  lastHealthCheck: string | null;
  healthCheckOk: boolean;
  authenticatedAt: string | null;
  accountId?: string;
  ucc?: string;
};

export type KotakAccountOption = {
  id: string;
  label: string;
  ucc: string;
  mobileMasked: string;
};

export type KotakAccountsResponse = {
  accounts: KotakAccountOption[];
  activeAccountId: string;
  /** True when the backend has no server-side profiles and expects mobile/UCC from us. */
  clientSuppliedIdentity: boolean;
};

export async function fetchKotakSession(): Promise<KotakSessionInfo> {
  return request<KotakSessionInfo>("/api/v1/auth/kotak/session");
}

/** Account profiles configured server-side. Consumer keys are never included. */
export async function fetchKotakAccounts(): Promise<KotakAccountsResponse> {
  try {
    const data = await request<KotakAccountsResponse>("/api/v1/auth/kotak/accounts");
    return {
      accounts: data.accounts ?? [],
      activeAccountId: data.activeAccountId ?? "",
      clientSuppliedIdentity: data.clientSuppliedIdentity ?? false,
    };
  } catch {
    // Older backend without /accounts — fall back to client-supplied identity
    // rather than blocking login entirely.
    return { accounts: [], activeAccountId: "", clientSuppliedIdentity: true };
  }
}

export async function loginKotakWithTotp(body: {
  totp: string;
  accountId?: string;
  mobile?: string;
  ucc?: string;
}) {
  return request<unknown>("/api/v1/auth/kotak/totp-login", {
    method: "POST",
    body: JSON.stringify({
      totp: body.totp,
      ...(body.accountId ? { account_id: body.accountId } : {}),
      ...(body.mobile ? { mobile: body.mobile } : {}),
      ...(body.ucc ? { ucc: body.ucc } : {}),
    }),
  });
}

export async function verifyKotakMpin(body: { mpin: string; accountId?: string }) {
  return request<unknown>("/api/v1/auth/kotak/totp-validate", {
    method: "POST",
    body: JSON.stringify({
      mpin: body.mpin,
      ...(body.accountId ? { account_id: body.accountId } : {}),
    }),
  });
}

export async function logoutKotak() {
  return request<unknown>("/api/v1/auth/kotak/logout", {
    method: "POST",
  });
}

export async function placeOrders(orders: PlaceOrderLeg[]): Promise<PlaceOrderResponse[]> {
  return request<PlaceOrderResponse[]>("/api/v1/place-orders", {
    method: "POST",
    body: JSON.stringify({
      orders: orders.map((order) => {
        // MCX legs go as lots (quantity omitted): the backend converts with
        // the scrip master's lot size. NSE/BSE legs are unchanged.
        const underlying = order.underlying || extractUnderlying(order.tradingSymbol ?? "");
        const lots = order.lots ?? mcxLotsFor(underlying, order.quantity);
        return {
        underlying: order.underlying,
        expiry: order.expiry,
        strike: order.strike,
        option_type: order.optionType,
        transaction_type: order.transactionType,
        ...(lots !== undefined ? { lots } : { quantity: order.quantity }),
        order_type: order.orderType,
        product: order.product,
        price: order.price ?? 0,
        trigger_price: order.triggerPrice ?? 0,
        disclosed_quantity: order.disclosedQuantity ?? 0,
        };
      }),
    }),
  });
}
