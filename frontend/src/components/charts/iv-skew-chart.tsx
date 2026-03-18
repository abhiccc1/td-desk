"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath, Circle } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";

import { useMarketDataStore } from "@/stores/market-data-store";
import { useGreeksStore } from "@/stores/greeks-store";
import type { ModelPricesResult, SviParams } from "@/types/market-data";

interface Point {
  x: number;
  y: number;
}

interface MarketPoint extends Point {
  isCall: boolean;
}

const MARGIN = { top: 20, right: 20, bottom: 40, left: 50 };

function sviIvAtStrike(
  svi: SviParams,
  strike: number,
  spot: number,
  t: number,
): number | null {
  if (spot <= 0 || strike <= 0 || t <= 0) return null;
  const k = Math.log(strike / spot);
  const dk = k - svi.m;
  const w =
    svi.a +
    svi.b * (svi.rho * dk + Math.sqrt(dk * dk + svi.sigma * svi.sigma));
  if (w <= 0) return null;
  return Math.sqrt(w / t) * 100;
}

/** Build IV curve from ModelPricesResult for a given model. */
function modelIvCurve(
  modelPrices: ModelPricesResult | null,
  model: "heston" | "vg",
): Point[] {
  if (!modelPrices) return [];
  const curve: Point[] = [];
  for (const s of modelPrices.strikes) {
    const iv = model === "heston" ? s.hestonIv : s.vgIv;
    if (iv !== null && iv !== undefined && iv > 0 && iv < 2.0) {
      curve.push({ x: s.strike, y: iv * 100 });
    }
  }
  return curve;
}

