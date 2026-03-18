"use client";

import { useMemo } from "react";
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
    const expiryMs = new Date(chain.expiry).getTime() - now;
    const t = Math.max(expiryMs / (365.25 * 86400_000), 1e-6);

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

  const underlying = chain?.underlying ?? "";
  const expiry = chain?.expiry ?? "";
  const spot = chain?.underlyingPrice ?? 0;

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
          {modelPrices && (
            <span className="ml-2 text-[#606070]">
              Heston({Object.entries(modelPrices.hestonParams).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(', ')})
              {" "}VG({Object.entries(modelPrices.vgParams).map(([k, v]) => `${k}=${typeof v === 'number' ? v.toFixed(2) : v}`).join(', ')})
            </span>
          )}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[#16213e]">
            <tr className="text-[#808090]">
              <th className="px-2 py-1.5 text-right font-medium">Strike</th>
              <th className="px-2 py-1.5 text-right font-medium">BSM IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-blue-400">SVI IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-orange-400">Heston IV</th>
              <th className="px-2 py-1.5 text-right font-medium text-cyan-400">VG IV</th>
            </tr>
          </thead>
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
                  <td className="px-2 py-1 text-right font-mono text-blue-400/80">
                    {formatIv(row.sviIv)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${diffClass(row.hestonIv, row.bsmIv) || "text-orange-400/80"}`}>
                    {formatIv(row.hestonIv)}
                  </td>
                  <td className={`px-2 py-1 text-right font-mono ${diffClass(row.vgIv, row.bsmIv) || "text-cyan-400/80"}`}>
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
