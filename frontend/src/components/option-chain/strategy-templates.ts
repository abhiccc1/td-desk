import type { OptionType, Side, GreeksResult, SviParams } from "@/types/market-data";
import { useBasketStore } from "@/stores/basket-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";

// ─── Types ───────────────────────────────────────────────────────────────────

export type StrikeMode = "offset" | "delta" | "premium" | "svi-edge";

export interface TemplateLeg {
  strikeOffset: number;
  optionType: OptionType;
  side: Side;
}

export interface ParamModeOverride {
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
}

export interface TemplateParam {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step?: number;
  deltaMode?: ParamModeOverride;
  premiumMode?: ParamModeOverride;
}

export type ParamValues = Record<string, number>;

export interface StrategyTemplate {
  name: string;
  params: TemplateParam[];
  buildLegs(values: ParamValues, mode: StrikeMode): TemplateLeg[];
}

// ─── Param helpers ───────────────────────────────────────────────────────────

interface EffectiveParam {
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export function getEffectiveParam(
  param: TemplateParam,
  mode: StrikeMode,
): EffectiveParam {
  const override =
    mode === "delta"
      ? param.deltaMode
      : mode === "premium"
        ? param.premiumMode
        : undefined;
  return {
    label: override?.label ?? param.label,
    default: override?.default ?? param.default,
    min: override?.min ?? param.min,
    max: override?.max ?? param.max,
    step: override?.step ?? param.step ?? 1,
  };
}

export function getDefaultParamValues(
  template: StrategyTemplate,
  mode: StrikeMode = "offset",
): ParamValues {
  const values: ParamValues = {};
  for (const p of template.params) {
    values[p.key] = getEffectiveParam(p, mode).default;
  }
  return values;
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_PREFIX = "td-desk:strategy-params:";

export function loadSavedParamValues(
  name: string,
  mode: StrikeMode = "offset",
): ParamValues | null {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${name}:${mode}`);
    if (raw) return JSON.parse(raw) as ParamValues;
    // Fallback: legacy key (no mode suffix) for offset mode
    if (mode === "offset") {
      const legacy = localStorage.getItem(STORAGE_PREFIX + name);
      if (legacy) return JSON.parse(legacy) as ParamValues;
    }
    return null;
  } catch {
    return null;
  }
}

export function saveParamValues(
  name: string,
  values: ParamValues,
  mode: StrikeMode = "offset",
): void {
  localStorage.setItem(
    `${STORAGE_PREFIX}${name}:${mode}`,
    JSON.stringify(values),
  );
}

// ─── Templates ───────────────────────────────────────────────────────────────

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    name: "Short Straddle",
    params: [],
    buildLegs: () => [
      { strikeOffset: 0, optionType: "CE", side: "SELL" },
      { strikeOffset: 0, optionType: "PE", side: "SELL" },
    ],
  },
  {
    name: "Short Strangle",
    params: [
      {
        key: "otmOffset",
        label: "OTM Offset",
        default: 1,
        min: 1,
        max: 20,
        deltaMode: { label: "Target Delta", default: 0.25, min: 0.05, max: 0.50, step: 0.01 },
        premiumMode: { label: "Target Premium", default: 100, min: 10, max: 500, step: 10 },
      },
    ],
    buildLegs: (v) => [
      { strikeOffset: v.otmOffset, optionType: "CE", side: "SELL" },
      { strikeOffset: -v.otmOffset, optionType: "PE", side: "SELL" },
    ],
  },
  {
    name: "Bull Put Spread",
    params: [
      {
        key: "width",
        label: "Width",
        default: 1,
        min: 1,
        max: 20,
        deltaMode: { label: "Hedge Delta", default: 0.15, min: 0.05, max: 0.45, step: 0.01 },
        premiumMode: { label: "Hedge Premium", default: 30, min: 5, max: 400, step: 10 },
      },
    ],
    buildLegs: (v) => [
      { strikeOffset: 0, optionType: "PE", side: "SELL" },
      { strikeOffset: -v.width, optionType: "PE", side: "BUY" },
    ],
  },
  {
    name: "Bear Call Spread",
    params: [
      {
        key: "width",
        label: "Width",
        default: 1,
        min: 1,
        max: 20,
        deltaMode: { label: "Hedge Delta", default: 0.15, min: 0.05, max: 0.45, step: 0.01 },
        premiumMode: { label: "Hedge Premium", default: 30, min: 5, max: 400, step: 10 },
      },
    ],
    buildLegs: (v) => [
      { strikeOffset: 0, optionType: "CE", side: "SELL" },
      { strikeOffset: v.width, optionType: "CE", side: "BUY" },
    ],
  },
  {
    name: "Iron Condor",
    params: [
      {
        key: "innerOffset",
        label: "Inner Offset",
        default: 1,
        min: 1,
        max: 20,
        deltaMode: { label: "Sell Delta", default: 0.25, min: 0.05, max: 0.50, step: 0.01 },
        premiumMode: { label: "Sell Premium", default: 100, min: 10, max: 500, step: 10 },
      },
      {
        key: "outerOffset",
        label: "Wing Width",
        default: 1,
        min: 1,
        max: 20,
        deltaMode: { label: "Hedge Delta", default: 0.10, min: 0.05, max: 0.45, step: 0.01 },
        premiumMode: { label: "Hedge Premium", default: 30, min: 5, max: 400, step: 10 },
      },
    ],
    buildLegs: (v, mode) => {
      if (mode === "delta" || mode === "premium") {
        // outerOffset IS the hedge target directly (not additive width)
        return [
          { strikeOffset: -v.outerOffset, optionType: "PE", side: "BUY" },
          { strikeOffset: -v.innerOffset, optionType: "PE", side: "SELL" },
          { strikeOffset: v.innerOffset, optionType: "CE", side: "SELL" },
          { strikeOffset: v.outerOffset, optionType: "CE", side: "BUY" },
        ];
      }
      // Offset mode: outerOffset is additional width beyond inner
      return [
        { strikeOffset: -(v.innerOffset + v.outerOffset), optionType: "PE", side: "BUY" },
        { strikeOffset: -v.innerOffset, optionType: "PE", side: "SELL" },
        { strikeOffset: v.innerOffset, optionType: "CE", side: "SELL" },
        { strikeOffset: v.innerOffset + v.outerOffset, optionType: "CE", side: "BUY" },
      ];
    },
  },
];

// ─── Strike resolution ───────────────────────────────────────────────────────

function findAtmIndex(strikes: { strike: number }[], spot: number): number {
  let minDist = Infinity;
  let idx = 0;
  for (let i = 0; i < strikes.length; i++) {
    const dist = Math.abs(strikes[i].strike - spot);
    if (dist < minDist) {
      minDist = dist;
      idx = i;
    }
  }
  return idx;
}

function getPremium(
  chain: { strikes: { strike: number; call: { ltp: number; bid?: number; ask?: number } | null; put: { ltp: number; bid?: number; ask?: number } | null }[] },
  strikeIdx: number,
  optionType: OptionType,
): number {
  const row = chain.strikes[strikeIdx];
  if (!row) return 0;
  const opt = optionType === "CE" ? row.call : row.put;
  if (!opt) return 0;
  return opt.ltp;
}

function findStrikeIdxByDelta(
  strikes: { strike: number }[],
  targetDelta: number,
  optionType: OptionType,
  greeksMap: Map<string, GreeksResult>,
  underlying: string,
  expiry: string,
): number {
  // Symbol format in greeks store: "NIFTY 260317 23100 CE"
  const expiryCompact = expiry.replace(/-/g, "").slice(2); // "2026-03-17" → "260317"
  const side = optionType === "CE" ? "CE" : "PE";
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i].strike;
    const strikeStr = Number.isInteger(strike) ? String(strike) : strike.toFixed(0);
    const symbol = `${underlying} ${expiryCompact} ${strikeStr} ${side}`;
    const g = greeksMap.get(symbol);
    if (!g) continue;
    const dist = Math.abs(Math.abs(g.delta) - Math.abs(targetDelta));
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

function findStrikeIdxByPremium(
  strikes: { strike: number; call: { ltp: number } | null; put: { ltp: number } | null }[],
  targetPremium: number,
  optionType: OptionType,
): number {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < strikes.length; i++) {
    const opt = optionType === "CE" ? strikes[i].call : strikes[i].put;
    if (!opt) continue;
    const dist = Math.abs(opt.ltp - targetPremium);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ─── SVI helpers ─────────────────────────────────────────────────────────────

function sviIvAtStrike(svi: SviParams, strike: number, spot: number, t: number): number | null {
  if (spot <= 0 || strike <= 0 || t <= 0) return null;
  const k = Math.log(strike / spot);
  const dk = k - svi.m;
  const w = svi.a + svi.b * (svi.rho * dk + Math.sqrt(dk * dk + svi.sigma * svi.sigma));
  if (w <= 0) return null;
  return Math.sqrt(w / t) * 100;
}

/**
 * Find the strike with the best "edge" for a given side.
 * For SELL legs: find where market IV is MOST ABOVE SVI (overpriced → sell premium).
 * For BUY legs: find where market IV is MOST BELOW SVI (underpriced → buy cheap).
 * Only considers OTM strikes (CE above spot, PE below spot) for the given option type.
 */
function findStrikeIdxBySviEdge(
  strikes: { strike: number }[],
  side: Side,
  optionType: OptionType,
  greeksMap: Map<string, GreeksResult>,
  svi: SviParams,
  spot: number,
  t: number,
  underlying: string,
  expiry: string,
): number {
  const expiryCompact = expiry.replace(/-/g, "").slice(2);
  const sideLabel = optionType === "CE" ? "CE" : "PE";
  let bestIdx = 0;
  let bestEdge = side === "SELL" ? -Infinity : Infinity;

  for (let i = 0; i < strikes.length; i++) {
    const strike = strikes[i].strike;
    // Only consider OTM strikes
    if (optionType === "CE" && strike <= spot) continue;
    if (optionType === "PE" && strike >= spot) continue;

    const strikeStr = Number.isInteger(strike) ? String(strike) : strike.toFixed(0);
    const symbol = `${underlying} ${expiryCompact} ${strikeStr} ${sideLabel}`;
    const g = greeksMap.get(symbol);
    if (!g || g.iv <= 0) continue;

    const marketIv = g.iv * 100;
    const sviIv = sviIvAtStrike(svi, strike, spot, t);
    if (sviIv === null) continue;

    const edge = marketIv - sviIv; // positive = overpriced

    if (side === "SELL" && edge > bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    } else if (side === "BUY" && edge < bestEdge) {
      bestEdge = edge;
      bestIdx = i;
    }
  }
  return bestIdx;
}

// ─── Apply ───────────────────────────────────────────────────────────────────

export function applyTemplate(
  template: StrategyTemplate,
  paramValues: ParamValues,
  mode: StrikeMode = "offset",
) {
  const { optionChain, selectedUnderlying, selectedExpiry } =
    useMarketDataStore.getState();

  if (!optionChain || !selectedUnderlying || !selectedExpiry) return;

  const atmIdx = findAtmIndex(optionChain.strikes, optionChain.underlyingPrice);
  const greeksMap = useGreeksStore.getState().greeks;
  const svi = useMarketDataStore.getState().sviParams;
  const spot = optionChain.underlyingPrice;
  const expiryMs = new Date(optionChain.expiry).getTime() - Date.now();
  const t = Math.max(expiryMs / (365.25 * 86400_000), 1e-6);
  const store = useBasketStore.getState();
  const legs = template.buildLegs(paramValues, mode);

  store.clearBasket();

  for (const tLeg of legs) {
    let idx: number;

    if (tLeg.strikeOffset === 0) {
      // Always ATM
      idx = atmIdx;
    } else if (mode === "svi-edge" && svi) {
      idx = findStrikeIdxBySviEdge(
        optionChain.strikes,
        tLeg.side,
        tLeg.optionType,
        greeksMap,
        svi,
        spot,
        t,
        selectedUnderlying,
        selectedExpiry,
      );
    } else if (mode === "delta") {
      const targetDelta = tLeg.strikeOffset;
      idx = findStrikeIdxByDelta(
        optionChain.strikes,
        targetDelta,
        tLeg.optionType,
        greeksMap,
        selectedUnderlying,
        selectedExpiry,
      );
    } else if (mode === "premium") {
      const targetPremium = Math.abs(tLeg.strikeOffset);
      idx = findStrikeIdxByPremium(
        optionChain.strikes,
        targetPremium,
        tLeg.optionType,
      );
    } else {
      idx = Math.max(
        0,
        Math.min(atmIdx + tLeg.strikeOffset, optionChain.strikes.length - 1),
      );
    }

    const strike = optionChain.strikes[idx].strike;
    const premium = getPremium(optionChain, idx, tLeg.optionType);

    store.addLegFromChain({
      strike,
      optionType: tLeg.optionType,
      side: tLeg.side,
      premium,
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
    });
  }
}
