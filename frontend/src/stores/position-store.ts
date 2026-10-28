import { create } from "zustand";

import type { Position } from "@/types/orders";

/**
 * Normalize raw broker fields into consistent typed fields on each position.
 * Called once on ingestion so consumers never deal with format variations.
 */
export function normalizePosition(pos: Position): Position {
  // ── Underlying ──
  let underlying = "";
  const sym = pos.tradingSymbol || pos.symbol;
  if (sym) underlying = sym.replace(/\d.*/, "").trim();
  // Fallback: parse "NIFTY 260317 23800 CE"
  if (!underlying) {
    const parts = pos.symbol.split(" ");
    if (parts.length >= 1) underlying = parts[0];
  }

  // ── Strike ──
  let strike = 0;
  if (pos.strikePrice) {
    strike = Number(pos.strikePrice) || 0;
  } else {
    const parts = pos.symbol.split(" ");
    if (parts.length === 4) strike = Number(parts[2]) || 0;
  }

  // ── Option type ──
  let optType: "CE" | "PE" | undefined;
  if (pos.optionType === "CE" || pos.optionType === "PE") {
    optType = pos.optionType;
  } else {
    const parts = pos.symbol.split(" ");
    if (parts.length === 4 && (parts[3] === "CE" || parts[3] === "PE")) {
      optType = parts[3];
    }
  }

  // ── Expiry → ISO "YYYY-MM-DD" ──
  let expiryIso: string | undefined;
  const rawExpiry = pos.expiry;
  if (rawExpiry) {
    // Already ISO?
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawExpiry)) {
      expiryIso = rawExpiry;
    } else {
      // Try "YYMMDD" from symbol first
      const parts = pos.symbol.split(" ");
      if (parts.length === 4 && /^\d{6}$/.test(parts[1])) {
        expiryIso = `20${parts[1].slice(0, 2)}-${parts[1].slice(2, 4)}-${parts[1].slice(4, 6)}`;
      } else {
        // Parse broker format "24 Mar, 2026" or similar
        const cleaned = rawExpiry.replace(/,\s*/g, " ").trim();
        const d = new Date(cleaned);
        if (!Number.isNaN(d.getTime())) {
          expiryIso = d.toISOString().slice(0, 10);
        }
      }
    }
  }

  return {
    ...pos,
    _underlying: underlying,
    _strike: strike,
    _optionType: optType,
    _expiryIso: expiryIso,
  };
}

interface PositionState {
  positions: Position[];
  totalPnl: number;
  realizedPnl: number;
  orderUpdateVersion: number;
}

interface PositionActions {
  setPositions: (positions: Position[]) => void;
  setRealizedPnl: (pnl: number) => void;
  updatePosition: (symbol: string, update: Partial<Position>) => void;
  bumpOrderUpdate: () => void;
}

export type PositionStore = PositionState & PositionActions;

export function computeTotalPnl(positions: Position[]): number {
  return positions.reduce((acc, pos) => acc + pos.pnl, 0);
}

function rankPosition(pos: Position): [number, number, string] {
  const openRank = (pos as Record<string, unknown>).isOpen !== false ? 0 : 1;
  const sideRank = pos.side === "BUY" ? 0 : pos.side === "SELL" ? 1 : 2;
  return [openRank, sideRank, pos.symbol];
}

export function sortPositions(positions: Position[]): Position[] {
  return [...positions].sort((a, b) => {
    const [aOpen, aSide, aSymbol] = rankPosition(a);
    const [bOpen, bSide, bSymbol] = rankPosition(b);

    if (aOpen !== bOpen) return aOpen - bOpen;
    if (aSide !== bSide) return aSide - bSide;
    return aSymbol.localeCompare(bSymbol);
  });
}

export const usePositionStore = create<PositionStore>()((set, get) => ({
  positions: [],
  totalPnl: 0,
  realizedPnl: 0,
  orderUpdateVersion: 0,

  setPositions: (positions: Position[]) => {
    const normalized = positions.map(normalizePosition);
    const sorted = sortPositions(normalized);
    set({ positions: sorted, totalPnl: computeTotalPnl(sorted) });
  },

  setRealizedPnl: (pnl: number) => {
    set({ realizedPnl: pnl });
  },

  updatePosition: (symbol: string, update: Partial<Position>) => {
    const positions = sortPositions(get().positions.map((pos) =>
      pos.symbol === symbol ? { ...pos, ...update } : pos,
    ));
    set({ positions, totalPnl: computeTotalPnl(positions) });
  },

  bumpOrderUpdate: () => {
    set((s) => ({ orderUpdateVersion: s.orderUpdateVersion + 1 }));
  },
}));