function IvSkewInner({ width, height }: { width: number; height: number }) {
  const chain = useMarketDataStore((s) => s.optionChain);
  const svi = useMarketDataStore((s) => s.sviParams);
  const modelPrices = useMarketDataStore((s) => s.modelPrices);
  const greeksMap = useGreeksStore((s) => s.greeks);

  const { sviCurve, hestonCurve, vgCurve, marketDots, xDomain, yDomain, spot } = useMemo(() => {
    const empty = {
      sviCurve: [] as Point[],
      hestonCurve: [] as Point[],
      vgCurve: [] as Point[],
      marketDots: [] as MarketPoint[],
      xDomain: [0, 1] as [number, number],
      yDomain: [0, 100] as [number, number],
      spot: 0,
    };

    if (!chain || !chain.strikes.length) return empty;
    const sp = chain.underlyingPrice;
    if (sp <= 0) return empty;

    const referenceMs = chain.timestamp
      ? new Date(chain.timestamp).getTime()
      : new Date(chain.expiry).getTime();
    const expiryMs = new Date(chain.expiry).getTime() - referenceMs;
    const t = Math.max(expiryMs / (365.25 * 86400_000), 1e-6);

    // Collect market IVs from greeks store
    const dots: MarketPoint[] = [];
    const strikes = chain.strikes.map((s) => s.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);

    for (const s of chain.strikes) {
      for (const [side, isCall] of [
        ["call", true],
        ["put", false],
      ] as const) {
        const tick = s[side];
        if (!tick) continue;
        const g = greeksMap.get(tick.symbol);
        if (g && g.iv > 0) {
          dots.push({ x: s.strike, y: g.iv * 100, isCall });
        }
      }
    }

    // Generate smooth SVI curve
    const curve: Point[] = [];
    if (svi) {
      const step = (maxStrike - minStrike) / 150;
      for (let k = minStrike; k <= maxStrike; k += step) {
        const iv = sviIvAtStrike(svi, k, sp, t);
        if (iv !== null && iv > 0 && iv < 200) {
          curve.push({ x: k, y: iv });
        }
      }
    }

    // Build Heston and VG IV curves from model prices
    const hCurve = modelIvCurve(modelPrices, "heston");
    const vCurve = modelIvCurve(modelPrices, "vg");

    // Compute domains — include model curves in Y range
    const allYs = [
      ...dots.map((d) => d.y),
      ...curve.map((c) => c.y),
      ...hCurve.map((c) => c.y),
      ...vCurve.map((c) => c.y),
    ];
    const yMin = allYs.length > 0 ? Math.max(0, Math.min(...allYs) - 5) : 0;
    const yMax = allYs.length > 0 ? Math.min(200, Math.max(...allYs) + 5) : 100;

    return {
      sviCurve: curve,
      hestonCurve: hCurve,
      vgCurve: vCurve,
      marketDots: dots,
      xDomain: [minStrike, maxStrike] as [number, number],
      yDomain: [yMin, yMax] as [number, number],
      spot: sp,
    };
  }, [chain, svi, modelPrices, greeksMap]);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  const xScale = scaleLinear({
    domain: xDomain,
    range: [0, innerWidth],
  });

  const yScale = scaleLinear({
    domain: yDomain,
    range: [innerHeight, 0],
  });

  return (
    <svg width={width} height={height}>
      <Group left={MARGIN.left} top={MARGIN.top}>
        {/* Grid lines */}
        {yScale.ticks(5).map((tick) => (
          <line
            key={tick}
            x1={0}
            x2={innerWidth}
            y1={yScale(tick)}
            y2={yScale(tick)}
            stroke="rgba(255,255,255,0.05)"
          />
        ))}

        {/* Spot price vertical line */}
        {spot > 0 && spot >= xDomain[0] && spot <= xDomain[1] && (
          <line
            x1={xScale(spot)}
            x2={xScale(spot)}
            y1={0}
            y2={innerHeight}
            stroke="rgba(250,204,21,0.3)"
            strokeDasharray="4,4"
          />
        )}

        {/* SVI fitted curve */}
        {sviCurve.length > 1 && (
          <LinePath
            data={sviCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke="#3b82f6"
            strokeWidth={2}
            strokeOpacity={0.9}
          />
        )}

        {/* Heston model IV curve */}
        {hestonCurve.length > 1 && (
          <LinePath
            data={hestonCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke="#f97316"
            strokeWidth={1.5}
            strokeOpacity={0.85}
            strokeDasharray="6,3"
          />
        )}

        {/* VG model IV curve */}
        {vgCurve.length > 1 && (
          <LinePath
            data={vgCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke="#22d3ee"
            strokeWidth={1.5}
            strokeOpacity={0.85}
            strokeDasharray="2,3"
          />
        )}

        {/* Market IV scatter — calls */}
        {marketDots
          .filter((d) => d.isCall)
          .map((d, i) => (
            <Circle
              key={`c${i}`}
              cx={xScale(d.x)}
              cy={yScale(d.y)}
              r={2.5}
              fill="#60a5fa"
              fillOpacity={0.7}
            />
          ))}

        {/* Market IV scatter — puts */}
        {marketDots
          .filter((d) => !d.isCall)
          .map((d, i) => (
            <Circle
              key={`p${i}`}
              cx={xScale(d.x)}
              cy={yScale(d.y)}
              r={2.5}
              fill="#a78bfa"
              fillOpacity={0.7}
            />
          ))}

        {/* Axes */}
        <AxisBottom
          top={innerHeight}
          scale={xScale}
          numTicks={6}
          stroke="#444"
          tickStroke="#444"
          tickLabelProps={() => ({
            fill: "#808090",
            fontSize: 10,
            textAnchor: "middle",
          })}
          label="Strike"
          labelProps={{
            fill: "#808090",
            fontSize: 11,
            textAnchor: "middle",
          }}
        />
        <AxisLeft
          scale={yScale}
          numTicks={5}
          stroke="#444"
          tickStroke="#444"
          tickLabelProps={() => ({
            fill: "#808090",
            fontSize: 10,
            textAnchor: "end",
            dx: -4,
          })}
          label="IV %"
          labelProps={{
            fill: "#808090",
            fontSize: 11,
            textAnchor: "middle",
          }}
        />
      </Group>

      {/* Legend */}
      <Group left={MARGIN.left + 8} top={MARGIN.top + 8}>
        <line x1={0} x2={16} y1={0} y2={0} stroke="#3b82f6" strokeWidth={2} />
        <text x={20} y={4} fill="#808090" fontSize={10}>
          SVI Fit
        </text>
        <line x1={0} x2={16} y1={14} y2={14} stroke="#f97316" strokeWidth={1.5} strokeDasharray="6,3" />
        <text x={20} y={18} fill="#808090" fontSize={10}>
          Heston
        </text>
        <line x1={0} x2={16} y1={28} y2={28} stroke="#22d3ee" strokeWidth={1.5} strokeDasharray="2,3" />
        <text x={20} y={32} fill="#808090" fontSize={10}>
          VG
        </text>
        <Circle cx={4} cy={42} r={3} fill="#60a5fa" />
        <text x={20} y={46} fill="#808090" fontSize={10}>
          Call IV
        </text>
        <Circle cx={4} cy={56} r={3} fill="#a78bfa" />
        <text x={20} y={60} fill="#808090" fontSize={10}>
          Put IV
        </text>
      </Group>
    </svg>
  );
}

export function IvSkewChart() {
  const chain = useMarketDataStore((s) => s.optionChain);
  const underlying = chain?.underlying ?? "";
  const expiry = chain?.expiry ?? "";

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      {underlying && expiry && (
        <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-1.5 text-[10px] text-[#808090]">
          {underlying} {expiry} — IV Smile
        </div>
      )}
      <div className="min-h-0 flex-1">
        <ParentSize>
          {({ width, height }) => (
            <IvSkewInner width={width} height={height} />
          )}
        </ParentSize>
      </div>
    </div>
  );
}
