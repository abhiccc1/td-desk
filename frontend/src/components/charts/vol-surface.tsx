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

function daysToExpiry(expiryStr: string): number {
  const now = Date.now();
  const exp = new Date(expiryStr + "T15:30:00+05:30").getTime();
  return Math.max(1, Math.ceil((exp - now) / 86400_000));
}

// ─── Shared grid builder ────────────────────────────────────────────

function buildGrid(
  sviSurface: SviParams[],
  spot: number,
): VolSurfaceGridData | null {
  if (!sviSurface.length || spot <= 0) return null;

  const strikeMin = Math.round(spot * 0.9);
  const strikeMax = Math.round(spot * 1.1);
  const strikeStep = Math.max(50, Math.round((strikeMax - strikeMin) / 40));
  const strikes: number[] = [];
  for (let s = strikeMin; s <= strikeMax; s += strikeStep) strikes.push(s);

  const expiries = sviSurface
    .map((s) => s.expiry)
    .filter((e) => daysToExpiry(e) > 0)
    .sort();

  const dtes = expiries.map(daysToExpiry);

  const ivs: (number | null)[][] = [];
  let minIv = Infinity;
  let maxIv = -Infinity;

  for (const expiry of expiries) {
    const svi = sviSurface.find((s) => s.expiry === expiry);
    const dte = daysToExpiry(expiry);
    const t = Math.max(dte / 365, 1e-6);
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

    const margin = { top: 10, right: 10, bottom: 35, left: 55 };
    const innerW = width - margin.left - margin.right;
    const innerH = height - margin.top - margin.bottom;

    const cellW = innerW / strikes.length;
    const cellH = innerH / expiries.length;

    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(0, 0, width, height);

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

  return (
    <div className="flex h-full flex-col bg-[#1a1a2e]">
      <div className="shrink-0 border-b border-[#2a2a4a] px-3 py-1.5 flex items-center gap-2">
        <span className="text-[10px] text-[#808090]">
          {underlying || "\u2014"} — Volatility Surface
          {grid && (
            <span className="ml-1">
              ({grid.expiries.length} expiries × {grid.strikes.length} strikes)
            </span>
          )}
        </span>
        <div className="ml-auto flex rounded border border-[#2a2a4a] text-[10px] overflow-hidden">
          <button
            className={`px-2 py-0.5 transition-colors ${
              mode === "2d"
                ? "bg-[#2a2a4a] text-white"
                : "text-[#808090] hover:text-white"
            }`}
            onClick={() => setMode("2d")}
          >
            2D
          </button>
          <button
            className={`px-2 py-0.5 transition-colors ${
              mode === "3d"
                ? "bg-[#2a2a4a] text-white"
                : "text-[#808090] hover:text-white"
            }`}
            onClick={() => setMode("3d")}
          >
            3D
          </button>
        </div>
      </div>

      {grid ? (
        mode === "2d" ? (
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
        <div className="flex min-h-0 flex-1 items-center justify-center text-xs text-[#606070]">
          No surface data
        </div>
      )}
    </div>
  );
}
