"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  createChart,
  type IChartApi,
  type CandlestickData,
  type Time,
  CandlestickSeries,
  ColorType,
} from "lightweight-charts";

import { useMarketDataStore } from "@/stores/market-data-store";

type Interval = "1m" | "5m";
const INTERVAL_SECONDS: Record<Interval, number> = { "1m": 60, "5m": 300 };
const MAX_TICK_BUFFER = 50_000;

interface RawTick {
  ltp: number;
  timestampSec: number;
}

function buildCandles(
  ticks: RawTick[],
  intervalSec: number,
): CandlestickData<Time>[] {
  const map = new Map<number, CandlestickData<Time>>();
  for (const t of ticks) {
    const bucket = (Math.floor(t.timestampSec / intervalSec) * intervalSec) as Time;
    const existing = map.get(bucket as number);
    if (existing) {
      if (t.ltp > existing.high) existing.high = t.ltp;
      if (t.ltp < existing.low) existing.low = t.ltp;
      existing.close = t.ltp;
    } else {
      map.set(bucket as number, {
        time: bucket,
        open: t.ltp,
        high: t.ltp,
        low: t.ltp,
        close: t.ltp,
      });
    }
  }
  return [...map.values()].sort((a, b) => (a.time as number) - (b.time as number));
}

export function PriceChartPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null);
  const tickBufferRef = useRef<RawTick[]>([]);
  const candleMapRef = useRef<Map<number, CandlestickData<Time>>>(new Map());
  const prevUnderlyingRef = useRef<string>("");
  const lastProcessedTsRef = useRef<string>("");
  const hasTicksRef = useRef(false);

  const [interval, setInterval] = useState<Interval>("1m");
  const [hasTicks, setHasTicks] = useState(false);
  const underlying = useMarketDataStore((s) => s.selectedUnderlying);

  // Create chart once
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const chart = createChart(container, {
      layout: {
        background: { type: ColorType.Solid, color: "#1a1a2e" },
        textColor: "#e0e0e0",
      },
      grid: {
        vertLines: { color: "#2a2a4a" },
        horzLines: { color: "#2a2a4a" },
      },
      crosshair: { mode: 0 },
      rightPriceScale: { borderColor: "#2a2a4a" },
      timeScale: {
        borderColor: "#2a2a4a",
        timeVisible: true,
        secondsVisible: false,
      },
      width: container.clientWidth,
      height: container.clientHeight,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#4ade80",
      downColor: "#f87171",
      borderDownColor: "#f87171",
      borderUpColor: "#4ade80",
      wickDownColor: "#f87171",
      wickUpColor: "#4ade80",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        chart.applyOptions({ width, height });
      }
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Reset when underlying changes
  useEffect(() => {
    if (underlying !== prevUnderlyingRef.current) {
      prevUnderlyingRef.current = underlying;
      tickBufferRef.current = [];
      candleMapRef.current = new Map();
      lastProcessedTsRef.current = "";
      hasTicksRef.current = false;
      setHasTicks(false);
      if (seriesRef.current) {
        seriesRef.current.setData([]);
      }
    }
  }, [underlying]);

  // Re-aggregate when interval changes
  const handleIntervalChange = useCallback(
    (newInterval: Interval) => {
      setInterval(newInterval);
      const candles = buildCandles(
        tickBufferRef.current,
        INTERVAL_SECONDS[newInterval],
      );
      candleMapRef.current = new Map(
        candles.map((c) => [c.time as number, c]),
      );
      if (seriesRef.current) {
        seriesRef.current.setData(candles);
      }
    },
    [],
  );

  // Subscribe to tick updates and aggregate candles
  useEffect(() => {
    const intervalSec = INTERVAL_SECONDS[interval];

    const unsubscribe = useMarketDataStore.subscribe((state) => {
      if (!underlying) return;

      const tick = state.ticks.get(underlying);
      if (!tick || !seriesRef.current) return;

      // Deduplicate: skip if we already processed this exact tick
      const tsKey = `${tick.timestamp}:${tick.ltp}`;
      if (tsKey === lastProcessedTsRef.current) return;
      lastProcessedTsRef.current = tsKey;

      const timestampSec = Math.floor(
        new Date(tick.timestamp).getTime() / 1000,
      );
      if (!Number.isFinite(timestampSec) || timestampSec <= 0) return;

      // Buffer raw tick
      const buffer = tickBufferRef.current;
      buffer.push({ ltp: tick.ltp, timestampSec });
      if (buffer.length > MAX_TICK_BUFFER) {
        buffer.splice(0, buffer.length - MAX_TICK_BUFFER);
      }

      if (!hasTicksRef.current) {
        hasTicksRef.current = true;
        setHasTicks(true);
      }

      // Aggregate into candle
      const bucketKey = Math.floor(timestampSec / intervalSec) * intervalSec;
      const bucketTime = bucketKey as Time;
      const map = candleMapRef.current;
      const existing = map.get(bucketKey);

      if (existing) {
        if (tick.ltp > existing.high) existing.high = tick.ltp;
        if (tick.ltp < existing.low) existing.low = tick.ltp;
        existing.close = tick.ltp;
        seriesRef.current.update(existing);
      } else {
        const candle: CandlestickData<Time> = {
          time: bucketTime,
          open: tick.ltp,
          high: tick.ltp,
          low: tick.ltp,
          close: tick.ltp,
        };
        map.set(bucketKey, candle);
        seriesRef.current.update(candle);
      }
    });

    return unsubscribe;
  }, [underlying, interval]);

  return (
    <div className="flex h-full w-full flex-col bg-panel">
      {/* Header bar */}
      <div className="flex items-center gap-3 border-b border-white/10 px-3 py-1.5">
        <span className="text-xs font-medium text-white/70">
          {underlying || "—"}
        </span>
        <div className="flex gap-1">
          {(["1m", "5m"] as Interval[]).map((iv) => (
            <button
              key={iv}
              onClick={() => handleIntervalChange(iv)}
              className={`rounded px-2 py-0.5 text-[11px] font-medium transition-colors ${
                interval === iv
                  ? "bg-white/15 text-white"
                  : "text-white/40 hover:text-white/60"
              }`}
            >
              {iv}
            </button>
          ))}
        </div>
      </div>

      {/* Chart container */}
      <div className="relative flex-1">
        <div ref={containerRef} className="h-full w-full" />
        {!hasTicks && (
          <div className="absolute inset-0 flex items-center justify-center">
            <span className="text-xs text-white/30">
              Waiting for market data...
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
