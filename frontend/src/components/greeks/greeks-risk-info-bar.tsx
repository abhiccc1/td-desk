"use client";

import { useState, useMemo } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

import { daysToExpiryFor } from "@/lib/instruments";
import type { VrpResult } from "@/types/market-data";

// ── Types ────────────────────────────────────────────────────────────

type RiskLevel = "safe" | "elevated" | "high";

interface ProfileSummary {
  label: string;
  detail: string;
}

interface GreekAssessment {
  level: RiskLevel;
  label: string;
  detail: string;
  dollarMetric?: string;
  context?: string;
  currentValue?: string;
  driver?: string;
  idealRange?: string;
  moderateRange?: string;
  highRange?: string;
}

interface RiskLeg {
  symbol: string;
  expiry: string;
  strike: number;
  optionType: string;
  qty: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
}

interface UnderlyingRiskGroup {
  underlying: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
  spot: number;
  perLeg: RiskLeg[];
}

interface GreeksRiskInfoBarProps {
  groups: UnderlyingRiskGroup[];
  selectedUnderlying?: string;
  vrp: VrpResult | null;
  accountNet: number | null;
}

// ── Helpers ──────────────────────────────────────────────────────────

type IvRegime = "low" | "neutral" | "high";

function fmtInr(v: number): string {
  return `₹${Math.abs(v).toLocaleString("en-IN", { maximumFractionDigits: 0 })}`;
}

function fmtSignedInr(v: number): string {
  return `${v >= 0 ? "+" : "-"}${fmtInr(v)}`;
}

