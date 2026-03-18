/**
 * Black-Scholes re-exports for mock data generation.
 * Core functions live in @/lib/black-scholes — this file re-exports
 * them and keeps mock-specific helpers (impliedVolSmile) local.
 */

import { BASE_IV, RISK_FREE_RATE } from "./constants";

export {
  normalPdf,
  normalCdf,
  bsPrice,
  bsDelta,
  bsGamma,
  bsTheta,
  bsVega,
  dteToYears,
  daysToExpiry,
} from "@/lib/black-scholes";

import { computeAllGreeks as _computeAllGreeks } from "@/lib/black-scholes";

/**
 * Wrapper that pins the risk-free rate to the mock constant.
 */
export function computeAllGreeks(
  S: number,
  K: number,
  T: number,
  sigma: number,
  type: "CE" | "PE",
) {
  return _computeAllGreeks(S, K, T, sigma, type, RISK_FREE_RATE);
}

/* ------------------------------------------------------------------ */
/*  Implied volatility smile (mock-specific, depends on BASE_IV)      */
/* ------------------------------------------------------------------ */

/**
 * Quadratic IV smile around ATM.
 * Returns IV for a given strike distance from ATM.
 * Smile is steeper on the put side (negative moneyness).
 */
export function impliedVolSmile(
  strike: number,
  atmPrice: number,
  baseIv: number = BASE_IV,
): number {
  const moneyness = (strike - atmPrice) / atmPrice;
  // Quadratic skew: steeper on downside
  const skew = 0.4 * moneyness * moneyness + 0.1 * moneyness;
  return Math.max(baseIv + skew, 0.05);
}
