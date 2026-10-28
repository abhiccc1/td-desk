import { create } from "zustand";

type ContractSelection = {
  underlying: string;
  expiry: string;
  strike: number | null;
  optionType: "CE" | "PE" | null;
  tradingSymbol: string | null;
};

type TradeState = ContractSelection & {
  selectUnderlying: (underlying: string) => void;
  selectExpiry: (expiry: string) => void;
  selectContract: (contract: ContractSelection) => void;
};

export const useTradeStore = create<TradeState>()((set) => ({
  underlying: "",
  expiry: "",
  strike: null,
  optionType: null,
  tradingSymbol: null,
  selectUnderlying: (underlying) => set((state) => ({
    underlying,
    expiry: state.underlying === underlying ? state.expiry : "",
    strike: state.underlying === underlying ? state.strike : null,
    optionType: state.underlying === underlying ? state.optionType : null,
    tradingSymbol: state.underlying === underlying ? state.tradingSymbol : null,
  })),
  selectExpiry: (expiry) => set((state) => ({
    expiry,
    strike: state.expiry === expiry ? state.strike : null,
    optionType: state.expiry === expiry ? state.optionType : null,
    tradingSymbol: state.expiry === expiry ? state.tradingSymbol : null,
  })),
  selectContract: (contract) => set(contract),
}));
