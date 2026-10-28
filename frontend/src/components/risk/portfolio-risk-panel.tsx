"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, ShieldAlert, Sparkles, TriangleAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { analyzeStrategy, fetchBasketRiskPreview, fetchLimits, fetchPortfolioRisk } from "@/lib/api-client";
import { daysToExpiryFor, getUnderlyingMeta, rowValueMultiplier, underlyingOfSymbol } from "@/lib/instruments";
import { useBasketStore } from "@/stores/basket-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { usePositionStore } from "@/stores/position-store";
import type { Position } from "@/types/orders";
import type {
  AdjustmentSuggestion,
  PortfolioRiskGroup,
  PortfolioRiskLeg,
  PortfolioRiskResult,
  RegimeSnapshot,
  RiskFlag,
  RiskRegime,
  RiskSeverity,
  StrategyLeg,
  StrategyResult,
  TradeQualityAssessment,
  TradeQualityLabel,
} from "@/types/market-data";

type CapitalState = {
  accountNet: number | null;
  availableMargin: number | null;
  marginUsed: number | null;
  marginHeadroom: number | null;
};

type GroupDraft = Omit<PortfolioRiskGroup, "concentrationPct" | "suggestions"> & {
  exposureWeight: number;
};

const SEVERITY_ORDER: Record<RiskSeverity, number> = {
  safe: 0,
  elevated: 1,
  high: 2,
  critical: 3,
};

const SEVERITY_STYLES: Record<RiskSeverity, { dot: string; text: string; border: string; bg: string }> = {
  safe: {
    dot: "bg-green-400",
    text: "text-green-400",
    border: "border-green-400/20",
    bg: "bg-green-400/10",
  },
  elevated: {
    dot: "bg-yellow-400",
    text: "text-yellow-400",
    border: "border-yellow-400/20",
    bg: "bg-yellow-400/10",
  },
  high: {
    dot: "bg-red-400",
    text: "text-red-400",
    border: "border-red-400/20",
    bg: "bg-red-400/10",
  },
  critical: {
    dot: "bg-red-300",
    text: "text-red-300",
    border: "border-red-300/30",
    bg: "bg-red-500/15",
  },
};

