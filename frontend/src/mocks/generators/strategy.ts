/**
 * Mock strategy analysis: computes payoff curve, breakevens, and margin
 * for a given set of legs.
 */

import type { StrategyLeg, StrategyResult } from "@/types/market-data";
import { ATM_PRICE, LOT_SIZE, STRIKE_STEP, STRIKES_EACH_SIDE } from "../seed/constants";

export function mockAnalyzeStrategy(legs: StrategyLeg[]): StrategyResult {
  // Build payoff curve
  const minStrike = ATM_PRICE - STRIKES_EACH_SIDE * STRIKE_STEP;
  const maxStrike = ATM_PRICE + STRIKES_EACH_SIDE * STRIKE_STEP;
  const step = STRIKE_STEP / 2; // finer resolution
  const payoffX: number[] = [];
  const payoffY: number[] = [];

  for (let price = minStrike; price <= maxStrike; price += step) {
    let pnl = 0;
    for (const leg of legs) {
      const multiplier = leg.side === "BUY" ? 1 : -1;
      const qty = leg.quantity;
      let intrinsic: number;

      if (leg.optionType === "CE") {
        intrinsic = Math.max(price - leg.strike, 0);
      } else {
        intrinsic = Math.max(leg.strike - price, 0);
      }

      pnl += multiplier * (intrinsic - leg.premium) * qty;
    }
    payoffX.push(price);
    payoffY.push(Math.round(pnl * 100) / 100);
  }

  // Compute net credit
  let netCredit = 0;
  for (const leg of legs) {
    netCredit += (leg.side === "SELL" ? 1 : -1) * leg.premium * leg.quantity;
  }

  // Find breakevens (zero crossings)
  const breakevenPoints: number[] = [];
  for (let i = 1; i < payoffY.length; i++) {
    if ((payoffY[i - 1] <= 0 && payoffY[i] > 0) || (payoffY[i - 1] >= 0 && payoffY[i] < 0)) {
      // Linear interpolation
      const x0 = payoffX[i - 1];
      const x1 = payoffX[i];
      const y0 = payoffY[i - 1];
      const y1 = payoffY[i];
      const bep = x0 - y0 * (x1 - x0) / (y1 - y0);
      breakevenPoints.push(Math.round(bep * 100) / 100);
    }
  }

  const maxProfit = Math.max(...payoffY);
  const maxLoss = Math.min(...payoffY);
  const profitBars = payoffY.filter((y) => y > 0).length;
  const probabilityOfProfit = payoffY.length > 0 ? profitBars / payoffY.length : 0;

  // Simple margin estimate: max loss * 1.5 or notional * 5%
  const notional = ATM_PRICE * LOT_SIZE;
  const initialMargin = Math.max(Math.abs(maxLoss) * 1.5, notional * 0.05);

  return {
    legs,
    netCredit: Math.round(netCredit * 100) / 100,
    maxProfit: Math.round(maxProfit * 100) / 100,
    maxLoss: Math.round(maxLoss * 100) / 100,
    breakevenPoints,
    probabilityOfProfit: Math.round(probabilityOfProfit * 10000) / 10000,
    margin: {
      initialMargin: Math.round(initialMargin),
      maintenanceMargin: Math.round(initialMargin * 0.75),
      collateralUtilization: Math.round((initialMargin / (notional * 0.15)) * 10000) / 10000,
    },
    payoffX,
    payoffY,
  };
}
