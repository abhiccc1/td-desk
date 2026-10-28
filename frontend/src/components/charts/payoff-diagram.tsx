"use client";

import { useMemo, useState } from "react";
import { legValue, underlyingOfSymbol, underlyingPriceLabel } from "@/lib/instruments";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath, AreaClosed, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft, AxisRight } from "@visx/axis";
import { curveMonotoneX } from "@visx/curve";
import { Group } from "@visx/group";
import { Info } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

import { useBasketStore } from "@/stores/basket-store";

interface PayoffPoint {
  x: number;
  y: number;
}

const MARGIN = { top: 68, right: 65, bottom: 44, left: 68 };

function computePayoff(
  legs: { symbol: string; strike: number; optionType: string; side: string; quantity: number; premium: number }[],
  spotRange: number[],
): PayoffPoint[] {
  return spotRange.map((spot) => {
    let pnl = 0;
    for (const leg of legs) {
      const isCall = leg.optionType === "C" || leg.optionType === "CE";
      const intrinsic = isCall
        ? Math.max(spot - leg.strike, 0)
        : Math.max(leg.strike - spot, 0);
      // ₹: × unit multiplier (GOLD 100, GOLDM 0.1, NSE/BSE 1)
      const legPnl = legValue(leg.symbol, intrinsic - leg.premium, leg.quantity);
      pnl += leg.side === "BUY" ? legPnl : -legPnl;
    }
    return { x: spot, y: pnl };
  });
}

interface DensityPoint {
  x: number;
  y: number;
}

