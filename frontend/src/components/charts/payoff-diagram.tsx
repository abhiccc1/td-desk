"use client";

import { useMemo } from "react";
import { ParentSize } from "@visx/responsive";
import { scaleLinear } from "@visx/scale";
import { LinePath, Bar } from "@visx/shape";
import { AxisBottom, AxisLeft } from "@visx/axis";
import { Group } from "@visx/group";

import { useBasketStore } from "@/stores/basket-store";

interface PayoffPoint {
  x: number;
  y: number;
}

const MARGIN = { top: 20, right: 20, bottom: 40, left: 60 };

function computePayoff(
  legs: { strike: number; optionType: string; side: string; quantity: number; premium: number }[],
  spotRange: number[],
): PayoffPoint[] {
  return spotRange.map((spot) => {
    let pnl = 0;
    for (const leg of legs) {
      const isCall = leg.optionType === "C" || leg.optionType === "CE";
      const intrinsic = isCall
        ? Math.max(spot - leg.strike, 0)
        : Math.max(leg.strike - spot, 0);
      const legPnl = (intrinsic - leg.premium) * leg.quantity;
      pnl += leg.side === "BUY" ? legPnl : -legPnl;
    }
    return { x: spot, y: pnl };
  });
}

function PayoffChart({ width, height }: { width: number; height: number }) {
  const legs = useBasketStore((s) => s.legs);

  const data = useMemo(() => {
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
  }, [legs]);

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

  const zeroY = yScale(0);

  if (innerWidth <= 0 || innerHeight <= 0) return null;

  return (
    <svg width={width} height={height} className="bg-panel">
      <Group left={MARGIN.left} top={MARGIN.top}>
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
            fontSize: 10,
            textAnchor: "middle" as const,
          })}
          label="Underlying Price"
          labelProps={{
            fill: "#e0e0e0",
            fontSize: 11,
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
            fontSize: 10,
            textAnchor: "end" as const,
            dx: -4,
          })}
          label="P&L"
          labelProps={{
            fill: "#e0e0e0",
            fontSize: 11,
            textAnchor: "middle",
          }}
          numTicks={6}
        />
      </Group>
    </svg>
  );
}

export function PayoffDiagram() {
  return (
    <div className="h-full w-full bg-panel text-panel-muted">
      <ParentSize>
        {({ width, height }) => (
          <PayoffChart width={width} height={height} />
        )}
      </ParentSize>
    </div>
  );
}