function fmtInr(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}₹${Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function fmtPct(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${value.toFixed(digits)}%`;
}

function pnlToLoss(value: number | null): number | null {
  if (value === null || Number.isNaN(value)) return null;
  return Math.max(-value, 0);
}

function fmtLossInr(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `₹${Math.abs(value).toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}`;
}

function tailPnlHelper(value: number | null): string | undefined {
  if (value === null || Number.isNaN(value)) return undefined;
  return value >= 0
    ? `Raw tail P&L still profitable: ${fmtInr(value)}`
    : `Raw tail P&L: ${fmtInr(value)}`;
}

function lossDisplay(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return value <= 0 ? "No loss" : fmtLossInr(value);
}

function signedQty(pos: Position): number {
  return pos.side === "SELL" ? -Math.abs(pos.quantity) : Math.abs(pos.quantity);
}

function maxSeverityOf(a: RiskSeverity, b: RiskSeverity): RiskSeverity {
  return SEVERITY_ORDER[a] >= SEVERITY_ORDER[b] ? a : b;
}

function deriveIvRegime(iv: number | null, ivRank: number | null): RiskRegime | null {
  if (ivRank !== null) {
    if (ivRank >= 70) return "high";
    if (ivRank <= 30) return "low";
    return "neutral";
  }
  if (iv === null) return null;
  if (iv >= 0.35) return "high";
  if (iv <= 0.18) return "low";
  return "neutral";
}

function flag(severity: RiskSeverity, label: string, detail: string, context?: string): RiskFlag {
  return { severity, label, detail, context };
}

function pushFlag(flags: RiskFlag[], next?: RiskFlag | null): void {
  if (next) flags.push(next);
}

function suggestion(
  severity: RiskSeverity,
  label: string,
  rationale: string,
  action: string,
  estimatedImpact?: string,
  context?: string,
): AdjustmentSuggestion {
  return {
    severity,
    label,
    rationale,
    action,
    estimatedImpact,
    confidence: "medium",
    qualityRank: null,
    prerequisites: [],
    context,
  };
}

function buildClientSuggestions(
  group: {
    underlying: string;
    netDelta: number;
    netGamma: number;
    netVega: number;
    netVomma: number;
    dteMin: number | null;
    spot: number | null;
    concentrationPct: number | null;
    expectedMove: number | null;
    flags: RiskFlag[];
  },
): AdjustmentSuggestion[] {
  const suggestions: AdjustmentSuggestion[] = [];

  if (group.spot !== null && Math.abs(group.netDelta) >= 10) {
    const pnl1Pct = group.netDelta * group.spot * 0.01;
    suggestions.push(
      suggestion(
        "elevated",
        "Trim directional delta",
        `${group.underlying} carries ${group.netDelta.toFixed(1)} net delta. A 1% move changes P&L by about ${fmtInr(pnl1Pct)}.`,
        `${group.netDelta > 0 ? "Sell" : "Buy"} delta-equivalent underlying units or futures to bring the book closer to flat.`,
        `Reduces 1% directional swing by about ${fmtInr(pnl1Pct)}.`,
      ),
    );
  }

  if (group.netGamma < 0 && group.dteMin !== null && group.dteMin <= 7) {
    suggestions.push(
      suggestion(
        group.dteMin <= 3 ? "critical" : "high",
        "Reduce front-expiry short gamma",
        `${group.underlying} is short gamma with only ${group.dteMin} DTE on the nearest expiry, so delta can accelerate on routine spot moves.`,
        "Reduce or roll the shortest-dated short premium, or add long wings in the same expiry.",
        "Lowers delta flip risk and re-hedging pressure.",
      ),
    );
  }

  if (group.netVega < 0 && group.netVomma < 0) {
    suggestions.push(
      suggestion(
        "high",
        "Add long vol convexity",
        `${group.underlying} is short vega (${group.netVega.toFixed(1)}) with negative vomma (${group.netVomma.toFixed(1)}), so vol losses can accelerate if IV expands.`,
        "Shift some short premium into calendars or defined-risk wings, or reduce naked short-vol size.",
        "Improves behavior during IV expansion.",
      ),
    );
  }

  if (group.concentrationPct !== null && group.concentrationPct >= 0.35) {
    suggestions.push(
      suggestion(
        group.concentrationPct >= 0.5 ? "high" : "elevated",
        "Reduce single-name concentration",
        `${group.underlying} represents ${fmtPct(group.concentrationPct * 100)} of current portfolio exposure.`,
        `Trim or spread ${group.underlying} exposure before adding new directional or short-vol risk.`,
        "Makes portfolio-level P&L less path-dependent.",
      ),
    );
  }

  if (suggestions.length === 0 && group.flags.length > 0) {
    const primary = group.flags[0];
    suggestions.push(
      suggestion(
        primary.severity,
        `Review ${primary.label.toLowerCase()}`,
        primary.detail,
        "Reduce size or rebalance the riskiest leg first, then reassess the scenario view.",
        undefined,
        primary.context,
      ),
    );
  }

  return suggestions.slice(0, 3);
}

function buildLeg(
  pos: Position,
  greeks: {
    underlyingPrice?: number;
    delta?: number;
    gamma?: number;
    theta?: number;
    vega?: number;
    vanna?: number;
    charm?: number;
    vomma?: number;
    iv?: number;
  } | undefined,
  selectedUnderlying: string,
  chainSpot: number,
): PortfolioRiskLeg {
  const spot = greeks?.underlyingPrice ?? (selectedUnderlying === pos._underlying ? chainSpot : 0) ?? 0;
  const delta = greeks?.delta ?? 0;
  const gamma = greeks?.gamma ?? 0;
  const theta = greeks?.theta ?? 0;
  const vega = greeks?.vega ?? 0;
  const vanna = greeks?.vanna ?? 0;
  const charm = greeks?.charm ?? 0;
  const vomma = greeks?.vomma ?? 0;
  const qty = signedQty(pos);
  // Rupee-scale greeks/notional: ₹ per unit qty per ₹1 (GOLD 100, GOLDM 0.1, NSE 1)
  const vq = qty * rowValueMultiplier(pos);
  const exposureValue = spot > 0 ? Math.abs(vq) * spot : (pos.avgPrice > 0 ? Math.abs(vq) * pos.avgPrice : null);

  return {
    symbol: pos.symbol,
    underlying: pos._underlying ?? "UNKNOWN",
    expiry: pos._expiryIso ?? pos.expiry ?? "",
    strike: pos._strike ?? 0,
    optionType: pos._optionType ?? "CE",
    side: pos.side,
    quantity: qty,
    premium: pos.avgPrice,
    ltp: pos.ltp > 0 ? pos.ltp : null,
    iv: greeks?.iv ?? null,
    spot: spot > 0 ? spot : null,
    dte: pos._expiryIso ? daysToExpiryFor(pos._underlying, pos._expiryIso) : null,
    delta: vq * delta,
    gamma: vq * gamma,
    theta: vq * theta,
    vega: vq * vega,
    vanna: vq * vanna,
    charm: vq * charm,
    vomma: vq * vomma,
    exposureValue,
  };
}

function makeStrategyLeg(pos: Position, spot: number): StrategyLeg | null {
  if (!pos._underlying || !pos._expiryIso || !pos._strike || !pos._optionType) return null;
  return {
    symbol: pos.symbol,
    strike: pos._strike,
    optionType: pos._optionType,
    side: pos.side,
    quantity: Math.abs(pos.quantity),
    premium: pos.avgPrice > 0 ? pos.avgPrice : pos.ltp > 0 ? pos.ltp : 0,
    orderType: "LIMIT",
    productType: (pos.productType || "NRML") as "NRML" | "MIS",
    underlying: pos._underlying,
    expiry: pos._expiryIso,
    spot: spot > 0 ? spot : undefined,
  };
}

function formatCapitalLimits(limits: CapitalState): string {
  const accountNet = limits.accountNet !== null ? fmtInr(limits.accountNet) : "—";
  const available = limits.availableMargin !== null ? fmtInr(limits.availableMargin) : "—";
  return `${accountNet} net | ${available} headroom`;
}

export function PortfolioRiskPanel({ mode = "positions" }: { mode?: "positions" | "basket" }) {
  const positions = usePositionStore((s) => s.positions);
  const basketLegs = useBasketStore((s) => s.legs);
  const positionGreeksMap = useGreeksStore((s) => s.positionGreeks);
  useGreeksStore((s) => s.positionGreeksVersion);
  const greeksMap = useGreeksStore((s) => s.greeks);
  useGreeksStore((s) => s.greeksVersion);
  const optionChain = useMarketDataStore((s) => s.optionChain);
  const selectedUnderlying = useMarketDataStore((s) => s.selectedUnderlying);
  const selectedExpiry = useMarketDataStore((s) => s.selectedExpiry);
  const feedMode = useMarketDataStore((s) => s.feedMode);
  const vrp = useMarketDataStore((s) => s.vrp);

  const [capital, setCapital] = useState<CapitalState>({
    accountNet: null,
    availableMargin: null,
    marginUsed: null,
    marginHeadroom: null,
  });
  const [analysisByUnderlying, setAnalysisByUnderlying] = useState<Record<string, StrategyResult | null>>({});
  const [remoteRisk, setRemoteRisk] = useState<PortfolioRiskResult | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const openPositions = useMemo(() => {
    if (mode === "basket") {
      // Convert basket StrategyLegs to synthetic Position objects
      return basketLegs.map((leg) => ({
        symbol: leg.symbol,
        exchange: getUnderlyingMeta(underlyingOfSymbol(leg.symbol))?.exchange ?? "NSE",
        quantity: leg.side === "BUY" ? leg.quantity : -leg.quantity,
        avgPrice: leg.premium,
        ltp: leg.premium,
        pnl: 0,
        side: leg.side as "BUY" | "SELL",
        isOpen: true,
        optionType: leg.optionType,
        strikePrice: String(leg.strike),
        expiry: leg.expiry ?? "",
        _underlying: leg.underlying ?? leg.symbol.split(" ")[0] ?? "",
        _strike: leg.strike,
        _optionType: leg.optionType as "CE" | "PE",
        _expiryIso: leg.expiry ?? "",
      }));
    }
    return positions.filter((p) => (p as Record<string, unknown>).isOpen !== false);
  }, [mode, basketLegs, positions]);

  useEffect(() => {
    if (mode === "basket" || feedMode !== "broker") return;
    let cancelled = false;

    async function load() {
      try {
        const limits = await fetchLimits();
        if (cancelled) return;

        const accountNet = limits.net ?? ((limits.collateral ?? 0) + (limits.marginFromShares ?? 0));
        const marginUsed = limits.marginUsed ?? null;
        const availableMargin = accountNet !== null && marginUsed !== null ? accountNet - marginUsed : null;

        setCapital({
          accountNet,
          availableMargin,
          marginUsed,
          marginHeadroom: availableMargin,
        });
      } catch {
        if (!cancelled) {
          setCapital({
            accountNet: null,
            availableMargin: null,
            marginUsed: null,
            marginHeadroom: null,
          });
        }
      }
    }

    load();
    const interval = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mode, feedMode, refreshNonce]);

  const groupedDrafts = useMemo(() => {
    const map = new Map<string, { underlying: string; positions: Position[]; spot: number }>();

    for (const pos of openPositions) {
      const underlying = pos._underlying || pos.symbol;
      const current = map.get(underlying) ?? { underlying, positions: [], spot: 0 };
      current.positions.push(pos);

      const chainSpot =
        optionChain?.underlying === underlying ? (optionChain?.underlyingPrice ?? 0) : 0;
      const greeks = positionGreeksMap.get(pos.symbol) ?? greeksMap.get(pos.symbol);
      const spot = greeks?.underlyingPrice ?? chainSpot;
      if (spot > 0 && current.spot === 0) current.spot = spot;

      map.set(underlying, current);
    }

    return [...map.values()].sort((a, b) => {
      if (a.underlying === selectedUnderlying) return -1;
      if (b.underlying === selectedUnderlying) return 1;
      return a.underlying.localeCompare(b.underlying);
    });
  }, [openPositions, optionChain, positionGreeksMap, greeksMap, selectedUnderlying]);

  // Stable fingerprint: only re-fetch analyses when positions actually change,
  // not on every greeks/spot tick that updates groupedDrafts.
  const positionFingerprint = useMemo(() => {
    return groupedDrafts
      .map((g) =>
        `${g.underlying}:${g.positions.map((p) => `${p.symbol}|${p.quantity}`).sort().join(",")}`,
      )
      .sort()
      .join(";");
  }, [groupedDrafts]);

  const prevFingerprintRef = useRef(positionFingerprint);
  const groupedDraftsRef = useRef(groupedDrafts);
  groupedDraftsRef.current = groupedDrafts;

  useEffect(() => {
    let cancelled = false;

    async function loadAnalyses() {
      const drafts = groupedDraftsRef.current;
      if (drafts.length === 0) {
        setAnalysisByUnderlying({});
        return;
      }

      const entries = await Promise.all(
        drafts.map(async (group) => {
          const legs = group.positions
            .map((pos) => makeStrategyLeg(pos, group.spot))
            .filter((leg): leg is StrategyLeg => leg !== null);

          if (legs.length === 0) return [group.underlying, null] as const;

          try {
            const result = await analyzeStrategy(legs);
            return [group.underlying, result] as const;
          } catch {
            return [group.underlying, null] as const;
          }
        }),
      );

      if (!cancelled) {
        setAnalysisByUnderlying(Object.fromEntries(entries));
      }
    }

    prevFingerprintRef.current = positionFingerprint;
    loadAnalyses();
    return () => {
      cancelled = true;
    };
  }, [positionFingerprint, refreshNonce]);

  useEffect(() => {
    if (mode === "basket") {
      if (basketLegs.length === 0) {
        setRemoteRisk(null);
        return;
      }

      let cancelled = false;

      async function loadBasketRisk() {
        setIsRefreshing(true);
        try {
          const chain = useMarketDataStore.getState().optionChain;
          const spot = chain?.underlyingPrice ?? 0;
          const enriched = basketLegs.map((leg) => {
            const parts = leg.symbol.split(" ");
            let expiry = leg.expiry;
            if (!expiry && parts.length >= 4 && parts[1].length === 6) {
              const [yy, mm, dd] = [parts[1].slice(0, 2), parts[1].slice(2, 4), parts[1].slice(4, 6)];
              expiry = `20${yy}-${mm}-${dd}`;
            }
            return {
              ...leg,
              underlying: leg.underlying ?? (parts.length >= 1 ? parts[0] : undefined),
              expiry,
              spot: spot > 0 ? spot : undefined,
            };
          });
          const risk = await fetchBasketRiskPreview(enriched);
          if (!cancelled) setRemoteRisk(risk);
        } catch {
          if (!cancelled) setRemoteRisk(null);
        } finally {
          if (!cancelled) setIsRefreshing(false);
        }
      }

      loadBasketRisk();
      return () => {
        cancelled = true;
      };
    }

    if (feedMode !== "broker" || openPositions.length === 0) {
      setRemoteRisk(null);
      return;
    }

    let cancelled = false;

    async function load() {
      setIsRefreshing(true);
      try {
        const risk = await fetchPortfolioRisk();
        if (!cancelled) setRemoteRisk(risk);
      } catch {
        if (!cancelled) setRemoteRisk(null);
      } finally {
        if (!cancelled) setIsRefreshing(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [mode, basketLegs, feedMode, openPositions.length, selectedUnderlying, selectedExpiry, refreshNonce]);

  const localRisk = useMemo<PortfolioRiskResult>(() => {
    const drafts: GroupDraft[] = [];
    let totalExposureValue = 0;
    let netDelta = 0;
    let netGamma = 0;
    let netTheta = 0;
    let netVega = 0;
    let netVanna = 0;
    let netCharm = 0;
    let netVomma = 0;
    let totalExpectedMove = 0;
    let totalVar5 = 0;
    let totalEs5 = 0;

    for (const group of groupedDrafts) {
      let spot = group.spot > 0 ? group.spot : null;
      let iv = 0;
      let ivWeight = 0;
      let dteMin: number | null = null;
      let exposureValue = 0;
      const expiryCount = new Set<string>();
      let openLegCount = 0;
      let groupDelta = 0;
      let groupGamma = 0;
      let groupTheta = 0;
      let groupVega = 0;
      let groupVanna = 0;
      let groupCharm = 0;
      let groupVomma = 0;
      const legs: PortfolioRiskLeg[] = [];

      for (const pos of group.positions) {
        const greeks = positionGreeksMap.get(pos.symbol) ?? greeksMap.get(pos.symbol);
        const leg = buildLeg(pos, greeks, selectedUnderlying, group.spot);
        legs.push(leg);
        openLegCount += 1;

        groupDelta += leg.delta;
        groupGamma += leg.gamma;
        groupTheta += leg.theta;
        groupVega += leg.vega;
        groupVanna += leg.vanna;
        groupCharm += leg.charm;
        groupVomma += leg.vomma;
        if (leg.exposureValue !== null) exposureValue += leg.exposureValue;
        if (leg.iv !== null && leg.exposureValue !== null) {
          iv += leg.iv * leg.exposureValue;
          ivWeight += leg.exposureValue;
        }
        if (spot === null && leg.spot !== null) spot = leg.spot;
        if (leg.dte !== null) {
          dteMin = dteMin === null ? leg.dte : Math.min(dteMin, leg.dte);
        }
        if (leg.expiry) expiryCount.add(leg.expiry);
      }

      const weightedIv = ivWeight > 0 ? iv / ivWeight : null;
      const ivRank = vrp?.underlying === group.underlying ? vrp.ivRank : null;
      const ivRegime = deriveIvRegime(weightedIv, ivRank);
      const expectedMove = spot !== null && weightedIv !== null ? spot * weightedIv / Math.sqrt(252) : null;
      const expectedMovePct = weightedIv !== null ? (weightedIv / Math.sqrt(252)) * 100 : null;
      const analysis = analysisByUnderlying[group.underlying] ?? null;
      const flags: RiskFlag[] = [];

      pushFlag(
        flags,
        dteMin !== null && groupGamma < 0 && dteMin <= 3
          ? flag("high", "Short gamma near expiry", `Gamma can flip delta quickly with only ${dteMin} DTE left. Small moves can force frequent hedging.`, `Nearest expiry: ${dteMin}d`)
          : dteMin !== null && groupGamma < 0 && dteMin <= 7
            ? flag("elevated", "Short gamma tightening", `Short gamma is manageable for now, but expiry is close enough that delta can accelerate on routine moves.`, `Nearest expiry: ${dteMin}d`)
            : null,
      );

      pushFlag(
        flags,
        ivRegime === "high" && groupVega < 0
          ? flag("high", "Short vega in high IV", "Vol expansion hurts the book when IV is already elevated. The position is exposed to mean reversion in the wrong direction.", `IV rank/regime: ${ivRank !== null ? `${ivRank.toFixed(0)}%` : ivRegime}`)
          : ivRegime === "low" && groupVega > 0
            ? flag("elevated", "Long vega at low IV", "Long vol is structurally better when implied volatility is cheap, but catalyst risk remains.", `IV rank/regime: ${ivRank !== null ? `${ivRank.toFixed(0)}%` : ivRegime}`)
            : null,
      );

      if (analysis?.riskNeutralPop != null && analysis.riskNeutralPop < 0.4) {
        pushFlag(
          flags,
          flag(
            analysis.riskNeutralPop < 0.25 ? "high" : "elevated",
            "Weak expiry PoP",
            `Model-implied probability of profit is only ${(analysis.riskNeutralPop * 100).toFixed(1)}%.`,
            `Heston PoP: ${(analysis.riskNeutralPop * 100).toFixed(1)}%`,
          ),
        );
      }

      drafts.push({
        underlying: group.underlying,
        spot,
        iv: weightedIv,
        ivRank,
        ivRegime,
        dteMin,
        openLegCount,
        expiryCount: expiryCount.size,
        exposureValue,
        netDelta: groupDelta,
        netGamma: groupGamma,
        netTheta: groupTheta,
        netVega: groupVega,
        netVanna: groupVanna,
        netCharm: groupCharm,
        netVomma: groupVomma,
        expectedMove,
        expectedMovePct,
        var5: analysis?.var5 ?? null,
        es5: analysis?.es5 ?? null,
        riskNeutralPop: analysis?.riskNeutralPop ?? null,
        vgPop: analysis?.vgPop ?? null,
        marketPop: analysis?.marketPop ?? null,
        popEdge: analysis?.popEdge ?? null,
        marginUsed: capital.marginUsed,
        marginHeadroom: capital.marginHeadroom,
        scenario1s: null,
        scenario2s: null,
        scenario3s: null,
        flags,
        legs,
        exposureWeight: exposureValue,
        regimeSnapshot: analysis?.regimeSnapshot ?? null,
        tradeQuality: analysis?.tradeQuality ?? null,
      });

      netDelta += groupDelta;
      netGamma += groupGamma;
      netTheta += groupTheta;
      netVega += groupVega;
      netVanna += groupVanna;
      netCharm += groupCharm;
      netVomma += groupVomma;
      if (expectedMove !== null) totalExpectedMove += Math.abs(expectedMove);
      if (analysis?.var5 != null) totalVar5 += analysis.var5;
      if (analysis?.es5 != null) totalEs5 += analysis.es5;
      totalExposureValue += exposureValue;
    }

    const groups = drafts.map((draft) => {
      const concentrationPct = totalExposureValue > 0 ? draft.exposureWeight / totalExposureValue : null;
      const flags = [...draft.flags];

      if (concentrationPct !== null) {
        pushFlag(
          flags,
          concentrationPct > 0.5
            ? flag("high", "Concentrated book", `This underlying represents ${(concentrationPct * 100).toFixed(1)}% of total notional exposure.`, "Reduce single-name concentration")
            : concentrationPct > 0.35
              ? flag("elevated", "Meaningful concentration", `This underlying represents ${(concentrationPct * 100).toFixed(1)}% of total notional exposure.`, "Watch single-name concentration")
              : null,
        );
      }

      const suggestions = buildClientSuggestions({
        underlying: draft.underlying,
        netDelta: draft.netDelta,
        netGamma: draft.netGamma,
        netVega: draft.netVega,
        netVomma: draft.netVomma,
        dteMin: draft.dteMin,
        spot: draft.spot,
        concentrationPct,
        expectedMove: draft.expectedMove,
        flags,
      });

      return {
        ...draft,
        concentrationPct,
        flags,
        suggestions,
        regimeSnapshot: draft.regimeSnapshot,
        tradeQuality: draft.tradeQuality,
      };
    });

    const summaryFlags: RiskFlag[] = [];
    for (const group of groups) {
      const worst = group.flags.reduce<RiskFlag | null>((acc, next) => {
        if (!acc) return next;
        return SEVERITY_ORDER[next.severity] > SEVERITY_ORDER[acc.severity] ? next : acc;
      }, null);

      if (worst) {
        summaryFlags.push(
          flag(
            worst.severity,
            `${group.underlying}: ${worst.label}`,
            worst.detail,
            worst.context,
          ),
        );
      }
    }

    const maxSeverity = summaryFlags.reduce<RiskSeverity>(
      (acc, next) => (SEVERITY_ORDER[next.severity] > SEVERITY_ORDER[acc] ? next.severity : acc),
      "safe",
    );
    const summarySuggestions = groups.flatMap((group) => group.suggestions)
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity])
      .slice(0, 6);

    return {
      source: "client",
      generatedAt: new Date().toISOString(),
      selectedUnderlying: selectedUnderlying || null,
      selectedExpiry: selectedExpiry || null,
      accountNet: capital.accountNet,
      availableMargin: capital.availableMargin,
      marginUsed: capital.marginUsed,
      marginHeadroom: capital.marginHeadroom,
      openPositionCount: openPositions.length,
      underlyingCount: groups.length,
      groups,
      summary: {
        openPositionCount: openPositions.length,
        underlyingCount: groups.length,
        totalExposureValue: totalExposureValue > 0 ? totalExposureValue : null,
        totalExpectedMove: totalExpectedMove > 0 ? totalExpectedMove : null,
        totalVar5: totalVar5 !== 0 ? totalVar5 : null,
        totalEs5: totalEs5 !== 0 ? totalEs5 : null,
        netDelta,
        netGamma,
        netTheta,
        netVega,
        netVanna,
        netCharm,
        netVomma,
        maxSeverity,
        flags: summaryFlags.slice(0, 6),
        suggestions: summarySuggestions,
      },
    };
  }, [
    analysisByUnderlying,
    capital.accountNet,
    capital.availableMargin,
    capital.marginHeadroom,
    capital.marginUsed,
    groupedDrafts,
    greeksMap,
    openPositions.length,
    positionGreeksMap,
    selectedExpiry,
    selectedUnderlying,
    vrp,
  ]);

  // Prefer localRisk for live-updating greeks; fall back to remoteRisk only
  // when local data hasn't been computed yet (no greeks/positions loaded).
  const risk = localRisk.groups.length > 0 ? localRisk : (remoteRisk ?? localRisk);
  const overallSeverity = risk.summary.maxSeverity;
  const worstStyle = SEVERITY_STYLES[overallSeverity];
  const selectedGroup = risk.groups.find((group) => group.underlying === selectedUnderlying) ?? risk.groups[0] ?? null;
  const selectedVarLoss = pnlToLoss(selectedGroup?.var5 ?? null);
  const selectedEsLoss = pnlToLoss(selectedGroup?.es5 ?? null);

  if (openPositions.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1a1a2e] text-[11px] text-panel-subtle">
        {mode === "basket"
          ? "Add legs to the basket to see pre-trade risk"
          : "No open positions — risk management will populate once positions are live"}
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#1a1a2e] text-xs">
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={`rounded-sm border ${worstStyle.border} ${worstStyle.bg} ${worstStyle.text}`}>
                <ShieldAlert className="mr-1 h-3 w-3" />
                {mode === "basket" ? "Pre-trade risk" : risk.source === "backend" ? "Backend risk" : "Client risk"}
              </Badge>
              <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${worstStyle.border} ${worstStyle.text}`}>
                <span className={`h-2 w-2 rounded-full ${worstStyle.dot}`} />
                {overallSeverity}
              </span>
              <span className="text-[11px] font-medium text-panel-subtle">
                {mode === "basket"
                  ? `${risk.openPositionCount} leg${risk.openPositionCount !== 1 ? "s" : ""} across ${risk.underlyingCount} underlying${risk.underlyingCount !== 1 ? "s" : ""}`
                  : `${risk.openPositionCount} open positions across ${risk.underlyingCount} underlyings`}
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-panel-muted">
              {mode !== "basket" && <span>{formatCapitalLimits(capital)}</span>}
              <span>Selected: {selectedUnderlying || "All"} {selectedExpiry ? `• ${selectedExpiry}` : ""}</span>
              {isRefreshing && <span className="text-yellow-400">Refreshing model view...</span>}
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="border-panel-border bg-panel text-panel-faint hover:border-ring hover:bg-panel hover:text-panel-muted"
            onClick={() => {
              setRefreshNonce((value) => value + 1);
            }}
          >
            <Sparkles className="mr-1 h-3 w-3" />
            Refresh
          </Button>
        </div>

        <div className="mt-2 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <MiniStat label="Net delta" value={risk.summary.netDelta.toFixed(1)} tone={risk.summary.netDelta > 0 ? "text-green-400" : risk.summary.netDelta < 0 ? "text-red-400" : "text-panel-muted"} />
          <MiniStat label="Net gamma" value={risk.summary.netGamma.toFixed(2)} tone={risk.summary.netGamma < 0 ? "text-red-400" : "text-green-400"} />
          <MiniStat label="Net vega" value={risk.summary.netVega.toFixed(1)} tone={risk.summary.netVega < 0 ? "text-red-400" : "text-green-400"} />
          <MiniStat label="Expected move" value={fmtInr(risk.summary.totalExpectedMove)} tone="text-yellow-300" sub={selectedGroup?.expectedMovePct != null ? `${fmtPct(selectedGroup.expectedMovePct)} 1σ` : undefined} />
        </div>
      </div>

      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
        <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
          <MetricCard
            label="VaR / ES"
            value={selectedGroup?.var5 != null ? `${lossDisplay(selectedVarLoss)} / ${lossDisplay(selectedEsLoss)}` : "—"}
            helper={selectedGroup?.var5 != null
              ? `${tailPnlHelper(selectedGroup.var5) ?? "—"}${selectedGroup?.es5 != null ? ` • ${tailPnlHelper(selectedGroup.es5) ?? "—"}` : ""}`
              : "From strategy analyzer when available"}
          />
          <MetricCard label="PoP edge" value={selectedGroup?.popEdge != null ? fmtPct((selectedGroup.popEdge ?? 0) * 100, 1) : "—"} helper="Model PoP minus market PoP" />
          {mode !== "basket" && <MetricCard label="Margin headroom" value={capital.availableMargin !== null ? fmtInr(capital.availableMargin) : "—"} helper={capital.marginUsed !== null ? `Used: ${fmtInr(capital.marginUsed)}` : "Account limits unavailable"} />}
        </div>
      </div>

      {risk.summary.flags.length > 0 && (
        <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-panel-subtle">
            Key flags
          </div>
          <div className="flex flex-wrap gap-1.5">
            {risk.summary.flags.map((item, index) => {
              const styles = SEVERITY_STYLES[item.severity];
              return (
                <Badge key={`${item.label}-${index}`} variant="outline" className={`rounded-sm border ${styles.border} ${styles.bg} ${styles.text}`}>
                  <TriangleAlert className="mr-1 h-3 w-3" />
                  {item.label}
                </Badge>
              );
            })}
          </div>
        </div>
      )}

      {risk.summary.suggestions.length > 0 && (
        <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
          <button
            type="button"
            className="flex w-full items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-panel-subtle hover:text-[#e0e0e0]"
            onClick={() => setSuggestionsOpen((prev) => !prev)}
          >
            {suggestionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            Adjustment suggestions ({risk.summary.suggestions.length})
          </button>
          {suggestionsOpen && (
            <div className="mt-2 grid gap-2 xl:grid-cols-2">
              {risk.summary.suggestions.slice(0, 4).map((item, index) => {
                const styles = SEVERITY_STYLES[item.severity];
                return (
                  <div key={`${item.label}-${index}`} className={`rounded border px-2.5 py-2 ${styles.border} ${styles.bg}`}>
                    <div className="flex items-center justify-between gap-2">
                      <div className={`text-[11px] font-semibold ${styles.text}`}>{item.label}</div>
                      <span className="text-[10px] uppercase tracking-wider text-panel-subtle">{item.confidence}</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-snug text-[#c2c2d0]">{item.rationale}</div>
                    <div className="mt-1 text-[11px] leading-snug text-[#e0e0e0]">
                      <span className="font-semibold text-panel-subtle">Action:</span> {item.action}
                    </div>
                    {item.estimatedImpact && (
                      <div className="mt-1 text-[10px] text-panel-subtle">{item.estimatedImpact}</div>
                    )}
                    {item.context && (
                      <div className="mt-1 text-[10px] text-panel-subtle">{item.context}</div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-1 gap-2 p-3">
          {risk.groups.map((group) => {
            const groupSeverity = group.flags.reduce<RiskSeverity>(
              (acc, next) => maxSeverityOf(acc, next.severity),
              "safe",
            );
            const styles = SEVERITY_STYLES[groupSeverity];

            return (
              <div key={group.underlying} className={`rounded border ${styles.border} bg-[#0f0f23] px-3 py-2`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`inline-block h-2 w-2 rounded-full ${styles.dot}`} />
                      <span className="text-sm font-semibold text-[#e0e0e0]">{group.underlying}</span>
                      {group.underlying === selectedUnderlying && (
                        <Badge variant="outline" className="rounded-sm border-blue-500/40 bg-blue-500/10 text-blue-300">
                          Focus
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-2 text-[10px] text-panel-subtle">
                      <span>{group.openLegCount} legs</span>
                      <span>{group.expiryCount} expiries</span>
                      <span>{group.dteMin !== null ? `${group.dteMin} DTE min` : "DTE n/a"}</span>
                      {group.ivRank !== null && <span>IVR {group.ivRank.toFixed(0)}%</span>}
                    </div>
                  </div>
                  <span className={`rounded-sm border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${styles.border} ${styles.text}`}>
                    {groupSeverity}
                  </span>
                </div>

                <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-4">
                  <InlineStat label="Spot" value={fmtInr(group.spot)} />
                  <InlineStat label="1σ move" value={fmtInr(group.expectedMove)} sub={group.expectedMovePct !== null ? fmtPct(group.expectedMovePct) : undefined} />
                  <InlineStat label="Delta" value={group.netDelta.toFixed(1)} tone={group.netDelta > 0 ? "text-green-400" : group.netDelta < 0 ? "text-red-400" : "text-panel-muted"} />
                  <InlineStat label="Vega" value={group.netVega.toFixed(1)} tone={group.netVega < 0 ? "text-red-400" : "text-green-400"} />
                  <InlineStat label="VaR(5%)" value={group.var5 !== null ? lossDisplay(pnlToLoss(group.var5)) : "—"} sub={tailPnlHelper(group.var5)} />
                  <InlineStat label="ES(5%)" value={group.es5 !== null ? lossDisplay(pnlToLoss(group.es5)) : "—"} sub={tailPnlHelper(group.es5)} />
                  <InlineStat label="PoP" value={group.riskNeutralPop !== null ? fmtPct(group.riskNeutralPop * 100) : "—"} />
                  <InlineStat label="Concentration" value={group.concentrationPct !== null ? fmtPct(group.concentrationPct * 100) : "—"} />
                </div>

                {group.scenario1s && (
                  <div className="mt-2 grid grid-cols-3 gap-2">
                    <InlineStat
                      label="1σ worst"
                      value={fmtInr(group.scenario1s.worstPnl)}
                      tone={group.scenario1s.worstPnl < 0 ? "text-red-400" : "text-green-400"}
                      sub={`${fmtInr(group.scenario1s.spotDown, 0)} / ${fmtInr(group.scenario1s.spotUp, 0)}`}
                    />
                    {group.scenario2s && (
                      <InlineStat
                        label="2σ worst"
                        value={fmtInr(group.scenario2s.worstPnl)}
                        tone={group.scenario2s.worstPnl < 0 ? "text-red-400" : "text-green-400"}
                        sub={`${fmtInr(group.scenario2s.spotDown, 0)} / ${fmtInr(group.scenario2s.spotUp, 0)}`}
                      />
                    )}
                    {group.scenario3s && (
                      <InlineStat
                        label="3σ stress"
                        value={fmtInr(group.scenario3s.worstPnl)}
                        tone={group.scenario3s.worstPnl < 0 ? "text-red-400" : "text-green-400"}
                        sub={`${fmtInr(group.scenario3s.spotDown, 0)} / ${fmtInr(group.scenario3s.spotUp, 0)}`}
                      />
                    )}
                  </div>
                )}

                <RiskQualityActionStrip group={group} />

                <div className="mt-2 flex flex-wrap gap-1.5">
                  {group.flags.length === 0 ? (
                    <Badge variant="outline" className="rounded-sm border-panel-border bg-panel-header text-panel-faint">
                      Stable
                    </Badge>
                  ) : (
                    group.flags.map((item, index) => {
                      const flagStyle = SEVERITY_STYLES[item.severity];
                      return (
                        <Badge key={`${group.underlying}-${index}`} variant="outline" className={`rounded-sm border ${flagStyle.border} ${flagStyle.bg} ${flagStyle.text}`}>
                          {item.label}
                        </Badge>
                      );
                    })
                  )}
                </div>

                <div className="mt-2 space-y-1">
                  {group.flags.slice(0, 2).map((item, index) => (
                    <div key={`${group.underlying}-detail-${index}`} className="text-[11px] leading-snug text-[#b0b0c0]">
                      <span className={`font-semibold ${SEVERITY_STYLES[item.severity].text}`}>{item.label}:</span>{" "}
                      {item.detail}
                      {item.context ? <span className="text-[#808090]"> ({item.context})</span> : null}
                    </div>
                  ))}
                </div>

                {group.suggestions.length > 0 && (
                  <div className="mt-3 rounded border border-[#2a2a4a] bg-[#16162a] px-2.5 py-2">
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-panel-subtle">
                      Suggested adjustments
                    </div>
                    <div className="mt-1 space-y-2">
                      {group.suggestions.slice(0, 2).map((item, index) => (
                        <div key={`${group.underlying}-suggestion-${index}`} className="text-[11px] leading-snug text-[#c2c2d0]">
                          <span className={`font-semibold ${SEVERITY_STYLES[item.severity].text}`}>{item.label}:</span>{" "}
                          {item.action}
                          <div className="mt-0.5 text-[10px] text-panel-subtle">{item.rationale}</div>
                          {item.estimatedImpact ? (
                            <div className="text-[10px] text-panel-subtle">{item.estimatedImpact}</div>
                          ) : null}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const QUALITY_STYLES: Record<string, { text: string; border: string; bg: string }> = {
  strong: { text: "text-green-400", border: "border-green-400/20", bg: "bg-green-400/10" },
  favorable: { text: "text-blue-400", border: "border-blue-400/20", bg: "bg-blue-400/10" },
  mixed: { text: "text-yellow-400", border: "border-yellow-400/20", bg: "bg-yellow-400/10" },
  poor: { text: "text-red-400", border: "border-red-400/20", bg: "bg-red-400/10" },
  unknown: { text: "text-panel-subtle", border: "border-panel-border", bg: "bg-panel" },
};

const REGIME_STYLES_RQA: Record<string, { text: string; border: string; bg: string }> = {
  stressed: { text: "text-red-300", border: "border-red-300/30", bg: "bg-red-500/15" },
  event_rich: { text: "text-amber-400", border: "border-amber-400/20", bg: "bg-amber-400/10" },
  elevated: { text: "text-yellow-400", border: "border-yellow-400/20", bg: "bg-yellow-400/10" },
  compressed: { text: "text-cyan-400", border: "border-cyan-400/20", bg: "bg-cyan-400/10" },
  balanced: { text: "text-green-400", border: "border-green-400/20", bg: "bg-green-400/10" },
  unknown: { text: "text-panel-subtle", border: "border-panel-border", bg: "bg-panel" },
};

const RISK_METRIC_TOOLTIPS: Record<string, string> = {
  "1σ move": "Expected one-standard-deviation move in the underlying over the model horizon. It is an estimate, not a hard bound.",
  "Expected move": "Expected one-standard-deviation move in the underlying over the model horizon. It is an estimate, not a hard bound.",
  "VaR(5%)": "Value at Risk at 5% shown in loss convention. It is the positive loss threshold expected to be exceeded only about 5% of the time. If the worst 5% is still profitable, displayed VaR is ₹0 and the raw tail P&L is shown below.",
  "ES(5%)": "Expected Shortfall at 5% shown in loss convention. It is the average loss in the worst 5% of modeled outcomes. If the worst 5% is still profitable, displayed ES is ₹0 and the raw tail P&L is shown below.",
  "PoP": "Probability of Profit: model-implied chance that the position finishes profitable at expiry under the pricing model.",
};

function MetricLabel({ label }: { label: string }) {
  const tooltip = RISK_METRIC_TOOLTIPS[label];
  return (
    <div
      className="text-[9px] font-medium uppercase tracking-wider text-panel-subtle"
      title={tooltip}
    >
      {label}
    </div>
  );
}

function RiskQualityActionStrip({ group }: { group: PortfolioRiskGroup }) {
  const regime = group.regimeSnapshot;
  const quality = group.tradeQuality;
  const topSuggestion = group.suggestions[0] ?? null;

  const regimeStyle = REGIME_STYLES_RQA[regime?.regimeLabel ?? "unknown"] ?? REGIME_STYLES_RQA.unknown;
  const qualityStyle = QUALITY_STYLES[quality?.overallLabel ?? "unknown"] ?? QUALITY_STYLES.unknown;

  return (
    <div className="mt-2 grid grid-cols-3 gap-2">
      {/* ── Risk ── */}
      <div className={`rounded border ${regimeStyle.border} ${regimeStyle.bg} px-2 py-1.5`}>
        <div className="text-[9px] font-semibold uppercase tracking-wider text-panel-subtle">Risk</div>
        {regime ? (
          <>
            <div className={`text-xs font-semibold ${regimeStyle.text}`}>
              {regime.regimeLabel.replace("_", " ")}
            </div>
            {regime.eventTags.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {regime.eventTags.slice(0, 2).map((tag) => (
                  <span key={tag} className="rounded-sm border border-amber-400/30 bg-amber-400/10 px-1 py-0 text-[9px] text-amber-300">
                    {tag}
                  </span>
                ))}
              </div>
            )}
            {regime.drivers.length > 0 && (
              <div className="mt-0.5 text-[10px] text-panel-subtle">
                {regime.drivers.slice(0, 2).join(" · ")}
              </div>
            )}
          </>
        ) : (
          <div className="text-[10px] text-panel-subtle">Requires backend</div>
        )}
      </div>

      {/* ── Quality ── */}
      <div className={`rounded border ${qualityStyle.border} ${qualityStyle.bg} px-2 py-1.5`}>
        <div className="text-[9px] font-semibold uppercase tracking-wider text-panel-subtle">Quality</div>
        {quality ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className={`text-xs font-semibold ${qualityStyle.text}`}>
                {quality.overallLabel}
              </span>
              {quality.overallScore != null && (
                <span className="text-[10px] text-panel-subtle">{quality.overallScore.toFixed(0)}/100</span>
              )}
            </div>
            {quality.rationale.length > 0 && (
              <div className="mt-0.5 text-[10px] leading-snug text-[#b0b0c0]">
                {quality.rationale[0]}
              </div>
            )}
            {quality.headwinds.length > 0 && (
              <div className="mt-0.5 text-[10px] leading-snug text-[#a08080]">
                ⚠ {quality.headwinds[0]}
              </div>
            )}
          </>
        ) : (
          <div className="text-[10px] text-panel-subtle">Requires backend</div>
        )}
      </div>

      {/* ── Action ── */}
      <div className="rounded border border-[#2a2a4a] bg-[#16162a] px-2 py-1.5">
        <div className="text-[9px] font-semibold uppercase tracking-wider text-panel-subtle">Action</div>
        {topSuggestion ? (
          <>
            <div className={`text-xs font-semibold ${SEVERITY_STYLES[topSuggestion.severity].text}`}>
              {topSuggestion.label}
            </div>
            <div className="mt-0.5 text-[10px] leading-snug text-[#c2c2d0]">{topSuggestion.action}</div>
          </>
        ) : (
          <div className="text-[10px] text-panel-subtle">No action needed</div>
        )}
      </div>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: string;
  sub?: string;
}) {
  return (
    <div className="rounded border border-[#2a2a4a] bg-[#0f0f23] px-2.5 py-2">
      <MetricLabel label={label} />
      <div className={`mt-0.5 text-base font-bold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-panel-subtle">{sub}</div>}
    </div>
  );
}

function MetricCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded border border-[#2a2a4a] bg-[#0f0f23] px-2.5 py-2">
      <MetricLabel label={label} />
      <div className="mt-0.5 text-sm font-semibold text-[#e0e0e0]">{value}</div>
      <div className="text-[10px] text-panel-subtle">{helper}</div>
    </div>
  );
}

function InlineStat({
  label,
  value,
  tone = "text-[#e0e0e0]",
  sub,
}: {
  label: string;
  value: string;
  tone?: string;
  sub?: string;
}) {
  return (
    <div className="rounded border border-[#2a2a4a] bg-[#1a1a2e] px-2 py-1.5">
      <MetricLabel label={label} />
      <div className={`text-sm font-semibold tabular-nums ${tone}`}>{value}</div>
      {sub && <div className="text-[10px] text-panel-subtle">{sub}</div>}
    </div>
  );
}
