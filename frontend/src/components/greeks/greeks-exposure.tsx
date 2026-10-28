"use client";

import { useEffect, useMemo, useState } from "react";

import { fetchLimits } from "@/lib/api-client";
import { usePositionStore } from "@/stores/position-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";
import { modelGreeks, modelImpliedVol } from "@/lib/black-scholes";
import { isFuturesUnderlying, pricingModelOf, timeToExpiryYears, unitMultiplier } from "@/lib/instruments";
import type { Position } from "@/types/orders";
import { GreeksRiskInfoBar } from "./greeks-risk-info-bar";

const RISK_FREE_RATE = 0.065;

// ── Helpers ──────────────────────────────────────────────────────────

function signedQty(pos: Position): number {
  return pos.side === "SELL" ? -Math.abs(pos.quantity) : Math.abs(pos.quantity);
}

function fmt(v: number, d: number): string {
  const s = v >= 0 ? "+" : "";
  return `${s}${v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

function fmtInr(v: number): string {
  const s = v >= 0 ? "+" : "";
  return `${s}₹${v.toLocaleString("en-IN", { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function colorClass(v: number): string {
  return v > 0 ? "text-green-400" : v < 0 ? "text-red-400" : "text-[#808090]";
}

interface PortfolioLegGreeks {
  symbol: string;
  underlying: string;
  expiry: string;
  strike: number;
  optionType: string;
  qty: number;
  ltp: number;
  iv: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
}

interface UnderlyingGreeksSummary {
  underlying: string;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  vanna: number;
  charm: number;
  vomma: number;
  spot: number;
  perLeg: PortfolioLegGreeks[];
}

// ── Component ────────────────────────────────────────────────────────

export function GreeksExposure() {
  const positions = usePositionStore((s) => s.positions);
  const ticks = useMarketDataStore((s) => s.ticks);
  const tickVersion = useMarketDataStore((s) => s.tickVersion);
  const selectedUnderlying = useMarketDataStore((s) => s.selectedUnderlying);
  const feedMode = useMarketDataStore((s) => s.feedMode);
  const [accountNet, setAccountNet] = useState<number | null>(null);

  // Position Greeks — dedicated pipeline, persists across expiry switches (primary)
  const positionGreeksMap = useGreeksStore((s) => s.positionGreeks);
  useGreeksStore((s) => s.positionGreeksVersion);

  // Chain Greeks — overlap forwarding from current chain view (secondary)
  const greeksMap = useGreeksStore((s) => s.greeks);
  useGreeksStore((s) => s.greeksVersion);

  // VRP data for IV-regime-adaptive risk thresholds
  const vrp = useMarketDataStore((s) => s.vrp);

  // ── Aggregate portfolio Greeks ──
  // Priority: positionGreeks (server, position pipeline) > greeks (server, chain pipeline) > client BSM
  const portfolio = useMemo(() => {
    void tickVersion;
    let delta = 0, gamma = 0, theta = 0, vega = 0, vanna = 0, charm = 0, vomma = 0;
    const perLeg: PortfolioLegGreeks[] = [];
    const underlyingMap = new Map<string, UnderlyingGreeksSummary>();

    for (const pos of positions) {
      if ((pos as Record<string, unknown>).isOpen === false) continue;

      const strike = pos._strike ?? 0;
      const optType = pos._optionType;
      const expIso = pos._expiryIso;
      const underlying = pos._underlying ?? "UNKNOWN";

      if (strike <= 0 || !optType || !expIso) continue;

      const tick = ticks.get(pos.symbol);
      const ltp = tick?.ltp ?? 0;

      // ── Priority 1: Position Greeks from dedicated pipeline (server-computed, stable) ──
      const posG = positionGreeksMap.get(pos.symbol);

      // ── Priority 2: Chain Greeks from overlap forwarding ──
      const chainG = greeksMap.get(pos.symbol);

      const serverG = posG ?? chainG;

      let legIv: number;
      let legDelta: number;
      let legGamma: number;
      let legTheta: number;
      let legVega: number;
      let legVanna: number;
      let legCharm: number;
      let legVomma: number;
      let legSpot: number;

      if (serverG && serverG.delta !== 0) {
        // Use server Greeks directly — no client-side BSM needed
        legIv = serverG.iv;
        legDelta = serverG.delta;
        legGamma = serverG.gamma;
        legTheta = serverG.theta;
        legVega = serverG.vega;
        legVanna = serverG.vanna ?? 0;
        legCharm = serverG.charm ?? 0;
        legVomma = serverG.vomma ?? 0;
        legSpot = serverG.underlyingPrice ?? 0;
      } else {
        // ── Priority 3: Client-side BSM fallback (last resort) ──
        // Use spot from any available server Greeks for this underlying, or chain
        const chainSpot = useMarketDataStore.getState().optionChain?.underlying === underlying
          ? (useMarketDataStore.getState().optionChain?.underlyingPrice ?? 0)
          : 0;
        // Try to infer spot from another position's server Greeks for same underlying
        let inferredSpot = 0;
        for (const [, g] of positionGreeksMap) {
          if (g.underlying === underlying && g.underlyingPrice > 0) {
            inferredSpot = g.underlyingPrice;
            break;
          }
        }
        const spot = inferredSpot > 0 ? inferredSpot : chainSpot;
        if (spot <= 0) continue;

        // Same continuous T and model as the quant service (BSM on spot for
        // index options, Black-76 on the future for MCX)
        const T = timeToExpiryYears(underlying, expIso);
        const model = pricingModelOf(underlying);
        const price = ltp > 0 ? ltp : pos.avgPrice;
        if (price <= 0) continue;

        const iv = modelImpliedVol(model, price, spot, strike, T, RISK_FREE_RATE, optType);
        if (!iv || iv <= 0.001 || iv > 5) continue;

        const computed = modelGreeks(model, spot, strike, T, iv, optType, RISK_FREE_RATE);
        legIv = iv;
        legDelta = computed.delta;
        legGamma = computed.gamma;
        legTheta = computed.theta;
        legVega = computed.vega;
        legVanna = computed.vanna;
        legCharm = computed.charm;
        legVomma = computed.vomma;
        legSpot = spot;
      }

      const sq = signedQty(pos);
      // Scale by ₹ per unit qty per ₹1 price so greeks are rupee sensitivities
      // for every underlying (GOLD 100, GOLDM 0.1, NSE/BSE 1).
      const vq = sq * unitMultiplier(underlying);
      const posDelta = vq * legDelta;
      const posGamma = vq * legGamma;
      const posTheta = vq * legTheta;
      const posVega = vq * legVega;
      const posVanna = vq * legVanna;
      const posCharm = vq * legCharm;
      const posVomma = vq * legVomma;

      delta += posDelta;
      gamma += posGamma;
      theta += posTheta;
      vega += posVega;
      vanna += posVanna;
      charm += posCharm;
      vomma += posVomma;

      const legRecord = {
        symbol: pos.symbol,
        underlying,
        expiry: expIso,
        strike,
        optionType: optType,
        qty: sq,
        ltp,
        iv: legIv * 100,
        delta: posDelta,
        gamma: posGamma,
        theta: posTheta,
        vega: posVega,
        vanna: posVanna,
        charm: posCharm,
        vomma: posVomma,
      };
      perLeg.push(legRecord);

      const underlyingSummary = underlyingMap.get(underlying) ?? {
        underlying,
        delta: 0,
        gamma: 0,
        theta: 0,
        vega: 0,
        vanna: 0,
        charm: 0,
        vomma: 0,
        spot: legSpot,
        perLeg: [],
      };
      underlyingSummary.delta += posDelta;
      underlyingSummary.gamma += posGamma;
      underlyingSummary.theta += posTheta;
      underlyingSummary.vega += posVega;
      underlyingSummary.vanna += posVanna;
      underlyingSummary.charm += posCharm;
      underlyingSummary.vomma += posVomma;
      if (underlyingSummary.spot <= 0 && legSpot > 0) {
        underlyingSummary.spot = legSpot;
      }
      underlyingSummary.perLeg.push(legRecord);
      underlyingMap.set(underlying, underlyingSummary);
    }

    const byUnderlying = [...underlyingMap.values()]
      .sort((a, b) => a.underlying.localeCompare(b.underlying));

    return {
      delta,
      gamma,
      theta,
      vega,
      vanna,
      charm,
      vomma,
      perLeg,
      byUnderlying,
      spot: byUnderlying.length === 1 ? byUnderlying[0].spot : 0,
    };
  }, [positions, ticks, tickVersion, positionGreeksMap, greeksMap]);

  // ── Scenario analysis ──
  const scenarioGroups = useMemo(() => {
    const spotMoves = [-3, -2, -1, 1, 2, 3];

    return portfolio.byUnderlying.map((group) => ({
      underlying: group.underlying,
      spot: group.spot,
      scenarios: spotMoves.map((pct) => {
        const dSpot = group.spot * (pct / 100);
        // Equity-index skew heuristic; commodity spot-vol correlation differs
        // (often flat or positive), so MCX scenarios hold IV unchanged.
        const dIv = isFuturesUnderlying(group.underlying)
          ? 0
          : pct < 0 ? Math.abs(pct) * 1.5 : -Math.abs(pct) * 0.3;

        const pnlFromDelta = group.delta * dSpot;
        const pnlFromGamma = 0.5 * group.gamma * dSpot * dSpot;
        const pnlFromVega = group.vega * dIv;
        const pnlFromVanna = group.vanna * dSpot * dIv;
        const spotOnly = pnlFromDelta + pnlFromGamma;
        const combined = spotOnly + pnlFromVega + pnlFromVanna;

        return { pct, dIv, spotOnly, pnlFromVega, pnlFromVanna, combined };
      }),
    }));
  }, [portfolio.byUnderlying]);

  const openCount = positions.filter(
    (p) => (p as Record<string, unknown>).isOpen !== false,
  ).length;
  const isMultiUnderlying = portfolio.byUnderlying.length > 1;
  const singleScenarioGroup = scenarioGroups[0] ?? null;

  useEffect(() => {
    if (feedMode !== "broker") {
      setAccountNet(null);
      return;
    }

    let cancelled = false;

    async function loadLimits() {
      try {
        const limits = await fetchLimits();
        if (cancelled) return;
        setAccountNet(
          limits.net ?? ((limits.collateral ?? 0) + (limits.marginFromShares ?? 0)),
        );
      } catch {
        if (!cancelled) {
          setAccountNet(null);
        }
      }
    }

    loadLimits();
    const interval = setInterval(loadLimits, 60_000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [feedMode]);

  if (openCount === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-[#1a1a2e] text-[11px] text-panel-subtle">
        No open positions — Greeks will appear when you have positions
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#1a1a2e] text-xs">
      {/* ── Portfolio-level Greeks ── */}
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
        {isMultiUnderlying && (
          <div className="mb-2 rounded border border-yellow-400/20 bg-yellow-400/5 px-2.5 py-2 text-[11px] leading-snug text-[#d7d1a1]">
            Mixed-underlying book detected. Aggregate Greeks below are raw sensitivities across {portfolio.byUnderlying.length} underlyings. Rupee risk, IV regime context, and spot scenarios are shown per underlying in the sections below.
          </div>
        )}
        <div className="grid grid-cols-7 gap-2">
          <GreekCard label="Delta" value={portfolio.delta} decimals={1}
            hint={isMultiUnderlying
              ? "Raw aggregate delta across underlyings. Use per-underlying risk summary for rupee impact."
              : `₹${Math.abs(portfolio.delta * portfolio.spot * 0.01).toLocaleString("en-IN", { maximumFractionDigits: 0 })} P&L per 1% spot move`} />
          <GreekCard label="Gamma" value={portfolio.gamma} decimals={2}
            hint={isMultiUnderlying
              ? "Raw aggregate gamma across underlyings. Use per-underlying scenario ladders below."
              : `Delta changes by ${fmt(portfolio.gamma * portfolio.spot * 0.01, 1)} per 1% spot move`} />
          <GreekCard label="Theta" value={portfolio.theta} decimals={0}
            hint={`${fmtInr(portfolio.theta)} daily time decay`} />
          <GreekCard label="Vega" value={portfolio.vega} decimals={0}
            hint={`${fmtInr(portfolio.vega)} P&L per +1% IV move`} />
          <GreekCard label="Vanna" value={portfolio.vanna} decimals={1}
            hint={`Delta shifts by ${fmt(portfolio.vanna * 1, 1)} per +1% IV move. Captures the spot-vol cross-risk.`} />
          <GreekCard label="Charm" value={portfolio.charm} decimals={2}
            hint={`Delta drifts by ${fmt(portfolio.charm, 2)} per day. Overnight delta risk from time decay.`} />
          <GreekCard label="Vomma" value={portfolio.vomma} decimals={2}
            hint={`Vega changes by ${fmt(portfolio.vomma, 2)} per +1% IV move. Vega convexity — are you long or short vol-of-vol?`} />
        </div>
      </div>

      {/* ── Risk info bar ── */}
      <GreeksRiskInfoBar
        groups={portfolio.byUnderlying}
        selectedUnderlying={selectedUnderlying}
        vrp={vrp}
        accountNet={accountNet}
      />

      {/* ── Scenario matrix ── */}
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-2">
        <div className="mb-1.5 text-[9px] font-medium uppercase tracking-wider text-panel-subtle">
          Scenario Analysis — Spot move with correlated IV (index: 1% drop = ~1.5% IV rise; MCX: IV held flat)
        </div>
        {isMultiUnderlying ? (
          <div className="flex flex-col gap-2">
            {scenarioGroups.map((group) => (
              <div key={group.underlying}>
                <div className="mb-1 flex items-center justify-between text-[11px]">
                  <span className="font-semibold text-[#d0d0e0]">{group.underlying}</span>
                  <span className="text-panel-subtle">
                    {group.spot > 0
                      ? `Spot ${group.spot.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
                      : "Spot unavailable"}
                  </span>
                </div>
                <div className="grid grid-cols-6 gap-1">
                  {group.scenarios.map((scenario) => (
                    <div key={`${group.underlying}-${scenario.pct}`} className="flex flex-col items-center rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-1.5">
                      <span className={`text-[10px] font-bold ${scenario.pct > 0 ? "text-green-400/70" : "text-red-400/70"}`}>
                        {scenario.pct > 0 ? "+" : ""}{scenario.pct}%
                      </span>
                      <span className={`text-[11px] font-bold tabular-nums ${colorClass(scenario.combined)}`}
                        title={[
                          `Spot P&L: ${fmtInr(scenario.spotOnly)}`,
                          `Vega (${scenario.dIv > 0 ? "+" : ""}${scenario.dIv.toFixed(1)}% IV): ${fmtInr(scenario.pnlFromVega)}`,
                          `Vanna cross-term: ${fmtInr(scenario.pnlFromVanna)}`,
                        ].join(" | ")}>
                        {fmtInr(scenario.combined)}
                      </span>
                      <span className="text-[8px] text-panel-subtle">
                        IV {scenario.dIv > 0 ? "+" : ""}{scenario.dIv.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-1">
            {singleScenarioGroup?.scenarios.map((scenario) => (
              <div key={scenario.pct} className="flex flex-col items-center rounded border border-[#2a2a4a] bg-[#0f0f23] px-1 py-1.5">
                <span className={`text-[10px] font-bold ${scenario.pct > 0 ? "text-green-400/70" : "text-red-400/70"}`}>
                  {scenario.pct > 0 ? "+" : ""}{scenario.pct}%
                </span>
                <span className={`text-[11px] font-bold tabular-nums ${colorClass(scenario.combined)}`}
                  title={[
                    `Spot P&L: ${fmtInr(scenario.spotOnly)}`,
                    `Vega (${scenario.dIv > 0 ? "+" : ""}${scenario.dIv.toFixed(1)}% IV): ${fmtInr(scenario.pnlFromVega)}`,
                    `Vanna cross-term: ${fmtInr(scenario.pnlFromVanna)}`,
                  ].join(" | ")}>
                  {fmtInr(scenario.combined)}
                </span>
                <span className="text-[8px] text-panel-subtle">
                  IV {scenario.dIv > 0 ? "+" : ""}{scenario.dIv.toFixed(1)}%
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ── Per-leg Greeks breakdown ── */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-[#16213e]">
            <tr className="text-[10px] text-[#808090]">
              <th className="px-2 py-1.5 text-left font-medium">Leg</th>
              <th className="px-2 py-1.5 text-right font-medium">Qty</th>
              <th className="px-2 py-1.5 text-right font-medium">IV</th>
              <th className="px-2 py-1.5 text-right font-medium">Delta</th>
              <th className="px-2 py-1.5 text-right font-medium">Gamma</th>
              <th className="px-2 py-1.5 text-right font-medium">Theta</th>
              <th className="px-2 py-1.5 text-right font-medium">Vega</th>
              <th className="px-2 py-1.5 text-right font-medium" title="∂Delta/∂IV">Vanna</th>
              <th className="px-2 py-1.5 text-right font-medium" title="∂Delta/∂t — delta decay per day">Charm</th>
              <th className="px-2 py-1.5 text-right font-medium" title="∂Vega/∂σ — vega convexity">Vomma</th>
            </tr>
          </thead>
          <tbody>
            {portfolio.perLeg.map((leg) => (
              <tr key={leg.symbol} className="border-b border-[#2a2a4a]/30 hover:bg-[#1e1e3a]">
                <td className="px-2 py-1 text-left">
                  <span className="mr-1 text-[9px] font-medium uppercase tracking-wider text-[#707090]">
                    {leg.underlying}
                  </span>
                  <span className="font-mono text-[#c0c0d0]">{leg.strike}</span>
                  <span className={`ml-1 text-[10px] font-medium ${
                    leg.optionType === "CE" ? "text-green-400/70" : "text-red-400/70"
                  }`}>{leg.optionType}</span>
                  {leg.expiry && (
                    <span className="ml-1 text-[9px] text-[#606070]">
                      {leg.expiry.slice(5)}
                    </span>
                  )}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${leg.qty > 0 ? "text-green-400" : "text-red-400"}`}>
                  {leg.qty > 0 ? "+" : ""}{leg.qty}
                </td>
                <td className="px-2 py-1 text-right font-mono text-[#c0c0d0]">
                  {leg.iv.toFixed(1)}%
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.delta)}`}>
                  {fmt(leg.delta, 1)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.gamma)}`}>
                  {fmt(leg.gamma, 2)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.theta)}`}>
                  {fmt(leg.theta, 0)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.vega)}`}>
                  {fmt(leg.vega, 0)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.vanna)}`}>
                  {fmt(leg.vanna, 1)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.charm)}`}>
                  {fmt(leg.charm, 2)}
                </td>
                <td className={`px-2 py-1 text-right font-mono ${colorClass(leg.vomma)}`}>
                  {fmt(leg.vomma, 2)}
                </td>
              </tr>
            ))}
            {/* Totals row */}
            <tr className="border-t border-[#2a2a4a] bg-[#16213e] font-semibold">
              <td className="px-2 py-1.5 text-left text-[10px] uppercase text-[#808090]" colSpan={2}>
                Portfolio
              </td>
              <td className="px-2 py-1.5" />
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.delta)}`}>
                {fmt(portfolio.delta, 1)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.gamma)}`}>
                {fmt(portfolio.gamma, 2)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.theta)}`}>
                {fmt(portfolio.theta, 0)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.vega)}`}>
                {fmt(portfolio.vega, 0)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.vanna)}`}>
                {fmt(portfolio.vanna, 1)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.charm)}`}>
                {fmt(portfolio.charm, 2)}
              </td>
              <td className={`px-2 py-1.5 text-right font-mono ${colorClass(portfolio.vomma)}`}>
                {fmt(portfolio.vomma, 2)}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Greek card with tooltip ──────────────────────────────────────────

function GreekCard({
  label,
  value,
  decimals,
  hint,
}: {
  label: string;
  value: number;
  decimals: number;
  hint: string;
}) {
  return (
    <div
      className="flex flex-col items-center rounded border border-[#2a2a4a] bg-[#0f0f23] px-2 py-2"
      title={hint}
    >
      <span className="text-[9px] font-medium uppercase tracking-wider text-panel-subtle">
        {label}
      </span>
      <span className={`text-lg font-bold tabular-nums leading-tight ${colorClass(value)}`}>
        {fmt(value, decimals)}
      </span>
    </div>
  );
}