function fmtPctNet(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio < 0.01 ? 2 : 1)}% net`;
}

function fmtThetaDays(days: number | null): string | undefined {
  if (days === null || !Number.isFinite(days)) return undefined;
  return `${days.toFixed(days < 10 ? 1 : 0)} theta-days`;
}

function thetaDaysToCover(loss: number | null, theta: number): number | null {
  if (loss === null || loss <= 0 || theta <= 0) return null;
  return loss / theta;
}

function joinParts(parts: Array<string | undefined | null>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" | ");
}

const LEVEL_DOT: Record<RiskLevel, string> = {
  safe: "bg-green-400",
  elevated: "bg-yellow-400",
  high: "bg-red-400",
};

const LEVEL_TEXT: Record<RiskLevel, string> = {
  safe: "text-green-400",
  elevated: "text-yellow-400",
  high: "text-red-400",
};

const LEVEL_BORDER: Record<RiskLevel, string> = {
  safe: "border-green-400/20",
  elevated: "border-yellow-400/20",
  high: "border-red-400/20",
};

const LEVEL_PRIORITY: Record<RiskLevel, number> = { safe: 0, elevated: 1, high: 2 };
const GREEK_NAMES = ["Delta", "Gamma", "Theta", "Vega", "Vanna", "Charm", "Vomma"] as const;
type GreekName = typeof GREEK_NAMES[number];
type GreekMetricKey = "delta" | "gamma" | "theta" | "vega" | "vanna" | "charm" | "vomma";

const GREEK_KEYS: Record<GreekName, GreekMetricKey> = {
  Delta: "delta",
  Gamma: "gamma",
  Theta: "theta",
  Vega: "vega",
  Vanna: "vanna",
  Charm: "charm",
  Vomma: "vomma",
};

function fmtSignedNumber(value: number, digits: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function fmtShortExpiry(expiry: string): string {
  return expiry ? expiry.slice(5) : "—";
}

function formatThresholdPct(
  accountNet: number | null,
  lowRatio: number,
  highRatio?: number,
): { ideal: string; moderate: string; high: string } | null {
  if (!accountNet || accountNet <= 0) return null;

  const lowAmount = accountNet * lowRatio;
  const highAmount = highRatio !== undefined ? accountNet * highRatio : null;

  return {
    ideal: `< ${fmtInr(lowAmount)} (${fmtPctNet(lowRatio)})`,
    moderate: highAmount !== null
      ? `${fmtInr(lowAmount)}-${fmtInr(highAmount)} (${fmtPctNet(lowRatio)}-${fmtPctNet(highRatio!)})`
      : `>= ${fmtInr(lowAmount)} (${fmtPctNet(lowRatio)})`,
    high: highAmount !== null
      ? `> ${fmtInr(highAmount)} (${fmtPctNet(highRatio!)})`
      : `> ${fmtInr(lowAmount)} (${fmtPctNet(lowRatio)})`,
  };
}

function buildCurrentValue(
  name: GreekName,
  group: UnderlyingRiskGroup,
  accountNet: number | null,
): string {
  const pctOfNet = (value: number | null, suffix = "") =>
    value !== null && accountNet && accountNet > 0
      ? `${fmtPctNet(Math.abs(value) / accountNet)}${suffix}`
      : undefined;

  switch (name) {
    case "Delta": {
      const pnl1Pct = group.spot > 0 ? Math.abs(group.delta * group.spot * 0.01) : null;
      const thetaDays = fmtThetaDays(thetaDaysToCover(pnl1Pct, group.theta));
      return joinParts([
        fmtSignedNumber(group.delta, 1),
        pnl1Pct !== null ? `${fmtInr(pnl1Pct)} / 1% move` : undefined,
        pctOfNet(pnl1Pct),
        thetaDays,
      ]);
    }
    case "Gamma": {
      const convexityPnl = group.spot > 0
        ? 0.5 * Math.abs(group.gamma) * group.spot * group.spot * 0.0001
        : null;
      const thetaDays = fmtThetaDays(thetaDaysToCover(convexityPnl, group.theta));
      return joinParts([
        fmtSignedNumber(group.gamma, 2),
        convexityPnl !== null ? `${fmtInr(convexityPnl)} convexity / 1% move` : undefined,
        pctOfNet(convexityPnl),
        thetaDays,
      ]);
    }
    case "Theta":
      return joinParts([
        `${fmtSignedInr(group.theta)}/day`,
        pctOfNet(Math.abs(group.theta), "/day"),
      ]);
    case "Vega":
      return joinParts([
        `${fmtSignedInr(group.vega)}/1% IV`,
        pctOfNet(Math.abs(group.vega)),
      ]);
    case "Vanna": {
      const phantomDelta = Math.abs(group.vanna * 2);
      const phantomPnl = group.spot > 0 ? phantomDelta * group.spot * 0.01 : null;
      return joinParts([
        fmtSignedNumber(group.vanna, 1),
        `phantom Δ ${phantomDelta.toFixed(1)} on 2% IV`,
        phantomPnl !== null ? `${fmtInr(phantomPnl)} / 1% move` : undefined,
        pctOfNet(phantomPnl),
      ]);
    }
    case "Charm": {
      const weekendDrift = group.charm * 3;
      const driftPnl = group.spot > 0 ? Math.abs(group.charm) * group.spot * 0.01 : null;
      return joinParts([
        fmtSignedNumber(group.charm, 2),
        `3d Δ drift ${weekendDrift >= 0 ? "+" : ""}${weekendDrift.toFixed(2)}`,
        driftPnl !== null ? `${fmtInr(driftPnl)} / day on 1% move` : undefined,
        pctOfNet(driftPnl, "/day"),
      ]);
    }
    case "Vomma": {
      const vegaShift5PctIv = Math.abs(group.vomma * 5);
      return joinParts([
        fmtSignedNumber(group.vomma, 2),
        `ν shift ${vegaShift5PctIv.toFixed(1)} on 5% IV`,
        pctOfNet(vegaShift5PctIv),
      ]);
    }
  }
}

function formatDriverValue(name: GreekName, value: number): string {
  switch (name) {
    case "Delta":
    case "Vanna":
      return `(${fmtSignedNumber(value, 1)})`;
    case "Gamma":
    case "Charm":
    case "Vomma":
      return `(${fmtSignedNumber(value, 2)})`;
    case "Theta":
      return `(${fmtSignedInr(value)}/day)`;
    case "Vega":
      return `(${fmtSignedInr(value)}/1% IV)`;
  }
}

function findDriver(name: GreekName, legs: RiskLeg[]): string {
  const key = GREEK_KEYS[name];
  const driver = legs.reduce<RiskLeg | null>((best, leg) => {
    if (!best) return leg;
    return Math.abs(leg[key]) > Math.abs(best[key]) ? leg : best;
  }, null);

  if (!driver || Math.abs(driver[key]) < 1e-6) {
    return "No dominant leg";
  }

  const side = driver.qty >= 0 ? "Long" : "Short";
  return `${side} ${Math.abs(driver.qty)} ${driver.strike} ${driver.optionType} ${fmtShortExpiry(driver.expiry)} ${formatDriverValue(name, driver[key])}`;
}

function buildLegend(
  name: GreekName,
  group: UnderlyingRiskGroup,
  minDte: number,
  ivRank: number | null,
  accountNet: number | null,
): Pick<GreekAssessment, "idealRange" | "moderateRange" | "highRange"> {
  switch (name) {
    case "Delta": {
      const budget = formatThresholdPct(accountNet, 0.0025, 0.01);
      if (budget) {
        return {
          idealRange: `1% move P&L ${budget.ideal}`,
          moderateRange: `1% move P&L ${budget.moderate}`,
          highRange: `1% move P&L ${budget.high}`,
        };
      }
      return {
        idealRange: "|Δ| < 5",
        moderateRange: "|Δ| 5-20",
        highRange: "|Δ| > 20",
      };
    }
    case "Gamma":
      if (accountNet && accountNet > 0 && group.spot > 0) {
        const budget = formatThresholdPct(accountNet, 0.001, 0.005);
        return {
          idealRange: `1% convexity P&L ${budget?.ideal}; long γ or > 7 DTE`,
          moderateRange: `1% convexity P&L ${budget?.moderate}; short γ with 3-7 DTE`,
          highRange: `1% convexity P&L ${budget?.high}; short γ with < 3 DTE`,
        };
      }
      return {
        idealRange: "γ >= 0 or short γ with > 7 DTE",
        moderateRange: "short γ with 3-7 DTE",
        highRange: "short γ with < 3 DTE or 1σ delta flip risk",
      };
    case "Theta": {
      const budget = formatThresholdPct(accountNet, 0.0005, 0.002);
      const ratio = Math.abs(group.vega) < 10 ? null : Math.abs(group.theta) / Math.abs(group.vega);
      if (budget) {
        return {
          idealRange: `Daily theta ${budget.ideal}${ratio !== null ? " and |θ/ν| < 0.5" : ""}`,
          moderateRange: `Daily theta ${budget.moderate}${ratio !== null ? " or |θ/ν| 0.5-1.5" : ""}`,
          highRange: `Daily theta ${budget.high}${ratio !== null ? " or |θ/ν| > 1.5" : ""}`,
        };
      }
      return {
        idealRange: ratio === null ? "|θ| < ₹100/day" : "|θ/ν| < 0.5",
        moderateRange: ratio === null ? "|θ| ₹100-₹500/day" : "|θ/ν| 0.5-1.5",
        highRange: ratio === null ? "|θ| > ₹500/day" : "|θ/ν| > 1.5",
      };
    }
    case "Vega": {
      const budget = formatThresholdPct(accountNet, 0.001, 0.005);
      if (budget) {
        return {
          idealRange: `1% IV P&L ${budget.ideal}`,
          moderateRange: `1% IV P&L ${budget.moderate}`,
          highRange: ivRank !== null && ivRank < 30
            ? `1% IV P&L ${budget.high}; short vol with IV Rank < 30%`
            : `1% IV P&L ${budget.high}`,
        };
      }
      return {
        idealRange: "|ν| < ₹50 / 1% IV",
        moderateRange: "|ν| ₹50-₹200 / 1% IV",
        highRange: ivRank !== null && ivRank < 30
          ? "|ν| > ₹200 or short vol with IV Rank < 30%"
          : "|ν| > ₹200 / 1% IV",
      };
    }
    case "Vanna":
      if (accountNet && accountNet > 0 && group.spot > 0) {
        const budget = formatThresholdPct(accountNet, 0.001, 0.005);
        if (budget) {
          return {
            idealRange: `2% IV shock phantom-delta risk ${budget.ideal}`,
            moderateRange: `2% IV shock phantom-delta risk ${budget.moderate}`,
            highRange: `2% IV shock phantom-delta risk ${budget.high}`,
          };
        }
      }
      return {
        idealRange: "|Vanna| < 2",
        moderateRange: "|Vanna| 2-8",
        highRange: "|Vanna| > 8",
      };
    case "Charm": {
      const budget = formatThresholdPct(accountNet, 0.0005, 0.002);
      const ratio = Math.abs(group.delta) > 1 ? Math.abs(group.charm) / Math.abs(group.delta) : 0;
      if (budget) {
        return {
          idealRange: `Daily 1% move-P&L drift ${budget.ideal}`,
          moderateRange: `Daily drift ${budget.moderate} or < 5% of delta/day`,
          highRange: `Daily drift ${budget.high} and > 5% of delta/day`,
        };
      }
      return {
        idealRange: "|Charm| < 0.05/day",
        moderateRange: ratio < 0.05 ? "|Charm| 0.05-0.20/day" : "0.05-0.20/day or < 5% of delta/day",
        highRange: "|Charm| > 0.20/day and > 5% of delta/day",
      };
    }
    case "Vomma":
      if (accountNet && accountNet > 0) {
        const budget = formatThresholdPct(accountNet, 0.001, 0.005);
        if (budget) {
          return {
            idealRange: `5% IV shock vega-shift ${budget.ideal}`,
            moderateRange: `5% IV shock vega-shift ${budget.moderate}`,
            highRange: `5% IV shock vega-shift ${budget.high}, especially negative`,
          };
        }
      }
      return {
        idealRange: "|Vomma| < 0.5",
        moderateRange: "|Vomma| 0.5-2.0",
        highRange: "|Vomma| > 2.0, especially negative",
      };
  }
}

function inferProfile(group: UnderlyingRiskGroup): ProfileSummary {
  const directionalPnl1Pct = group.spot > 0 ? Math.abs(group.delta * group.spot * 0.01) : null;
  const thetaDays = thetaDaysToCover(directionalPnl1Pct, group.theta);
  const nearNeutral = Math.abs(group.delta) < 12 || (thetaDays !== null && thetaDays <= 5);

  if (group.theta > 0 && nearNeutral) {
    return {
      label: "Non-directional theta carry",
      detail: thetaDays !== null
        ? `A 1% adverse move costs about ${fmtInr(directionalPnl1Pct ?? 0)}, roughly ${thetaDays.toFixed(thetaDays < 10 ? 1 : 0)} days of theta carry. Real risk sits more in gamma, vega, charm, and front-expiry concentration than in outright direction.`
        : "Book is primarily harvesting time decay with limited directional bias. Real risk sits more in gamma, vega, charm, and front-expiry concentration than in outright direction.",
    };
  }

  if (group.gamma > 0 && group.theta <= 0) {
    return {
      label: "Long convexity / optionality",
      detail: "Book is paying theta for convexity. The main question is whether realized movement justifies the carry you are paying.",
    };
  }

  if (Math.abs(group.delta) >= 12) {
    return {
      label: "Directional exposure",
      detail: "Spot movement is the primary near-term P&L driver. Carry matters, but it is not the main risk anchor for this book.",
    };
  }

  return {
    label: "Mixed exposure",
    detail: "Book is not strongly directional, but carry is not dominant enough to ignore the cross-risks. Read delta, gamma, vega, and expiry together.",
  };
}

// ── Assessment Functions ─────────────────────────────────────────────

function assessDelta(delta: number, spot: number, theta: number): GreekAssessment {
  const abs = Math.abs(delta);
  const dollarDelta = spot > 0 ? Math.abs(delta * spot * 0.01) : 0;
  const dollarMetric = spot > 0
    ? `${fmtInr(dollarDelta)} P&L per 1% spot move`
    : undefined;
  const thetaDays = thetaDaysToCover(dollarDelta || null, theta);
  const thetaContext = fmtThetaDays(thetaDays);

  if (abs < 5) {
    return {
      level: "safe",
      label: theta > 0 ? "Near-neutral carry" : "Near neutral",
      detail: theta > 0
        ? `Directional exposure is small relative to the theta carry.${thetaContext ? ` A 1% adverse move costs about ${thetaContext}.` : ""}`
        : "Portfolio delta is close to zero — minimal directional exposure. P&L is driven primarily by gamma, theta, and vega rather than spot direction.",
      dollarMetric,
      context: thetaContext,
    };
  }
  if (theta > 0 && thetaDays !== null && thetaDays <= 3) {
    return {
      level: "safe",
      label: "Managed directional drift",
      detail: `Net delta is present, but a 1% adverse move costs about ${fmtInr(dollarDelta)}, roughly ${thetaContext}. This still behaves more like a carry book than a directional punt.`,
      dollarMetric,
      context: thetaContext,
    };
  }
  if (abs < 20) {
    return {
      level: theta > 0 && thetaDays !== null && thetaDays <= 7 ? "safe" : "elevated",
      label: theta > 0 ? "Carry with directional lean" : "Directionally exposed",
      detail: theta > 0 && thetaContext
        ? `Net delta of ${delta > 0 ? "+" : ""}${delta.toFixed(1)} adds directional lean, but the main question is whether spot can move fast enough to erase ${thetaContext}.`
        : `Net delta of ${delta > 0 ? "+" : ""}${delta.toFixed(1)} means the portfolio profits from ${delta > 0 ? "up" : "down"}-moves and loses on ${delta > 0 ? "down" : "up"}-moves. Consider hedging if unintentional.`,
      dollarMetric,
      context: thetaContext,
    };
  }
  return {
    level: theta > 0 && thetaDays !== null && thetaDays <= 7 ? "elevated" : "high",
    label: theta > 0 ? "Direction overrides carry" : "Large directional bet",
    detail: theta > 0 && thetaContext
      ? `Net delta of ${delta > 0 ? "+" : ""}${delta.toFixed(1)} is large enough that carry no longer defines the book. A 1% adverse move costs ~${fmtInr(dollarDelta)}, about ${thetaContext}.`
      : `Net delta of ${delta > 0 ? "+" : ""}${delta.toFixed(1)} is a significant directional position. A 1% adverse spot move costs ~${fmtInr(dollarDelta)}.`,
    dollarMetric,
    context: thetaContext,
  };
}

function assessGamma(gamma: number, minDte: number, spot: number, theta: number): GreekAssessment {
  const dollarGamma = spot > 0
    ? 0.5 * Math.abs(gamma) * spot * spot * 0.0001
    : 0;
  const dollarMetric = spot > 0
    ? `${fmtInr(dollarGamma)} convexity P&L per 1% move`
    : undefined;
  const thetaContext = fmtThetaDays(thetaDaysToCover(dollarGamma || null, theta));
  const dteContext = joinParts([
    minDte < Infinity ? `Nearest expiry: ${minDte}d` : undefined,
    thetaContext ? `1% move can erase ${thetaContext}` : undefined,
  ]) || undefined;

  // Long gamma is always advantageous (convexity benefit)
  if (gamma >= 0) {
    return {
      level: "safe",
      label: "Long gamma",
      detail: "Positive gamma means delta moves in your favor on large spot moves (convexity advantage). You benefit from realized volatility exceeding implied.",
      dollarMetric,
      context: dteContext,
    };
  }

  // Short gamma — risk depends on DTE
  if (minDte > 7) {
    return {
      level: "safe",
      label: "Short gamma, DTE > 7",
      detail: "Short gamma with comfortable time to expiry. Gamma risk is manageable — delta won't change rapidly. Monitor as expiry approaches.",
      dollarMetric,
      context: dteContext,
    };
  }
  if (minDte >= 3) {
    return {
      level: "elevated",
      label: "Short gamma, DTE tightening",
      detail: `Short gamma with ${minDte} days to expiry. Gamma accelerates as expiry nears — delta can shift significantly on moderate spot moves. Consider reducing near-expiry short positions.`,
      dollarMetric,
      context: dteContext,
    };
  }
  return {
    level: "high",
    label: "Short gamma near expiry",
    detail: `Short gamma with only ${minDte}d to expiry — gamma explosion zone. Small spot moves cause large delta swings. ATM options have extreme gamma, making P&L highly nonlinear and hard to hedge.`,
    dollarMetric,
    context: dteContext,
  };
}

function assessTheta(theta: number, vega: number, delta: number, spot: number): GreekAssessment {
  const absTheta = Math.abs(theta);
  const absVega = Math.abs(vega);
  const direction = theta >= 0 ? "collecting" : "paying";
  const directionalPnl1Pct = spot > 0 ? Math.abs(delta * spot * 0.01) : null;
  const thetaDays = theta > 0 ? thetaDaysToCover(directionalPnl1Pct, theta) : null;
  const moveContext = thetaDays !== null ? `1% adverse move ~= ${fmtThetaDays(thetaDays)}` : undefined;

  // When vega is near zero, use absolute thresholds
  if (absVega < 10) {
    if (absTheta < 100) {
      return {
        level: "safe",
        label: theta >= 0 ? "Light theta carry" : "Modest time cost",
        detail: theta >= 0
          ? `Earning ~${fmtInr(absTheta)}/day from time decay. Low vega exposure means theta is the dominant P&L driver.`
          : `Paying ~${fmtInr(absTheta)}/day in time decay. Position will lose value if held without a move.`,
        context: moveContext,
      };
    }
    return {
      level: theta >= 0 ? (absTheta < 500 ? "safe" : "elevated") : absTheta < 500 ? "elevated" : "high",
      label: theta >= 0 ? "Strong theta carry" : "Large time cost",
      detail: `${direction === "collecting" ? "Earning" : "Paying"} ~${fmtInr(absTheta)}/day. With near-zero vega, this is a pure time-decay bet.`,
      context: moveContext,
    };
  }

  // Theta/Vega ratio — measures premium earned per unit of vol risk
  const ratio = absTheta / absVega;

  if (ratio < 0.5) {
    return {
      level: "safe",
      label: theta >= 0 ? "Balanced theta carry" : "Modest time cost",
      detail: `${direction === "collecting" ? "Earning" : "Paying"} ~${fmtInr(absTheta)}/day with θ/ν ratio of ${ratio.toFixed(2)}. Time decay is proportionate to volatility exposure.`,
      context: joinParts([
        `θ/ν ratio: ${ratio.toFixed(2)}`,
        moveContext,
      ]),
    };
  }
  if (ratio < 1.5) {
    return {
      level: theta >= 0 ? "safe" : "elevated",
      label: theta >= 0 ? "Strong theta carry" : "Significant time cost",
      detail: `${direction === "collecting" ? "Earning" : "Paying"} ~${fmtInr(absTheta)}/day with θ/ν ratio of ${ratio.toFixed(2)}. A moderate IV move can offset multiple days of theta.`,
      context: joinParts([
        `θ/ν ratio: ${ratio.toFixed(2)}`,
        moveContext,
      ]),
    };
  }
  return {
    level: theta >= 0 ? "elevated" : "high",
    label: theta >= 0 ? "Aggressive theta carry" : "Excessive time cost",
    detail: `${direction === "collecting" ? "Earning" : "Paying"} ~${fmtInr(absTheta)}/day but θ/ν ratio is ${ratio.toFixed(2)} — time decay is large relative to vol exposure. A single IV spike can wipe out many days of theta earned.`,
    context: joinParts([
      `θ/ν ratio: ${ratio.toFixed(2)}`,
      moveContext,
    ]),
  };
}

function assessVega(vega: number, ivRegime: IvRegime, ivRank: number | null): GreekAssessment {
  const absVega = Math.abs(vega);
  const isShort = vega < 0;
  const ivContext = ivRank !== null ? `IV Rank: ${ivRank.toFixed(0)}%` : "IV Rank: —";

  // Small vega — not much vol exposure either way
  if (absVega < 50) {
    return {
      level: "safe",
      label: "Low vol exposure",
      detail: "Portfolio has minimal sensitivity to implied volatility changes. IV moves won't materially impact P&L.",
      context: ivContext,
    };
  }

  // IV-regime-adaptive logic
  if (isShort) {
    if (ivRegime === "high") {
      return {
        level: absVega > 200 ? "elevated" : "safe",
        label: "Short vega, high IV",
        detail: `Short vega in a high-IV regime (IV rank ${ivRank?.toFixed(0) ?? "—"}%). Historically, elevated IV tends to mean-revert — short vega is statistically favorable here. ${absVega > 200 ? "However, absolute exposure is large." : ""}`,
        dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
        context: ivContext,
      };
    }
    if (ivRegime === "low") {
      return {
        level: "high",
        label: "Short vega at low IV",
        detail: `Selling volatility when IV rank is only ${ivRank?.toFixed(0) ?? "—"}%. Cheap vol can get cheaper, but the risk/reward is unfavorable — limited premium collected with unlimited upside risk on vol.`,
        dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
        context: ivContext,
      };
    }
    // Neutral regime
    return {
      level: absVega > 200 ? "elevated" : "elevated",
      label: "Short vega, neutral IV",
      detail: `Short vega with IV in neutral territory. No strong statistical edge — monitor for regime changes.`,
      dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
      context: ivContext,
    };
  }

  // Long vega
  if (ivRegime === "low") {
    return {
      level: absVega > 200 ? "elevated" : "safe",
      label: "Long vega, low IV",
      detail: `Long volatility at low IV rank (${ivRank?.toFixed(0) ?? "—"}%). Buying vol when it's historically cheap — favorable entry point. ${absVega > 200 ? "Absolute exposure is significant." : ""}`,
      dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
      context: ivContext,
    };
  }
  if (ivRegime === "high") {
    return {
      level: "high",
      label: "Long vega at high IV",
      detail: `Buying volatility when IV rank is ${ivRank?.toFixed(0) ?? "—"}%. Expensive vol tends to mean-revert — long vega here has unfavorable risk/reward unless expecting a specific catalyst.`,
      dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
      context: ivContext,
    };
  }
  return {
    level: "elevated",
    label: "Long vega, neutral IV",
    detail: `Long vega with IV in neutral territory. No strong statistical edge — position needs a vol catalyst to profit.`,
    dollarMetric: `${fmtInr(absVega)} P&L per 1% IV move`,
    context: ivContext,
  };
}