function PayoffChart({ width, height }: { width: number; height: number }) {
  const legs = useBasketStore((s) => s.legs);
  const analysisResult = useBasketStore((s) => s.analysisResult);

  const data = useMemo(() => {
    // Prefer server-computed payoff from analysisResult (covers position analysis too)
    if (analysisResult?.payoffX?.length && analysisResult?.payoffY?.length) {
      return analysisResult.payoffX.map((x, i) => ({ x, y: analysisResult.payoffY[i] }));
    }

    // Fallback: compute locally from basket legs
    if (legs.length === 0) return [];

    const strikes = legs.map((l) => l.strike);
    const minStrike = Math.min(...strikes);
    const maxStrike = Math.max(...strikes);
    const range = maxStrike - minStrike || 1000;
    const lo = minStrike - range * 0.5;
    const hi = maxStrike + range * 0.5;

    const spotRange: number[] = [];
    const step = (hi - lo) / 200;
    for (let s = lo; s <= hi; s += step) {
      spotRange.push(Math.round(s * 100) / 100);
    }

    return computePayoff(legs, spotRange);
  }, [legs, analysisResult]);

  const innerWidth = width - MARGIN.left - MARGIN.right;
  const innerHeight = height - MARGIN.top - MARGIN.bottom;

  const xScale = useMemo(
    () =>
      scaleLinear<number>({
        domain: data.length
          ? [data[0].x, data[data.length - 1].x]
          : [0, 100],
        range: [0, innerWidth],
      }),
    [data, innerWidth],
  );

  const yScale = useMemo(() => {
    if (data.length === 0) {
      return scaleLinear<number>({ domain: [-100, 100], range: [innerHeight, 0] });
    }
    const yValues = data.map((d) => d.y);
    const minY = Math.min(...yValues);
    const maxY = Math.max(...yValues);
    const padding = (maxY - minY) * 0.1 || 50;
    return scaleLinear<number>({
      domain: [minY - padding, maxY + padding],
      range: [innerHeight, 0],
    });
  }, [data, innerHeight]);

  const breakevenPoints = useMemo(() => {
    const points: PayoffPoint[] = [];
    for (let i = 1; i < data.length; i++) {
      const prev = data[i - 1];
      const curr = data[i];
      if ((prev.y <= 0 && curr.y >= 0) || (prev.y >= 0 && curr.y <= 0)) {
        const ratio = Math.abs(prev.y) / (Math.abs(prev.y) + Math.abs(curr.y));
        const x = prev.x + (curr.x - prev.x) * ratio;
        points.push({ x, y: 0 });
      }
    }
    return points;
  }, [data]);

  // ── Density curve from analysis result ──
  const densityData = useMemo<DensityPoint[]>(() => {
    if (!analysisResult?.densityX || !analysisResult?.densityY) return [];
    const dx = analysisResult.densityX;
    const dy = analysisResult.densityY;
    if (dx.length !== dy.length || dx.length === 0) return [];
    return dx.map((x, i) => ({ x, y: dy[i] }));
  }, [analysisResult]);

  const densityYScale = useMemo(() => {
    if (densityData.length === 0) {
      return scaleLinear<number>({ domain: [0, 1], range: [innerHeight, 0] });
    }
    const maxD = Math.max(...densityData.map((d) => d.y));
    return scaleLinear<number>({
      domain: [0, maxD * 1.15],
      range: [innerHeight, 0],
    });
  }, [densityData, innerHeight]);

  // ── Find spot price where payoff ≈ VaR5 for vertical marker ──
  const varSpot = useMemo(() => {
    if (
      analysisResult?.var5 == null ||
      !analysisResult?.payoffX ||
      !analysisResult?.payoffY
    )
      return null;
    const var5 = analysisResult.var5;
    const px = analysisResult.payoffX;
    const py = analysisResult.payoffY;
    for (let i = 1; i < py.length; i++) {
      if (
        (py[i - 1] <= var5 && py[i] >= var5) ||
        (py[i - 1] >= var5 && py[i] <= var5)
      ) {
        const denom =
          Math.abs(py[i - 1] - var5) + Math.abs(py[i] - var5);
        if (denom === 0) continue;
        const frac = Math.abs(py[i - 1] - var5) / denom;
        return px[i - 1] + frac * (px[i] - px[i - 1]);
      }
    }
    return null;
  }, [analysisResult]);

  // ── Key price levels for vertical markers ──
  const spotPrice = useMemo(() => {
    if (!analysisResult?.legs?.length) return null;
    const s = (analysisResult.legs as Array<{ spot?: number }>).find((l) => l.spot && l.spot > 0);
    return s?.spot ?? null;
  }, [analysisResult]);

  const densityPeak = useMemo(() => {
    if (densityData.length === 0) return null;
    let maxD = 0;
    let peakX = 0;
    for (const d of densityData) {
      if (d.y > maxD) {
        maxD = d.y;
        peakX = d.x;
      }
    }
    return maxD > 0 ? peakX : null;
  }, [densityData]);

  const naivePoP = analysisResult?.probabilityOfProfit ?? null;
  const rndPoP = analysisResult?.riskNeutralPop ?? null;

  // ── Risk/Reward derived metrics ──
  const riskReward = useMemo(() => {
    const maxP = analysisResult?.maxProfit;
    const maxL = analysisResult?.maxLoss;
    if (maxP == null || maxL == null || maxL >= 0) return null;
    const absLoss = Math.abs(maxL);
    const rr = absLoss > 0 ? maxP / absLoss : null;
    const pop = rndPoP ?? naivePoP;
    let ev: number | null = null;
    let kelly: number | null = null;
    if (pop != null && rr != null) {
      ev = pop * maxP - (1 - pop) * absLoss;
      kelly = rr > 0 ? (pop * (1 + rr) - 1) / rr : null;
    }
    return { rr, ev, kelly, maxP, absLoss };
  }, [analysisResult, rndPoP, naivePoP]);

  const zeroY = yScale(0);

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <svg width={width} height={height} className="bg-panel">
      {/* ── Risk Metrics Legend ── */}
      <Group left={MARGIN.left} top={4}>
        {/* Row 1: PoP variants */}
        {naivePoP !== null && (
          <text x={0} y={14} fill="#a0a0b8" fontSize={12}>
            PoP (unif): {(naivePoP * 100).toFixed(1)}%
          </text>
        )}
        {rndPoP !== null && (
          <text
            x={145}
            y={14}
            fill={rndPoP >= 0.5 ? "#4ade80" : "#f87171"}
            fontSize={12}
            fontWeight={600}
          >
            PoP (Heston): {(rndPoP * 100).toFixed(1)}%
          </text>
        )}
        {analysisResult?.vgPop != null && (
          <text x={330} y={14} fill="#a78bfa" fontSize={12} fontWeight={600}>
            PoP (VG): {(analysisResult.vgPop * 100).toFixed(1)}%
          </text>
        )}
        {/* Density legend icon */}
        {densityData.length > 0 && (
          <>
            <rect x={470} y={5} width={12} height={10} fill="#60a5fa" opacity={0.35} rx={2} />
            <text x={486} y={14} fill="#a0a0b8" fontSize={12}>
              Density
            </text>
          </>
        )}

        {/* Row 2: Edge + Risk metrics */}
        {analysisResult?.popEdge != null && (
          <text
            x={0}
            y={30}
            fill={
              analysisResult.popEdge > 0
                ? "#4ade80"
                : analysisResult.popEdge < -0.02
                  ? "#f87171"
                  : "#fbbf24"
            }
            fontSize={12}
            fontWeight={700}
          >
            Edge: {analysisResult.popEdge > 0 ? "+" : ""}
            {(analysisResult.popEdge * 100).toFixed(1)}%
          </text>
        )}
        {analysisResult?.var5 != null && (
          <text x={145} y={30} fill="#f97316" fontSize={12}>
            VaR(5%): ₹
            {analysisResult.var5.toLocaleString("en-IN", {
              maximumFractionDigits: 0,
            })}
          </text>
        )}
        {analysisResult?.es5 != null && (
          <text x={330} y={30} fill="#ef4444" fontSize={12}>
            ES(5%): ₹
            {analysisResult.es5.toLocaleString("en-IN", {
              maximumFractionDigits: 0,
            })}
          </text>
        )}

        {/* Row 3: R:R, EV, Kelly */}
        {riskReward && riskReward.rr != null && (
          <text x={0} y={46} fill="#a0a0b8" fontSize={12}>
            R:R 1:{riskReward.rr.toFixed(2)}
          </text>
        )}
        {riskReward?.ev != null && (
          <text
            x={145}
            y={46}
            fill={riskReward.ev > 0 ? "#4ade80" : riskReward.ev < 0 ? "#f87171" : "#a0a0b8"}
            fontSize={12}
            fontWeight={600}
          >
            EV: ₹{riskReward.ev.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
          </text>
        )}
        {riskReward?.kelly != null && (
          <text
            x={330}
            y={46}
            fill={riskReward.kelly > 0 ? "#4ade80" : riskReward.kelly <= 0 ? "#f87171" : "#a0a0b8"}
            fontSize={12}
          >
            Kelly: {riskReward.kelly > 0 ? "" : ""}{(riskReward.kelly * 100).toFixed(1)}%
          </text>
        )}
      </Group>

      <Group left={MARGIN.left} top={MARGIN.top}>
        {/* Density area fill (behind payoff) */}
        {densityData.length > 0 && (
          <AreaClosed<DensityPoint>
            data={densityData}
            x={(d) => xScale(d.x)}
            y={(d) => densityYScale(d.y)}
            yScale={densityYScale}
            fill="#60a5fa"
            opacity={0.15}
            curve={curveMonotoneX}
          />
        )}

        {/* Density line */}
        {densityData.length > 0 && (
          <LinePath<DensityPoint>
            data={densityData}
            x={(d) => xScale(d.x)}
            y={(d) => densityYScale(d.y)}
            stroke="#60a5fa"
            strokeWidth={1.5}
            opacity={0.6}
            curve={curveMonotoneX}
          />
        )}

        {/* ── VaR 5% horizontal line (P&L level) ── */}
        {analysisResult?.var5 != null && (
          <line
            x1={0}
            x2={innerWidth}
            y1={yScale(analysisResult.var5)}
            y2={yScale(analysisResult.var5)}
            stroke="#f97316"
            strokeWidth={1}
            strokeDasharray="4,4"
            opacity={0.5}
          />
        )}

        {/* ── VaR 5% vertical line (spot price where VaR occurs) ── */}
        {varSpot !== null && (
          <>
            <line
              x1={xScale(varSpot)}
              x2={xScale(varSpot)}
              y1={0}
              y2={innerHeight}
              stroke="#f97316"
              strokeWidth={1.5}
              strokeDasharray="6,3"
              opacity={0.7}
            />
            <text
              x={xScale(varSpot) + 4}
              y={16}
              fill="#f97316"
              fontSize={12}
              fontWeight={600}
            >
              VaR 5% @ {varSpot.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </text>
          </>
        )}

        {/* ── Current Spot vertical line (amber) ── */}
        {spotPrice !== null && (
          <>
            <line
              x1={xScale(spotPrice)}
              x2={xScale(spotPrice)}
              y1={0}
              y2={innerHeight}
              stroke="#fbbf24"
              strokeWidth={1.5}
              strokeDasharray="6,3"
              opacity={0.7}
            />
            <text
              x={xScale(spotPrice) + 4}
              y={innerHeight - 4}
              fill="#fbbf24"
              fontSize={12}
              fontWeight={600}
            >
              {underlyingPriceLabel(underlyingOfSymbol(legs[0]?.symbol))} {spotPrice.toLocaleString("en-IN")}
            </text>
          </>
        )}

        {/* ── Breakeven vertical lines (white, subtle) ── */}
        {breakevenPoints.map((bp, i) => (
          <g key={`be-line-${i}`}>
            <line
              x1={xScale(bp.x)}
              x2={xScale(bp.x)}
              y1={0}
              y2={innerHeight}
              stroke="#ffffff"
              strokeWidth={1}
              strokeDasharray="3,5"
              opacity={0.25}
            />
            <text
              x={xScale(bp.x) + 3}
              y={innerHeight - 4}
              fill="#ffffff"
              fontSize={11}
              opacity={0.6}
            >
              BE {bp.x.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </text>
          </g>
        ))}

        {/* ── Density peak vertical line (blue, subtle) ── */}
        {densityPeak !== null && (
          <>
            <line
              x1={xScale(densityPeak)}
              x2={xScale(densityPeak)}
              y1={0}
              y2={innerHeight}
              stroke="#60a5fa"
              strokeWidth={1}
              strokeDasharray="2,4"
              opacity={0.4}
            />
            <text
              x={xScale(densityPeak) + 3}
              y={16}
              fill="#60a5fa"
              fontSize={11}
              opacity={0.7}
            >
              Peak {densityPeak.toLocaleString("en-IN", { maximumFractionDigits: 0 })}
            </text>
          </>
        )}

        {/* Zero line */}
        <line
          x1={0}
          x2={innerWidth}
          y1={zeroY}
          y2={zeroY}
          stroke="#ffffff"
          strokeWidth={1}
          strokeDasharray="4,4"
          opacity={0.5}
        />

        {/* Profit area (above zero) */}
        {data.length > 0 && (
          <clipPath id="profit-clip">
            <Bar x={0} y={0} width={innerWidth} height={zeroY} />
          </clipPath>
        )}
        {data.length > 0 && (
          <clipPath id="loss-clip">
            <Bar
              x={0}
              y={zeroY}
              width={innerWidth}
              height={innerHeight - zeroY}
            />
          </clipPath>
        )}

        {/* Profit portion of the line */}
        <LinePath<PayoffPoint>
          data={data}
          x={(d) => xScale(d.x)}
          y={(d) => yScale(d.y)}
          stroke="#4ade80"
          strokeWidth={2}
          clipPath="url(#profit-clip)"
        />

        {/* Loss portion of the line */}
        <LinePath<PayoffPoint>
          data={data}
          x={(d) => xScale(d.x)}
          y={(d) => yScale(d.y)}
          stroke="#f87171"
          strokeWidth={2}
          clipPath="url(#loss-clip)"
        />

        {/* Breakeven dots */}
        {breakevenPoints.map((bp, i) => (
          <circle
            key={i}
            cx={xScale(bp.x)}
            cy={zeroY}
            r={5}
            fill="#ffffff"
            stroke="#1a1a2e"
            strokeWidth={2}
          />
        ))}

        <AxisBottom
          top={innerHeight}
          scale={xScale}
          stroke="#e0e0e0"
          tickStroke="#e0e0e0"
          tickLabelProps={() => ({
            fill: "#e0e0e0",
            fontSize: 12,
            textAnchor: "middle" as const,
          })}
          label="Underlying Price"
          labelProps={{
            fill: "#e0e0e0",
            fontSize: 13,
            textAnchor: "middle",
          }}
          numTicks={6}
        />

        <AxisLeft
          scale={yScale}
          stroke="#e0e0e0"
          tickStroke="#e0e0e0"
          tickLabelProps={() => ({
            fill: "#e0e0e0",
            fontSize: 12,
            textAnchor: "end" as const,
            dx: -4,
          })}
          label="P&L"
          labelProps={{
            fill: "#e0e0e0",
            fontSize: 13,
            textAnchor: "middle",
          }}
          numTicks={6}
        />

        {/* Right axis for density scale */}
        {densityData.length > 0 && (
          <AxisRight
            left={innerWidth}
            scale={densityYScale}
            stroke="#60a5fa"
            tickStroke="#60a5fa"
            tickLabelProps={() => ({
              fill: "#60a5fa",
              fontSize: 11,
              textAnchor: "start" as const,
              dx: 4,
            })}
            label="Density"
            labelProps={{
              fill: "#60a5fa",
              fontSize: 12,
              textAnchor: "middle",
            }}
            numTicks={4}
          />
        )}
      </Group>
    </svg>
  );
}

const PARAM_DESCRIPTIONS = [
  { name: "PoP (unif)", desc: "Probability of profit assuming a uniform distribution of spot prices at expiry." },
  { name: "PoP (Heston)", desc: "Probability of profit using risk-neutral density from the Heston stochastic volatility model." },
  { name: "PoP (VG)", desc: "Probability of profit using the Variance Gamma model, which captures skew and kurtosis." },
  { name: "Edge", desc: "Difference between Heston PoP and naive PoP. Positive edge means the market-implied density favours your position." },
  { name: "VaR (5%)", desc: "Value at Risk at the 5th percentile — the worst P&L you can expect 95% of the time." },
  { name: "ES (5%)", desc: "Expected Shortfall (CVaR) — the average P&L in the worst 5% of scenarios. Always worse than VaR." },
  { name: "R:R", desc: "Risk-to-Reward ratio — max profit divided by max loss. Higher is better for defined-risk strategies." },
  { name: "EV", desc: "Expected Value — probability-weighted average P&L of the strategy using the best available PoP." },
  { name: "Kelly", desc: "Kelly criterion fraction — optimal position size as a % of capital to maximise long-run growth." },
  { name: "Density Curve", desc: "Risk-neutral probability density of the underlying at expiry, derived from the Heston/VG model calibration." },
  { name: "Spot Line", desc: "Current spot price of the underlying, shown as a vertical amber line." },
  { name: "BE (Breakeven)", desc: "Spot price(s) at which the strategy P&L is zero at expiry." },
  { name: "Density Peak", desc: "The spot price with the highest probability density — the market's most likely expiry price." },
];

export function PayoffDiagram() {
  const [infoOpen, setInfoOpen] = useState(false);

  return (
    <div className="relative h-full w-full bg-panel text-panel-muted">
      <Dialog open={infoOpen} onOpenChange={setInfoOpen}>
        <DialogTrigger
          render={
            <button className="absolute right-2 top-2 z-10 rounded p-1 text-panel-muted hover:bg-white/10 hover:text-white transition-colors" />
          }
        >
          <Info size={16} />
        </DialogTrigger>
        <DialogContent className="sm:max-w-md max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Payoff Analysis Parameters</DialogTitle>
          </DialogHeader>
          <dl className="grid gap-3 text-sm">
            {PARAM_DESCRIPTIONS.map((p) => (
              <div key={p.name}>
                <dt className="font-medium text-foreground">{p.name}</dt>
                <dd className="text-muted-foreground mt-0.5">{p.desc}</dd>
              </div>
            ))}
          </dl>
        </DialogContent>
      </Dialog>
      <ParentSize>
        {({ width, height }) => (
          <PayoffChart width={width} height={height} />
        )}
      </ParentSize>
    </div>
  );
}
