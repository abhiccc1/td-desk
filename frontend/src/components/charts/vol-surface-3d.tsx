"use client";

import { useRef, useMemo, useCallback } from "react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-gl3d-dist-min";

const Plot = createPlotlyComponent(Plotly);

export interface VolSurfaceGridData {
  strikes: number[];
  expiries: string[];
  dtes: number[];
  ivs: (number | null)[][];
  minIv: number;
  maxIv: number;
}

interface Props {
  grid: VolSurfaceGridData;
  spot: number;
  underlying: string;
}

const INITIAL_LAYOUT: Partial<Plotly.Layout> = {
  autosize: true,
  uirevision: "persist",
  paper_bgcolor: "#1a1a2e",
  plot_bgcolor: "#1a1a2e",
  margin: { l: 0, r: 0, t: 0, b: 0, pad: 0 },
  scene: {
    xaxis: {
      title: { text: "Strike", font: { color: "#808090", size: 10 } },
      color: "#808090",
      gridcolor: "rgba(255,255,255,0.06)",
      backgroundcolor: "#1a1a2e",
      tickfont: { size: 9, color: "#808090" },
    },
    yaxis: {
      title: { text: "DTE", font: { color: "#808090", size: 10 } },
      color: "#808090",
      gridcolor: "rgba(255,255,255,0.06)",
      backgroundcolor: "#1a1a2e",
      tickfont: { size: 9, color: "#808090" },
    },
    zaxis: {
      title: { text: "IV %", font: { color: "#808090", size: 10 } },
      color: "#808090",
      gridcolor: "rgba(255,255,255,0.06)",
      backgroundcolor: "#1a1a2e",
      tickfont: { size: 9, color: "#808090" },
    },
    camera: {
      eye: { x: 1.6, y: -1.8, z: 0.9 },
      center: { x: 0, y: 0, z: -0.15 },
    },
    aspectratio: { x: 1.2, y: 1, z: 0.6 },
  },
};

export function VolSurface3D({ grid, spot, underlying }: Props) {
  void spot;
  void underlying;

  const plotRef = useRef<{ el: HTMLElement } | null>(null);

  const data = useMemo<Plotly.Data[]>(() => {
    const { strikes, dtes, ivs, minIv, maxIv } = grid;
    const zData = ivs.map((row) => row.map((v) => (v === null ? NaN : v)));

    return [
      {
        type: "surface" as const,
        x: strikes,
        y: dtes,
        z: zData,
        colorscale: [
          [0, "rgb(30,80,200)"],
          [0.25, "rgb(30,180,120)"],
          [0.5, "rgb(120,200,0)"],
          [0.75, "rgb(220,200,0)"],
          [1, "rgb(220,50,0)"],
        ],
        cmin: minIv,
        cmax: maxIv,
        colorbar: {
          title: { text: "IV %", font: { color: "#808090", size: 10 } },
          tickfont: { color: "#808090", size: 9 },
          bgcolor: "rgba(0,0,0,0)",
          borderwidth: 0,
          len: 0.6,
          thickness: 12,
        },
        hovertemplate:
          "Strike: %{x}<br>DTE: %{y}d<br>IV: %{z:.1f}%<extra></extra>",
        lighting: {
          ambient: 0.6,
          diffuse: 0.5,
          specular: 0.2,
          roughness: 0.5,
        },
        contours: {
          z: {
            show: true,
            usecolormap: true,
            highlightcolor: "rgba(255,255,255,0.15)",
            project: { z: false },
          },
        },
      } as Plotly.Data,
    ];
  }, [grid]);

  // Use Plotly.react directly for data updates — this preserves camera state
  // because we only update data traces, not the layout.
  const onInitialized = useCallback((_: unknown, graphDiv: HTMLElement) => {
    plotRef.current = { el: graphDiv };
  }, []);

  const onUpdate = useCallback((_: unknown, graphDiv: HTMLElement) => {
    plotRef.current = { el: graphDiv };
  }, []);

  // revision counter forces Plotly to call react() instead of newPlot()
  const revision = useMemo(() => {
    return grid.strikes.length + grid.expiries.length;
  }, [grid]);

  return (
    <Plot
      data={data}
      layout={INITIAL_LAYOUT}
      revision={revision}
      onInitialized={onInitialized}
      onUpdate={onUpdate}
      config={{
        displayModeBar: true,
        displaylogo: false,
        modeBarButtonsToRemove: ["toImage", "sendDataToCloud"],
        responsive: true,
        scrollZoom: true,
      }}
      useResizeHandler
      style={{ width: "100%", height: "100%" }}
    />
  );
}