function assessVanna(vanna: number): GreekAssessment {
  const abs = Math.abs(vanna);
  const phantomDelta = Math.abs(vanna * 2); // Typical 2% daily IV move

  if (abs < 2) {
    return {
      level: "safe",
      label: "Minimal cross-risk",
      detail: "Vanna exposure is negligible — delta won't shift meaningfully when IV changes. Spot and vol risks are effectively independent.",
      context: `Phantom Δ: ${phantomDelta.toFixed(1)} on 2% IV move`,
    };
  }
  if (abs < 8) {
    return {
      level: "elevated",
      label: "Moderate phantom delta",
      detail: `Vanna of ${vanna > 0 ? "+" : ""}${vanna.toFixed(1)} creates a "phantom delta" — on a 2% IV shock, your effective delta shifts by ~${phantomDelta.toFixed(1)}. This spot-vol cross-risk compounds during market stress when both spot and IV move together.`,
      context: `Phantom Δ: ${phantomDelta.toFixed(1)} on 2% IV move`,
    };
  }
  return {
    level: "high",
    label: "Large phantom delta",
    detail: `High vanna of ${vanna > 0 ? "+" : ""}${vanna.toFixed(1)} means a 2% IV move shifts your effective delta by ~${phantomDelta.toFixed(1)}. In a market crash (spot down + IV up), your position's directionality can flip unexpectedly.`,
    context: `Phantom Δ: ${phantomDelta.toFixed(1)} on 2% IV move`,
  };
}

