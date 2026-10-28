export type Exchange = "NSE" | "BSE" | "MCX";
export type AssetClass = "index" | "commodity";

export type UnderlyingFuture = {
  symbol?: string;
  tradingSymbol?: string;
  token?: string | number;
  expiry?: string;
};

/** Raw /api/v1/underlyings row. Older backends only send name/enabled. */
export type BackendUnderlying = {
  name: string;
  displayName?: string;
  exchange?: Exchange | string;
  lotSize?: number;
  enabled?: boolean;
  assetClass?: AssetClass | string;
  pnlMultiplier?: number;
  sessionClose?: string;
};

/** Normalized underlying used throughout the app. */
export type Underlying = {
  name: string;
  displayName: string;
  exchange: string;
  lotSize?: number;
  enabled: boolean;
  assetClass: AssetClass;
  pnlMultiplier?: number;
  sessionClose?: string;
};

export type ContractMetaExpiry = {
  lotSize?: number;
  pnlMultiplier?: number;
  maxOrderQty?: number;
  tickSize?: number;
  underlyingFuture?: UnderlyingFuture | null;
};

export type ContractMeta = {
  underlying: string;
  expiries: Record<string, ContractMetaExpiry>;
};

export type TickData = {
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
};

export type OptionStrike = {
  strike: number;
  call: TickData | null;
  put: TickData | null;
};

export type OptionChainSnapshot = {
  underlying: string;
  underlyingPrice: number;
  expiry: string;
  exchange: string;
  strikes: OptionStrike[];
  timestamp: string;
  /** MCX only: the future whose LTP is reported as underlyingPrice. */
  underlyingFuture?: UnderlyingFuture | null;
};

export type PlaceOrderLeg = {
  tradingSymbol?: string;
  underlying?: string;
  expiry?: string;
  strike?: number;
  optionType?: string;
  transactionType: "B" | "S";
  /** Units (lots × lot size). MCX legs are serialized as `lots` instead. */
  quantity: number;
  /** Explicit lot count; the backend converts to units with its own lot size. */
  lots?: number;
  orderType: "MKT" | "L" | "SL" | "SL-M";
  product: "NRML" | "MIS";
  price?: number;
  triggerPrice?: number;
  disclosedQuantity?: number;
};

export type PlaceOrderResponse = {
  index: number;
  success: boolean;
  orderNumber?: string;
  error?: string;
  tradingSymbol?: string;
};

export type OrderBookEntry = {
  orderId: string;
  tradingSymbol?: string;
  symbol?: string;
  exchangeSegment?: string;
  instrumentToken?: string;
  side: "BUY" | "SELL";
  quantity: number;
  filledQty: number;
  unfilledQty: number;
  disclosedQty: number;
  price: number;
  triggerPrice: number;
  avgPrice: number;
  orderType: string;
  productType?: string;
  validity?: string;
  status?: string;
  optionType?: string;
  strikePrice?: string;
  expiry?: string;
  time?: string;
};

export type OrderBookResponse = {
  open: OrderBookEntry[];
  closed: OrderBookEntry[];
};

export type BasketLeg = {
  id: string;
  tradingSymbol?: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: "CE" | "PE";
  transactionType: "B" | "S";
  product: "NRML" | "MIS";
  orderType: "MKT" | "L";
  lots: number;
  price?: number;
};

export type Position = {
  symbol: string;
  exchange?: string;
  quantity?: number;
  netQty?: number;
  lotSize?: number;
  avgPrice?: number;
  ltp?: number;
  pnl?: number;
  bookedPnl?: number;
  realizedPnlComponent?: number;
  multiplier?: number;
  /** Rupees per unit qty per ₹1 of price (NSE = 1). Absent on older payloads. */
  valueMultiplier?: number;
  unrealizedPnl?: number;
  precision?: number;
  side: "BUY" | "SELL" | "CLOSED";
  isOpen?: boolean;
  tradingSymbol?: string;
  expiry?: string;
  strikePrice?: string;
  optionType?: string;
  productType?: string;
};

export type PositionsEnvelope = {
  positions: Position[];
  realizedPnl: number;
};

export type PositionsPayload = {
  positions?: Position[];
  realizedPnl?: number;
};

export type LotSizesResponse = Record<string, number>;
