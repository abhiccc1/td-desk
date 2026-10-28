"use client";

import { useMemo, useState } from "react";
import { timeToExpiryYears } from "@/lib/instruments";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNow } from "@/hooks/use-now";
import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";

interface ComparisonRow {
  strike: number;
  bsmIv: number | null;
  sviIv: number | null;
  hestonIv: number | null;
  vgIv: number | null;
}

function sviIvAt(
  svi: { a: number; b: number; rho: number; m: number; sigma: number },
  strike: number,
  spot: number,
  t: number,
): number | null {
  if (spot <= 0 || strike <= 0 || t <= 0) return null;
  const k = Math.log(strike / spot);
  const dk = k - svi.m;
  const w = svi.a + svi.b * (svi.rho * dk + Math.sqrt(dk * dk + svi.sigma * svi.sigma));
  if (w <= 0) return null;
  return Math.sqrt(w / t);
}

export function ModelComparisonPanel() {
  const now = useNow(5000);
  const chain = useMarketDataStore((s) => s.optionChain);
  const svi = useMarketDataStore((s) => s.sviParams);
  const modelPrices = useMarketDataStore((s) => s.modelPrices);
  const greeksMap = useGreeksStore((s) => s.greeks);

  const rows = useMemo(() => {
    if (!chain || !chain.strikes.length) return [];

    const spot = chain.underlyingPrice;
    const t = timeToExpiryYears(chain.underlying, chain.expiry, new Date(now));

    // Build model IV lookup by strike
    const modelMap = new Map<number, { hestonIv: number | null; vgIv: number | null }>();
    if (modelPrices) {
      for (const s of modelPrices.strikes) {
        modelMap.set(s.strike, {
          hestonIv: s.hestonIv,
          vgIv: s.vgIv,
        });
      }
    }

    const result: ComparisonRow[] = [];
    for (const entry of chain.strikes) {
      // BSM IV from call greeks (prefer call side)
      const callTick = entry.call;
      const callGreeks = callTick ? greeksMap.get(callTick.symbol) : undefined;
      const bsmIv = callGreeks?.iv ?? null;

      // SVI IV
      const sviVal = svi ? sviIvAt(svi, entry.strike, spot, t) : null;

      // Model IVs
      const model = modelMap.get(entry.strike);

      result.push({
        strike: entry.strike,
        bsmIv: bsmIv,
        sviIv: sviVal,
        hestonIv: model?.hestonIv ?? null,
        vgIv: model?.vgIv ?? null,
      });
    }

    return result;
  }, [chain, svi, modelPrices, greeksMap, now]);

  const [exoticsOpen, setExoticsOpen] = useState(true);

  const underlying = chain?.underlying ?? "";
  const expiry = chain?.expiry ?? "";
  const spot = chain?.underlyingPrice ?? 0;

  // ── Exotics section data ──────────────────────────────────────
  const exoticsData = useMemo(() => {
    if (!modelPrices || !chain || spot <= 0) return null;

    const t = timeToExpiryYears(chain.underlying, chain.expiry, new Date(now));

    // Risk-Neutral Skew: compare 25d put vs 25d call IV spread for each model
    // Approximate by comparing OTM put vs OTM call (10% OTM)
    const otmPutStrike = spot * 0.9;
    const otmCallStrike = spot * 1.1;

    const findClosest = (target: number) =>
      modelPrices.strikes.reduce((prev, curr) =>
        Math.abs(curr.strike - target) < Math.abs(prev.strike - target) ? curr : prev,
      );

    const putSide = findClosest(otmPutStrike);
    const callSide = findClosest(otmCallStrike);

    const hestonSkew =
      putSide.hestonIv != null && callSide.hestonIv != null
        ? (putSide.hestonIv - callSide.hestonIv) * 100
        : null;
    const vgSkew =
      putSide.vgIv != null && callSide.vgIv != null
        ? (putSide.vgIv - callSide.vgIv) * 100
        : null;

    // SVI skew for comparison
    let sviSkew: number | null = null;
    if (svi) {
      const sviPut = sviIvAt(svi, putSide.strike, spot, t);
      const sviCall = sviIvAt(svi, callSide.strike, spot, t);
      if (sviPut != null && sviCall != null) {
        sviSkew = (sviPut - sviCall) * 100;
      }
    }

    // ATM straddle PoP
    const atmStrike = findClosest(spot);
    const hestonAtmPop = atmStrike.hestonPop;
    const vgAtmPop = atmStrike.vgPop;

    // Density mode: check if density is unimodal or has fat tails
    // Simple heuristic: compare max density position to spot
    const classifyDensity = (density: [number, number][] | null): string => {
      if (!density || density.length < 3) return "-";
      let maxVal = 0;
      let maxSpot = 0;
      for (const [s, d] of density) {
        if (d > maxVal) {
          maxVal = d;
          maxSpot = s;
        }
      }
      // Check tail weight: density at edges vs peak
      const leftTail = density[0][1];
      const rightTail = density[density.length - 1][1];
      const tailRatio = Math.max(leftTail, rightTail) / (maxVal || 1);
      if (tailRatio > 0.15) return "Fat-tailed";
      const skewRatio = (maxSpot - spot) / spot;
      if (Math.abs(skewRatio) < 0.02) return "Unimodal";
      return skewRatio < 0 ? "Left-skewed" : "Right-skewed";
    };

    const hestonDensityMode = classifyDensity(modelPrices.hestonDensity);
    const vgDensityMode = classifyDensity(modelPrices.vgDensity);

    return {
      hestonSkew,
      vgSkew,
      sviSkew,
      hestonAtmPop,
      vgAtmPop,
      hestonDensityMode,
      vgDensityMode,
    };
  }, [modelPrices, chain, svi, spot, now]);

  const formatIv = (v: number | null) => {
    if (v === null || v === undefined) return "-";
    return `${(v * 100).toFixed(1)}%`;
  };

  const diffClass = (model: number | null, bsm: number | null) => {
    if (model === null || bsm === null) return "";
    const diff = (model - bsm) * 100;
    if (diff > 1) return "text-red-400";
    if (diff < -1) return "text-green-400";
    return "";
  };

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      {underlying && expiry && (
        <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-1.5 text-[10px] text-[#808090]">
          {underlying} {expiry} — Model IV Comparison
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#16213e]">
            <tr className="text-[#808090]">
              <th className="px-2 py-1.5 text-right font-medium">Strike</th>
              <th className="px-2 py-1.5 text-right font-medium">BSM IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-emerald-400">SVI IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-amber-400">Heston IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-pink-400">VG IV</th>
            </tr>
          </thead>
          {/* Exotic model parameter rows */}
          {modelPrices && (
            <tbody className="border-b border-[#2a2a4a]">
              <tr className="bg-amber-950/20">
                <td colSpan={3} className="px-2 py-1.5 text-[10px]">
                  <span className="font-medium text-amber-400">Heston</span>
                  {modelPrices.hestonCalibrated
                    ? <span className="ml-1.5 rounded bg-emerald-900/40 px-1 py-0.5 text-[9px] text-emerald-400">CAL</span>
                    : <span className="ml-1.5 rounded bg-red-900/30 px-1 py-0.5 text-[9px] text-red-400">UNCAL</span>
                  }
                  {modelPrices.hestonRmse != null && (
                    <span className="ml-1.5 text-[9px] text-panel-subtle">RMSE {(modelPrices.hestonRmse * 100).toFixed(2)}%</span>
                  )}
                </td>
                <td colSpan={2} className="px-2 py-1.5 text-right font-mono text-[10px] text-amber-400/60">
                  {(() => {
                    const p = modelPrices.hestonParams;
                    return `κ=${p.kappa?.toFixed(2)} θ=${p.theta?.toFixed(3)} σv=${p.sigma_v?.toFixed(2)} ρ=${p.rho?.toFixed(2)} v₀=${p.v0?.toFixed(3)}`;
                  })()}
                </td>
              </tr>
              <tr className="bg-pink-950/20">
                <td colSpan={3} className="px-2 py-1.5 text-[10px]">
                  <span className="font-medium text-pink-400">Variance Gamma</span>
                  {modelPrices.vgCalibrated
                    ? <span className="ml-1.5 rounded bg-emerald-900/40 px-1 py-0.5 text-[9px] text-emerald-400">CAL</span>
                    : <span className="ml-1.5 rounded bg-red-900/30 px-1 py-0.5 text-[9px] text-red-400">UNCAL</span>
                  }
                  {modelPrices.vgRmse != null && (
                    <span className="ml-1.5 text-[9px] text-panel-subtle">RMSE {(modelPrices.vgRmse * 100).toFixed(2)}%</span>
                  )}
                </td>
                <td colSpan={2} className="px-2 py-1.5 text-right font-mono text-[10px] text-pink-400/60">
                  {(() => {
                    const p = modelPrices.vgParams;
                    return `σ=${p.sigma?.toFixed(3)} θ=${p.theta?.toFixed(3)} ν=${p.nu?.toFixed(3)}`;
                  })()}
                </td>
              </tr>
            </tbody>
          )}
          {/* Exotics section */}
          {modelPrices && exoticsData && (
            <tbody className="border-b border-[#2a2a4a]">
              <tr
                className="cursor-pointer select-none bg-slate-800/50 hover:bg-slate-700/50"
                onClick={() => setExoticsOpen((v) => !v)}
              >
                <td colSpan={5} className="px-2 py-1.5 text-[10px]">
                  <span className="inline-flex items-center gap-1 font-medium text-cyan-400">
                    {exoticsOpen
                      ? <ChevronDown className="h-3 w-3" />
                      : <ChevronRight className="h-3 w-3" />
                    }
                    Exotics
                  </span>
                  <span className="ml-2 text-[9px] text-panel-subtle">
                    Risk-neutral skew, PoP, density analysis
                  </span>
                </td>
              </tr>
              {exoticsOpen && (
                <>
                  {/* Risk-Neutral Skew */}
                  <tr className="bg-slate-800/30">
                    <td className="px-2 py-1 text-[10px] text-[#808090]" colSpan={2}>
                      Risk-Neutral Skew
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-emerald-400/80">
                      {exoticsData.sviSkew != null ? `${exoticsData.sviSkew.toFixed(1)}%` : "-"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-amber-400/80">
                      {exoticsData.hestonSkew != null ? `${exoticsData.hestonSkew.toFixed(1)}%` : "-"}
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-pink-400/80">
                      {exoticsData.vgSkew != null ? `${exoticsData.vgSkew.toFixed(1)}%` : "-"}
                    </td>
                  </tr>
                  {/* PoP Summary (ATM straddle) */}
                  <tr className="bg-slate-800/30">
                    <td className="px-2 py-1 text-[10px] text-[#808090]" colSpan={2}>
                      ATM Call PoP
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-panel-subtle">
                      -
                    </td>
                    <td className={`px-2 py-1 text-right font-mono text-[10px] ${
                      exoticsData.hestonAtmPop != null
                        ? exoticsData.hestonAtmPop > 0.6
                          ? "text-green-400"
                          : exoticsData.hestonAtmPop >= 0.5
                            ? "text-yellow-400"
                            : "text-red-400"
                        : "text-panel-subtle"
                    }`}>
                      {exoticsData.hestonAtmPop != null
                        ? `${(exoticsData.hestonAtmPop * 100).toFixed(0)}%`
                        : "-"}
                    </td>
                    <td className={`px-2 py-1 text-right font-mono text-[10px] ${
                      exoticsData.vgAtmPop != null
                        ? exoticsData.vgAtmPop > 0.6
                          ? "text-green-400"
                          : exoticsData.vgAtmPop >= 0.5
                            ? "text-yellow-400"
                            : "text-red-400"
                        : "text-panel-subtle"
                    }`}>
                      {exoticsData.vgAtmPop != null
                        ? `${(exoticsData.vgAtmPop * 100).toFixed(0)}%`
                        : "-"}
                    </td>
                  </tr>
                  {/* Density Mode */}
                  <tr className="bg-slate-800/30">
                    <td className="px-2 py-1 text-[10px] text-[#808090]" colSpan={2}>
                      Density Mode
                    </td>
                    <td className="px-2 py-1 text-right font-mono text-[10px] text-panel-subtle">
                      -
                    </td>
                    <td className={`px-2 py-1 text-right text-[10px] ${
                      exoticsData.hestonDensityMode === "Fat-tailed"
                        ? "text-red-400"
                        : exoticsData.hestonDensityMode === "Unimodal"
                          ? "text-green-400"
                          : "text-yellow-400"
                    }`}>
                      {exoticsData.hestonDensityMode}
                    </td>
                    <td className={`px-2 py-1 text-right text-[10px] ${
                      exoticsData.vgDensityMode === "Fat-tailed"
                        ? "text-red-400"
                        : exoticsData.vgDensityMode === "Unimodal"
                          ? "text-green-400"
                          : "text-yellow-400"
                    }`}>
                      {exoticsData.vgDensityMode}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          )}
          <tbody>
            {rows.map((row) => {
              const isAtm = spot > 0 && Math.abs(row.strike - spot) / spot < 0.005;
              return (
                <tr
                  key={row.strike}
                  className={`border-b border-[#2a2a4a]/30 ${isAtm ? "bg-yellow-900/10" : "hover:bg-[#1e1e3a]"}`}
                >
                  <td className={`px-2 py-1 text-right font-mono ${isAtm ? "font-bold text-yellow-300" : "text-[#c0c0d0]"}`}>
                    {row.strike}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-[#c0c0d0]">
                    {formatIv(row.bsmIv)}
                  </td>
                  <td className="px-2 py-1 text-right font-mono text-emerald-400/80">
                    {formatIv(row.sviIv)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${diffClass(row.hestonIv, row.bsmIv) || "text-amber-400/80"}`}>
                    {formatIv(row.hestonIv)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${diffClass(row.vgIv, row.bsmIv) || "text-pink-400/80"}`}>
                    {formatIv(row.vgIv)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