function assessCharm(charm: number, delta: number): GreekAssessment {
  const abs = Math.abs(charm);
  const absDelta = Math.abs(delta);
  // Charm is meaningful relative to current delta — a charm of 0.5 on delta=50 is different than on delta=2
  const ratio = absDelta > 1 ? abs / absDelta : 0;

  if (abs < 0.05) {
    return {
      level: "safe",
      label: "Stable delta",
      detail: "Delta is barely changing with time. Overnight risk from delta drift is negligible — your directional exposure will be the same tomorrow.",
      context: `Δ drift: ${charm > 0 ? "+" : ""}${charm.toFixed(3)}/day`,
    };
  }
  if (abs < 0.2 || ratio < 0.05) {
    return {
      level: "elevated",
      label: "Moderate delta drift",
      detail: `Delta shifts by ${charm > 0 ? "+" : ""}${charm.toFixed(3)} per day. Over a weekend (3 days), delta changes by ~${(charm * 3).toFixed(2)}. Monitor if holding positions over non-trading periods.`,
      context: `Δ drift: ${charm > 0 ? "+" : ""}${charm.toFixed(3)}/day`,
    };
  }
  return {
    level: "high",
    label: "Significant delta decay",
    detail: `Delta drifts by ${charm > 0 ? "+" : ""}${charm.toFixed(3)} per day — ${(ratio * 100).toFixed(1)}% of current delta. Your directional exposure is changing rapidly just from time passing. Critical for weekend/holiday risk.`,
    context: `Δ drift: ${charm > 0 ? "+" : ""}${charm.toFixed(3)}/day (${(ratio * 100).toFixed(1)}% of Δ)`,
  };
}

