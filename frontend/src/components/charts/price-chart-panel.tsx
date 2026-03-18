"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  type IChartApi,
  type CandlestickData,
  type Time,
  CandlestickSeries,
  ColorType,
} from "lightweight-charts";

import { useMarketDataStore } from "@/stores/market-data-store";

export function PriceChartPanel() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null);

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
      crosshair: {
        mode: 0,
      },
      rightPriceScale: {
        borderColor: "#2a2a4a",
      },
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

    const unsubscribe = useMarketDataStore.subscribe((state) => {
      const underlying = state.selectedUnderlying;
      if (!underlying) return;

      const tick = state.ticks.get(underlying);
      if (!tick || !seriesRef.current) return;

      const time = (Math.floor(
        new Date(tick.timestamp).getTime() / 1000,
      )) as Time;

      const candleUpdate: CandlestickData<Time> = {
        time,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
      };

      seriesRef.current.update(candleUpdate);
    });

    return () => {
      unsubscribe();
      resizeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  return (
    <div className="h-full w-full bg-panel">
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
