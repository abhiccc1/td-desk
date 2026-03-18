export type OrderSide = "BUY" | "SELL";

export type OrderType = "MARKET" | "LIMIT" | "SL" | "SL_M";

export type OrderStatus =
  | "DRAFT"
  | "VALIDATED"
  | "SUBMITTED"
  | "PARTIAL_FILL"
  | "FILLED"
  | "REJECTED"
  | "CANCELLED";

export interface OrderRequest {
  orderId: string;
  basketId: string;
  userId: string;
  symbol: string;
  exchange: string;
  side: OrderSide;
  orderType: OrderType;
  quantity: number;
  price: number;
  triggerPrice: number;
}

export interface OrderFill {
  orderId: string;
  basketId: string;
  symbol: string;
  side: OrderSide;
  filledQty: number;
  avgFillPrice: number;
  status: OrderStatus;
  brokerOrderId: string;
  timestamp: string;
}

export interface Position {
  [key: string]: unknown;
  symbol: string;
  exchange: string;
  quantity: number;
  avgPrice: number;
  ltp: number;
  pnl: number;
  side: OrderSide;
  isOpen?: boolean;
  productType?: string;
  optionType?: string;
  strikePrice?: string;
  expiry?: string;
  lotSize?: number;
  tradingSymbol?: string;
}