function assessVomma(vomma: number, vega: number): GreekAssessment {
  const abs = Math.abs(vomma);
  const absVega = Math.abs(vega);
  // Vomma relative to vega tells us about convexity — is vega accelerating or decelerating?
  const ratio = absVega > 1 ? abs / absVega : 0;

  if (abs < 0.5) {
    return {
      level: "safe",
      label: "Flat vega profile",
      detail: "Vega is essentially linear — it doesn't change much as IV moves. Your vol exposure is predictable across different IV levels.",
      context: `ν shift: ${vomma > 0 ? "+" : ""}${vomma.toFixed(2)} per 1% IV`,
    };
  }
  if (abs < 2 || ratio < 0.1) {
    return {
      level: "elevated",
      label: vomma > 0 ? "Long vol convexity" : "Short vol convexity",
      detail: vomma > 0
        ? `Positive vomma (${vomma.toFixed(2)}) — vega increases as IV rises. You benefit from vol acceleration: the further IV moves, the more you gain per additional 1% IV. Favorable in tail events.`
        : `Negative vomma (${vomma.toFixed(2)}) — vega increases against you as IV rises. Your vol exposure worsens in a spike. Consider whether you have enough vega cushion.`,
      context: `ν shift: ${vomma > 0 ? "+" : ""}${vomma.toFixed(2)} per 1% IV`,
    };
  }
  return {
    level: "high",
    label: vomma > 0 ? "Strong vol convexity" : "Dangerous vol concavity",
    detail: vomma > 0
      ? `Large positive vomma (${vomma.toFixed(2)}) — strong vega convexity. You're heavily positioned to benefit from vol-of-vol. Typically seen in far OTM or long-dated positions.`
      : `Large negative vomma (${vomma.toFixed(2)}) — vega accelerates against you in a vol spike. A 5% IV move changes your vega by ~${(Math.abs(vomma) * 5).toFixed(1)}. This amplifies losses in vol events.`,
    context: `ν shift: ${vomma > 0 ? "+" : ""}${vomma.toFixed(2)} per 1% IV`,
  };
}

