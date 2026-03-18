/** Types matching NSE public API JSON shapes. */

export interface NseMarketStatusResponse {
  marketState: {
    market: string;
    marketStatus: string;
    tradeDate: string;
    index: string;
    last: number;
    variation: number;
    percentChange: number;
    marketStatusMessage: string;
  }[];
}

export interface NseOptionLeg {
  strikePrice: number;
  expiryDate: string;
  underlying: string;
  identifier: string;
  openInterest: number;
  changeinOpenInterest: number;
  pchangeinOpenInterest: number;
  totalTradedVolume: number;
  impliedVolatility: number;
  lastPrice: number;
  change: number;
  pchange: number;
  totalBuyQuantity: number;
  totalSellQuantity: number;
  buyPrice1: number;
  buyQuantity1: number;
  sellPrice1: number;
  sellQuantity1: number;
  underlyingValue: number;
  optionType: string | null;
}

export interface NseOptionRecord {
  strikePrice: number;
  expiryDates: string;
  CE?: NseOptionLeg;
  PE?: NseOptionLeg;
}

export interface NseOptionChainResponse {
  records: {
    expiryDates: string[];
    data: NseOptionRecord[];
    timestamp: string;
    underlyingValue: number;
    strikePrices: number[];
  };
  filtered: {
    data: NseOptionRecord[];
    CE: { totOI: number; totVol: number };
    PE: { totOI: number; totVol: number };
  };
}
