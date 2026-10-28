"use client";

import { useMemo } from "react";
import { timeToExpiryYears } from "@/lib/instruments";
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

/* ── Color palette ─────────────────────────────────────────────── */
const COLORS = {
  sviFit: "#60a5fa",     // blue-400 — reference curve
  heston: "#f97316",     // orange-500 — bright on dark bg
  vg: "#a78bfa",         // violet-400 — distinct from blue & orange
  callIv: "#34d399",     // emerald-400 — scatter calls
  putIv: "#fb7185",      // rose-400 — scatter puts
  spot: "#fbbf24",       // amber-400 — spot line
  calGood: "#22c55e",    // green-500 — calibrated
  calBad: "#ef4444",     // red-500 — uncalibrated
} as const;

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

    // Same expiry close as the quant service's SVI fit (15:30 IST / MCX evening)
    const t = timeToExpiryYears(
      chain.underlying,
      chain.expiry,
      chain.timestamp ? new Date(chain.timestamp) : new Date(),
    );

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
      {/* Glow filters for model curves (subtle outer glow for readability) */}
      <defs>
        <filter id="glow-svi" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
        <filter id="glow-model" x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur in="SourceGraphic" stdDeviation="1" result="blur" />
          <feMerge>
            <feMergeNode in="blur" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

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

        {/* Spot price vertical line — amber, thin dashed */}
        {spot > 0 && spot >= xDomain[0] && spot <= xDomain[1] && (
          <line
            x1={xScale(spot)}
            x2={xScale(spot)}
            y1={0}
            y2={innerHeight}
            stroke={COLORS.spot}
            strokeOpacity={0.4}
            strokeWidth={1}
            strokeDasharray="4,4"
          />
        )}

        {/* SVI fitted curve — blue, solid (reference) */}
        {sviCurve.length > 1 && (
          <LinePath
            data={sviCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke={COLORS.sviFit}
            strokeWidth={2.5}
            strokeOpacity={0.95}
            filter="url(#glow-svi)"
          />
        )}

        {/* Heston model IV curve — orange, long dash [10,5] */}
        {hestonCurve.length > 1 && (
          <LinePath
            data={hestonCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke={COLORS.heston}
            strokeWidth={2}
            strokeOpacity={0.95}
            strokeDasharray="10,5"
            filter="url(#glow-model)"
          />
        )}

        {/* VG model IV curve — violet, dash-dot [8,4,2,4] */}
        {vgCurve.length > 1 && (
          <LinePath
            data={vgCurve}
            x={(d) => xScale(d.x)}
            y={(d) => yScale(d.y)}
            stroke={COLORS.vg}
            strokeWidth={2}
            strokeOpacity={0.95}
            strokeDasharray="8,4,2,4"
            filter="url(#glow-model)"
          />
        )}

        {/* Market IV scatter — calls (emerald circles) */}
        {marketDots
          .filter((d) => d.isCall)
          .map((d, i) => (
            <Circle
              key={`c${i}`}
              cx={xScale(d.x)}
              cy={yScale(d.y)}
              r={3}
              fill={COLORS.callIv}
              fillOpacity={0.8}
            />
          ))}

        {/* Market IV scatter — puts (rose triangles via polygon) */}
        {marketDots
          .filter((d) => !d.isCall)
          .map((d, i) => {
            const cx = xScale(d.x);
            const cy = yScale(d.y);
            const r = 3.5;
            // Downward-pointing triangle
            const points = `${cx},${cy + r} ${cx - r},${cy - r * 0.6} ${cx + r},${cy - r * 0.6}`;
            return (
              <polygon
                key={`p${i}`}
                points={points}
                fill={COLORS.putIv}
                fillOpacity={0.8}
              />
            );
          })}

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
        {/* SVI Fit — solid blue line */}
        <line x1={0} x2={16} y1={0} y2={0} stroke={COLORS.sviFit} strokeWidth={2.5} />
        <text x={20} y={4} fill={COLORS.sviFit} fontSize={10}>
          SVI Fit
        </text>

        {/* Heston — dashed orange line + calibration status */}
        <line x1={0} x2={16} y1={14} y2={14} stroke={COLORS.heston} strokeWidth={2} strokeDasharray="10,5" />
        <text x={20} y={18} fill={COLORS.heston} fontSize={10}>
          {"Heston "}
          {modelPrices?.hestonCalibrated ? (
            <tspan fill={COLORS.calGood}>
              (cal{modelPrices.hestonRmse != null ? `, RMSE: ${(modelPrices.hestonRmse * 100).toFixed(1)}%` : ""})
            </tspan>
          ) : (
            <tspan fill={COLORS.calBad}>(uncal)</tspan>
          )}
        </text>

        {/* VG — dash-dot violet line + calibration status */}
        <line x1={0} x2={16} y1={28} y2={28} stroke={COLORS.vg} strokeWidth={2} strokeDasharray="8,4,2,4" />
        <text x={20} y={32} fill={COLORS.vg} fontSize={10}>
          {"VG "}
          {modelPrices?.vgCalibrated ? (
            <tspan fill={COLORS.calGood}>
              (cal{modelPrices.vgRmse != null ? `, RMSE: ${(modelPrices.vgRmse * 100).toFixed(1)}%` : ""})
            </tspan>
          ) : (
            <tspan fill={COLORS.calBad}>(uncal)</tspan>
          )}
        </text>

        {/* Call IV — emerald circle */}
        <Circle cx={4} cy={42} r={3} fill={COLORS.callIv} fillOpacity={0.8} />
        <text x={20} y={46} fill={COLORS.callIv} fontSize={10}>
          Call IV
        </text>

        {/* Put IV — rose triangle */}
        <polygon points="4,53 1,58 7,58" fill={COLORS.putIv} fillOpacity={0.8} />
        <text x={20} y={60} fill={COLORS.putIv} fontSize={10}>
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