// ── Educational descriptions ─────────────────────────────────────────

const GREEK_DESCRIPTIONS: Record<string, string> = {
  Delta: "1st order — measures P&L sensitivity to underlying price. Delta of +10 means the portfolio behaves like holding 10 shares of the underlying.",
  Gamma: "2nd order — measures how fast delta changes. Short gamma near expiry is the most dangerous options risk (gamma explosion). Not tracked: Speed (∂Γ/∂S), Color (∂Γ/∂t).",
  Theta: "1st order — daily time decay in rupees. Positive = earning premium, negative = paying for optionality.",
  Vega: "1st order — P&L impact per 1% implied volatility change. Risk depends on IV regime: selling vol when IV is high is statistically favorable.",
  Vanna: "2nd order — cross-derivative (∂Δ/∂σ). Creates 'phantom delta' during vol shocks: your directional exposure shifts when IV moves. Critical during market stress where spot and IV move together.",
  Charm: "Exotic — ∂Δ/∂t (delta decay). Measures how your delta drifts purely from time passing. Critical for overnight and weekend risk — you can wake up with a very different directional profile.",
  Vomma: "Exotic — ∂²V/∂σ² (vega convexity / Volga). Measures how vega itself changes with IV. Positive vomma = you benefit from vol-of-vol. Negative = vol spikes hurt more than expected.",
};

