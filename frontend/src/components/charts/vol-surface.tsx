"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  Suspense,
  lazy,
} from "react";

import { daysToExpiryFor, timeToExpiryYears } from "@/lib/instruments";
import { useMarketDataStore } from "@/stores/market-data-store";
import { getConfig } from "@/lib/config";
import type { SviParams } from "@/types/market-data";
import type { VolSurfaceGridData } from "./vol-surface-3d";

// Lazy-load the 3D component — Plotly GL bundle is ~800KB, only fetched on toggle
const VolSurface3D = lazy(() =>
  import("./vol-surface-3d").then((m) => ({ default: m.VolSurface3D })),
);

// ─── Shared helpers ─────────────────────────────────────────────────

function sviIvAt(
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

function ivToColor(iv: number, minIv: number, maxIv: number): string {
  const range = maxIv - minIv || 1;
  const t = Math.max(0, Math.min(1, (iv - minIv) / range));

  let r: number, g: number, b: number;
  if (t < 0.33) {
    const s = t / 0.33;
    r = 30;
    g = Math.round(80 + 120 * s);
    b = Math.round(200 * (1 - s));
  } else if (t < 0.66) {
    const s = (t - 0.33) / 0.33;
    r = Math.round(220 * s);
    g = 200;
    b = 0;
  } else {
    const s = (t - 0.66) / 0.34;
    r = 220;
    g = Math.round(200 * (1 - s));
    b = 0;
  }
  return `rgb(${r},${g},${b})`;
}

function daysToExpiry(expiryStr: string, underlying?: string): number {
  return daysToExpiryFor(underlying, expiryStr);
}

// ─── Shared grid builder ────────────────────────────────────────────

function buildGrid(
  sviSurface: SviParams[],
  spot: number,
): VolSurfaceGridData | null {
  if (!sviSurface.length || spot <= 0) return null;
  const underlying = sviSurface[0].underlying;

  const strikeMin = Math.round(spot * 0.9);
  const strikeMax = Math.round(spot * 1.1);
  // ~40 columns across ±10%; the old 50-point floor left NATURALGAS (~300)
  // with two strikes. Index spots are large enough that this is unchanged.
  const strikeStep = Math.max(1, Math.round((strikeMax - strikeMin) / 40));
  const strikes: number[] = [];
  for (let s = strikeMin; s <= strikeMax; s += strikeStep) strikes.push(s);

  const expiries = sviSurface
    .map((s) => s.expiry)
    .filter((e) => daysToExpiry(e, underlying) > 0)
    .sort();

  const dtes = expiries.map((e) => daysToExpiry(e, underlying));

  const ivs: (number | null)[][] = [];
  let minIv = Infinity;
  let maxIv = -Infinity;

  for (const expiry of expiries) {
    const svi = sviSurface.find((s) => s.expiry === expiry);
    // Continuous T with the same expiry close as the quant service's SVI fit
    const t = timeToExpiryYears(underlying, expiry);
    const row: (number | null)[] = [];
    for (const strike of strikes) {
      const iv = svi ? sviIvAt(svi, strike, spot, t) : null;
      row.push(iv);
      if (iv !== null) {
        if (iv < minIv) minIv = iv;
        if (iv > maxIv) maxIv = iv;
      }
    }
    ivs.push(row);
  }

  return { strikes, expiries, dtes, ivs, minIv, maxIv };
}

// ─── 2D Canvas Heatmap ─────────────────────────────────────────────

function Heatmap2D({
  grid,
  spot,
}: {
  grid: VolSurfaceGridData;
  spot: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const { strikes, expiries, ivs, minIv, maxIv } = grid;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const dpr = window.devicePixelRatio || 1;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, width, height);

    // ── Single-expiry: render as IV smile line chart ──
    if (expiries.length === 1) {
      const margin = { top: 30, right: 15, bottom: 40, left: 55 };
      const innerW = width - margin.left - margin.right;
      const innerH = height - margin.top - margin.bottom;
      const row = ivs[0];
      const validIvs = row.filter((v): v is number => v !== null);
      if (validIvs.length === 0) return;
      const lo = Math.min(...validIvs) * 0.9;
      const hi = Math.max(...validIvs) * 1.1;
      const range = hi - lo || 1;

      const xOf = (i: number) => margin.left + (i / (strikes.length - 1)) * innerW;
      const yOf = (iv: number) => margin.top + (1 - (iv - lo) / range) * innerH;

      // Gradient fill under curve
      const gradient = ctx.createLinearGradient(0, margin.top, 0, margin.top + innerH);
      gradient.addColorStop(0, "rgba(96,165,250,0.25)");
      gradient.addColorStop(1, "rgba(96,165,250,0.02)");
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < row.length; i++) {
        if (row[i] === null) continue;
        const x = xOf(i), y = yOf(row[i]!);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      // Close to bottom for fill
      for (let i = row.length - 1; i >= 0; i--) {
        if (row[i] !== null) { ctx.lineTo(xOf(i), margin.top + innerH); break; }
      }
      for (let i = 0; i < row.length; i++) {
        if (row[i] !== null) { ctx.lineTo(xOf(i), margin.top + innerH); break; }
      }
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // IV line
      ctx.beginPath();
      started = false;
      for (let i = 0; i < row.length; i++) {
        if (row[i] === null) continue;
        const x = xOf(i), y = yOf(row[i]!);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#60a5fa";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Color dots at each strike
      for (let i = 0; i < row.length; i++) {
        if (row[i] === null) continue;
        ctx.beginPath();
        ctx.arc(xOf(i), yOf(row[i]!), 3, 0, Math.PI * 2);
        ctx.fillStyle = ivToColor(row[i]!, minIv, maxIv);
        ctx.fill();
      }

      // Spot marker
      if (spot > 0 && spot >= strikes[0] && spot <= strikes[strikes.length - 1]) {
        const spotFrac = (spot - strikes[0]) / (strikes[strikes.length - 1] - strikes[0]);
        const spotX = margin.left + spotFrac * innerW;
        ctx.strokeStyle = "rgba(250,204,21,0.6)";
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(spotX, margin.top);
        ctx.lineTo(spotX, margin.top + innerH);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Y-axis labels (IV%)
      ctx.fillStyle = "#808090";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const yTicks = 5;
      for (let j = 0; j <= yTicks; j++) {
        const iv = lo + (range * j) / yTicks;
        const y = yOf(iv);
        ctx.fillText(`${iv.toFixed(0)}%`, margin.left - 6, y);
        // grid line
        ctx.strokeStyle = "rgba(128,128,144,0.15)";
        ctx.beginPath();
        ctx.moveTo(margin.left, y);
        ctx.lineTo(margin.left + innerW, y);
        ctx.stroke();
      }

      // X-axis labels (strikes)
      ctx.fillStyle = "#808090";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      const xStep = Math.max(1, Math.floor(strikes.length / 8));
      for (let i = 0; i < strikes.length; i += xStep) {
        ctx.fillText(String(strikes[i]), xOf(i), margin.top + innerH + 4);
      }

      // Title
      ctx.fillStyle = "#606070";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "left";
      const dte = daysToExpiry(expiries[0]);
      ctx.fillText(`IV Smile — ${expiries[0]} (${dte}d)`, margin.left, 12);
      return;
    }

    // ── Multi-expiry: standard heatmap ──
    const margin = { top: 10, right: 10, bottom: 35, left: 55 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const cellW = innerW / strikes.length;
    const cellH = innerH / expiries.length;

    for (let row = 0; row < expiries.length; row++) {
      for (let col = 0; col < strikes.length; col++) {
        const iv = ivs[row][col];
        if (iv === null) continue;
        ctx.fillStyle = ivToColor(iv, minIv, maxIv);
        ctx.globalAlpha = 0.85;
        ctx.fillRect(
          margin.left + col * cellW,
          margin.top + row * cellH,
          cellW - 1,
          cellH - 1,
        );

        if (cellW > 30 && cellH > 16) {
          ctx.globalAlpha = 1;
          ctx.fillStyle = "#000";
          ctx.font = "9px sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            iv.toFixed(0),
            margin.left + col * cellW + cellW / 2,
            margin.top + row * cellH + cellH / 2,
          );
        }
      }
    }
    ctx.globalAlpha = 1;

    ctx.fillStyle = "#808090";
    ctx.font = "9px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xLabelStep = Math.max(1, Math.floor(strikes.length / 8));
    for (let i = 0; i < strikes.length; i += xLabelStep) {
      ctx.fillText(
        String(strikes[i]),
        margin.left + i * cellW + cellW / 2,
        margin.top + innerH + 4,
      );
    }

    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (let row = 0; row < expiries.length; row++) {
      const dte = daysToExpiry(expiries[row]);
      const label = dte <= 7 ? `${dte}d` : `${Math.round(dte / 7)}w`;
      ctx.fillText(
        label,
        margin.left - 6,
        margin.top + row * cellH + cellH / 2,
      );
    }

    ctx.fillStyle = "#606070";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("Strike", margin.left + innerW / 2, height - 4);
    ctx.save();
    ctx.translate(10, margin.top + innerH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Expiry", 0, 0);
    ctx.restore();

    if (spot > 0) {
      const spotIdx =
        ((spot - strikes[0]) / (strikes[strikes.length - 1] - strikes[0])) *
        innerW;
      if (spotIdx > 0 && spotIdx < innerW) {
        ctx.strokeStyle = "rgba(250,204,21,0.5)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(margin.left + spotIdx, margin.top);
        ctx.lineTo(margin.left + spotIdx, margin.top + innerH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [grid, spot]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div ref={containerRef} className="min-h-0 flex-1">
      <canvas ref={canvasRef} />
    </div>
  );
}

// ─── Main component with 2D/3D toggle ──────────────────────────────

export function VolSurface() {
  const underlying = useMarketDataStore((s) => s.selectedUnderlying);
  const spot = useMarketDataStore(
    (s) => s.optionChain?.underlyingPrice ?? 0,
  );

  const [sviSurface, setSviSurface] = useState<SviParams[]>([]);
  const [mode, setMode] = useState<"2d" | "3d">("2d");

  // Fetch SVI params for all expiries
  useEffect(() => {
    if (!underlying) return;
    let cancelled = false;
    async function load() {
      try {
        const { apiUrl } = getConfig();
        const resp = await fetch(
          `${apiUrl}/api/v1/svi-surface/${encodeURIComponent(underlying)}`,
        );
        if (resp.ok) {
          const data = await resp.json();
          if (!cancelled && Array.isArray(data)) setSviSurface(data);
        }
      } catch {
        /* ignore */
      }
    }
    load();
    const interval = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [underlying]);

  const grid = useMemo(() => buildGrid(sviSurface, spot), [sviSurface, spot]);
  const can3d = grid != null && grid.expiries.length >= 2;

  // Auto-fallback to 2D if 3D selected but not enough expiries
  const effectiveMode = mode === "3d" && !can3d ? "2d" : mode;

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-1.5 flex items-center gap-2">
        <span className="text-[10px] text-[#808090]">
          {underlying || "\u2014"} — Volatility Surface
          {grid && (
            <span className="ml-1">
              ({grid.expiries.length} expir{grid.expiries.length === 1 ? "y" : "ies"} × {grid.strikes.length} strikes)
            </span>
          )}
        </span>
        <div className="ml-auto flex rounded border border-[#2a2a4a] text-[10px] overflow-hidden">
          <button
            className={`px-2 py-0.5 transition-colors ${
              effectiveMode === "2d"
                ? "bg-[#2a2a4a] text-white"
                : "text-[#808090] hover:text-white"
            }`}
            onClick={() => setMode("2d")}
          >
            2D
          </button>
          <button
            disabled={!can3d}
            title={can3d ? "3D Surface" : "Need 2+ expiries for 3D"}
            className={`px-2 py-0.5 transition-colors ${
              effectiveMode === "3d"
                ? "bg-[#2a2a4a] text-white"
                : can3d
                  ? "text-[#808090] hover:text-white"
                  : "text-[#404050] cursor-not-allowed"
            }`}
            onClick={() => can3d && setMode("3d")}
          >
            3D
          </button>
        </div>
      </div>

      {grid ? (
        effectiveMode === "2d" ? (
          <Heatmap2D grid={grid} spot={spot} />
        ) : (
          <div className="min-h-0 flex-1">
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-xs text-[#808090]">
                  Loading 3D surface...
                </div>
              }
            >
              <VolSurface3D
                grid={grid}
                spot={spot}
                underlying={underlying}
              />
            </Suspense>
          </div>
        )
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-panel-subtle">
          No surface data
        </div>
      )}
    </div>
  );
}