function buildAssessments(
  group: UnderlyingRiskGroup,
  groupVrp: VrpResult | null,
  accountNet: number | null,
): {
  assessments: Record<GreekName, GreekAssessment>;
  minDte: number;
  ivRank: number | null;
  worstLevel: RiskLevel;
  topRisks: GreekName[];
  profile: ProfileSummary;
} {
  const dtes = group.perLeg
    .filter((leg) => leg.expiry)
    .map((leg) => daysToExpiryFor(group.underlying, leg.expiry));
  const minDte = dtes.length > 0 ? Math.min(...dtes) : Infinity;

  const ivRank = groupVrp?.ivRank ?? null;
  const ivRegime: IvRegime = ivRank === null
    ? "neutral"
    : ivRank > 70 ? "high"
    : ivRank < 30 ? "low"
    : "neutral";
  const profile = inferProfile(group);

  const assessments: Record<GreekName, GreekAssessment> = {
    Delta: assessDelta(group.delta, group.spot, group.theta),
    Gamma: assessGamma(group.gamma, minDte, group.spot, group.theta),
    Theta: assessTheta(group.theta, group.vega, group.delta, group.spot),
    Vega: assessVega(group.vega, ivRegime, ivRank),
    Vanna: assessVanna(group.vanna),
    Charm: assessCharm(group.charm, group.delta),
    Vomma: assessVomma(group.vomma, group.vega),
  };

  for (const name of GREEK_NAMES) {
    Object.assign(assessments[name], {
      currentValue: buildCurrentValue(name, group, accountNet),
      driver: findDriver(name, group.perLeg),
      ...buildLegend(name, group, minDte, ivRank, accountNet),
    });
  }

  let worstLevel: RiskLevel = "safe";
  for (const assessment of Object.values(assessments)) {
    if (LEVEL_PRIORITY[assessment.level] > LEVEL_PRIORITY[worstLevel]) {
      worstLevel = assessment.level;
    }
  }

  const topRisks = GREEK_NAMES
    .filter((name) => assessments[name].level !== "safe")
    .sort((a, b) => LEVEL_PRIORITY[assessments[b].level] - LEVEL_PRIORITY[assessments[a].level])
    .slice(0, 3);

  return { assessments, minDte, ivRank, worstLevel, topRisks, profile };
}

// ── Component ────────────────────────────────────────────────────────

export function GreeksRiskInfoBar({
  groups, selectedUnderlying, vrp, accountNet,
}: GreeksRiskInfoBarProps) {
  const [expanded, setExpanded] = useState(false);

  const groupResults = useMemo(() => (
    groups.map((group) => ({
        group,
        ...buildAssessments(
          group,
          vrp && group.underlying === selectedUnderlying ? vrp : null,
          accountNet,
        ),
      }))
  ), [groups, selectedUnderlying, vrp, accountNet]);

  const worstLevel = useMemo(() => {
    let worst: RiskLevel = "safe";
    for (const result of groupResults) {
      if (LEVEL_PRIORITY[result.worstLevel] > LEVEL_PRIORITY[worst]) {
        worst = result.worstLevel;
      }
    }
    return worst;
  }, [groupResults]);

  const singleGroup = groupResults[0] ?? null;
  const isMultiUnderlying = groupResults.length > 1;

  return (
    <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
      {/* ── Collapsed header row ── */}
      <button
        onClick={() => setExpanded((p) => !p)}
        className="flex w-full items-center gap-4 text-left"
      >
        <div className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-full ${LEVEL_DOT[worstLevel]}`} />
          <span className="text-[11px] font-semibold uppercase tracking-wider text-[#c0c0d0]">
            Risk
          </span>
        </div>

        <div className="flex flex-1 items-center gap-4 overflow-hidden">
          {isMultiUnderlying
            ? groupResults.map((result) => (
              <div
                key={result.group.underlying}
                className="flex items-center gap-1.5 whitespace-nowrap"
                title={`${result.group.underlying}: ${result.topRisks.map((name) => `${name} ${result.assessments[name].label}`).join(" • ") || "No elevated flags"}`}
              >
                <span className={`inline-block h-2 w-2 rounded-full ${LEVEL_DOT[result.worstLevel]}`} />
                <span className="text-xs font-medium text-[#c0c0d0]">{result.group.underlying}:</span>
                <span className={`text-xs ${LEVEL_TEXT[result.worstLevel]}`}>
                  {result.topRisks.length > 0
                    ? result.topRisks.map((name) => `${name} ${result.assessments[name].currentValue}`).join(", ")
                    : "Balanced"}
                </span>
              </div>
            ))
            : singleGroup && GREEK_NAMES.map((name) => {
              const assessment = singleGroup.assessments[name];
              return (
                <div key={name} className="flex items-center gap-1.5 whitespace-nowrap" title={assessment.detail}>
                  <span className={`inline-block h-2 w-2 rounded-full ${LEVEL_DOT[assessment.level]}`} />
                  <span className="text-xs font-medium text-[#c0c0d0]">{name}:</span>
                  <span className={`text-xs ${LEVEL_TEXT[assessment.level]}`}>
                    {assessment.label} {assessment.currentValue ? `(${assessment.currentValue})` : ""}
                  </span>
                </div>
              );
            })}
        </div>

        {expanded
          ? <ChevronDown className="h-4 w-4 shrink-0 text-[#c0c0d0]" />
          : <ChevronRight className="h-4 w-4 shrink-0 text-[#c0c0d0]" />}
      </button>

      {/* ── Expanded detail cards ── */}
      {expanded && (
        isMultiUnderlying ? (
          <div className="mt-2.5 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
            {groupResults.map((result) => (
              <div
                key={result.group.underlying}
                className={`flex flex-col gap-2 rounded border ${LEVEL_BORDER[result.worstLevel]} bg-[#0f0f23] px-3 py-2.5`}
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <span className={`inline-block h-2.5 w-2.5 rounded-full ${LEVEL_DOT[result.worstLevel]}`} />
                    <span className="text-sm font-semibold text-[#e0e0f0]">{result.group.underlying}</span>
                  </div>
                  <span className={`text-[11px] font-semibold uppercase tracking-wider ${LEVEL_TEXT[result.worstLevel]}`}>
                    {result.worstLevel}
                  </span>
                </div>

                <div className="text-[11px] text-[#a0a0b0]">
                  {result.group.spot > 0
                    ? `Spot ${result.group.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
                    : "Spot unavailable"}
                  {Number.isFinite(result.minDte) ? ` • Nearest expiry ${result.minDte}d` : ""}
                  {result.ivRank !== null ? ` • IV Rank ${result.ivRank.toFixed(0)}%` : ""}
                </div>

                <div className="rounded border border-[#2a2a4a] bg-[#13132a] px-2 py-1.5">
                  <div className="text-[11px] font-semibold text-[#d8d8e8]">
                    Profile: {result.profile.label}
                  </div>
                  <div className="mt-1 text-[11px] leading-snug text-[#aeb0c2]">
                    {result.profile.detail}
                  </div>
                </div>

                <div className="grid grid-cols-3 gap-1 text-[11px] text-[#c0c0d0]">
                  <span>Δ {result.group.delta >= 0 ? "+" : ""}{result.group.delta.toFixed(1)}</span>
                  <span>Θ {fmtSignedInr(result.group.theta)}/d</span>
                  <span>ν {fmtSignedInr(result.group.vega)}/1%</span>
                </div>

                {result.topRisks.length > 0 ? (
                  <div className="flex flex-col gap-1.5">
                    {result.topRisks.map((name) => {
                      const assessment = result.assessments[name];
                      return (
                        <div key={name} className="rounded border border-[#2a2a4a] bg-[#13132a] px-2 py-1.5">
                          <div className="flex items-center gap-1.5">
                            <span className={`inline-block h-2 w-2 rounded-full ${LEVEL_DOT[assessment.level]}`} />
                            <span className="text-[11px] font-semibold text-[#d8d8e8]">{name}</span>
                            <span className={`text-[11px] ${LEVEL_TEXT[assessment.level]}`}>{assessment.label}</span>
                          </div>
                          {assessment.currentValue && (
                            <div className="mt-1 text-[11px] text-[#d8d8e8]">
                              Current: <span className="font-medium">{assessment.currentValue}</span>
                            </div>
                          )}
                          {assessment.driver && (
                            <div className="mt-1 text-[11px] text-[#a0a0b0]">
                              Driver: {assessment.driver}
                            </div>
                          )}
                          {(assessment.idealRange || assessment.moderateRange || assessment.highRange) && (
                            <div className="mt-1 grid gap-1 text-[10px] leading-snug text-[#8f93aa]">
                              {assessment.idealRange && <div>Ideal: {assessment.idealRange}</div>}
                              {assessment.moderateRange && <div>Moderate: {assessment.moderateRange}</div>}
                              {assessment.highRange && <div>High: {assessment.highRange}</div>}
                            </div>
                          )}
                          <div className="mt-1 text-[11px] leading-snug text-[#aeb0c2]">
                            {assessment.detail}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div className="text-[11px] leading-snug text-[#aeb0c2]">
                    No elevated per-underlying flags. Aggregate portfolio Greek totals still appear below, but rupee risk should be read from per-underlying sections when the book spans multiple underlyings.
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="mt-2.5 grid grid-cols-7 gap-2">
            {singleGroup && GREEK_NAMES.map((name) => {
              const assessment = singleGroup.assessments[name];
              return (
                <div
                  key={name}
                  className={`flex flex-col gap-1.5 rounded border ${LEVEL_BORDER[assessment.level]} bg-[#0f0f23] px-2.5 py-2`}
                  title={GREEK_DESCRIPTIONS[name]}
                >
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-[#c0c0d0]">
                    {name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className={`inline-block h-2 w-2 rounded-full ${LEVEL_DOT[assessment.level]}`} />
                    <span className={`text-xs font-semibold ${LEVEL_TEXT[assessment.level]}`}>
                      {assessment.label}
                    </span>
                  </div>
                  <span className="text-[11px] text-[#9ba0b5]">
                    Profile: {singleGroup.profile.label}
                  </span>
                  {assessment.currentValue && (
                    <span className="text-[11px] font-medium text-[#d8d8e8]">
                      Current: {assessment.currentValue}
                    </span>
                  )}
                  {assessment.driver && (
                    <span className="text-[11px] leading-snug text-[#9ba0b5]">
                      Driver: {assessment.driver}
                    </span>
                  )}
                  {assessment.dollarMetric && (
                    <span className="text-[11px] text-[#d0d0e0]">{assessment.dollarMetric}</span>
                  )}
                  {assessment.context && (
                    <span className="text-[11px] font-medium text-[#a0a0b0]">{assessment.context}</span>
                  )}
                  {(assessment.idealRange || assessment.moderateRange || assessment.highRange) && (
                    <div className="grid gap-1 text-[10px] leading-snug text-[#8f93aa]">
                      {assessment.idealRange && <span>Ideal: {assessment.idealRange}</span>}
                      {assessment.moderateRange && <span>Moderate: {assessment.moderateRange}</span>}
                      {assessment.highRange && <span>High: {assessment.highRange}</span>}
                    </div>
                  )}
                  <span className="text-[11px] leading-snug text-[#b0b0c0]">{assessment.detail}</span>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}
