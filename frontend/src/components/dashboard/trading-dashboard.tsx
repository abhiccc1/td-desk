"use client";

import { useCallback } from "react";
import { Mosaic, MosaicWindow } from "react-mosaic-component";
import type { MosaicNode } from "react-mosaic-component";
import "react-mosaic-component/react-mosaic-component.css";

import { useLiveData } from "@/hooks/use-live-data";
import { useLayoutStore } from "@/stores/layout-store";
import { PANEL_TITLES, type PanelId } from "@/types/panels";
import { renderPanelContent } from "./panel-registry";
import { PanelToolbarControls } from "./panel-toolbar-controls";
import { FloatingPanel } from "./floating-panel";
import { GlobalToolbar } from "./global-toolbar";
import { PanelVisibilityBar } from "./panel-visibility-bar";

interface Props {
  onOpenSettings?: () => void;
  onSwitchAccount?: () => void;
  activeUcc?: string;
}

export default function TradingDashboard({ onOpenSettings, onSwitchAccount, activeUcc }: Props) {
  useLiveData();
  const layout = useLayoutStore((s) => s.layout);
  const setLayout = useLayoutStore((s) => s.setLayout);
  const floatingPanels = useLayoutStore((s) => s.floatingPanels);
  const showPanelBar = useLayoutStore((s) => s.showPanelBar);

  const renderTile = useCallback(
    (id: PanelId, path: number[]) => (
      <MosaicWindow<PanelId>
        path={path}
        title={PANEL_TITLES[id]}
        toolbarControls={<PanelToolbarControls panelId={id} />}
      >
        <div className="flex h-full w-full flex-col overflow-hidden">
          {renderPanelContent(id)}
        </div>
      </MosaicWindow>
    ),
    [],
  );

  const handleChange = useCallback(
    (newLayout: MosaicNode<PanelId> | null) => {
      setLayout(newLayout);
    },
    [setLayout],
  );

  return (
    <>
      <style>{`
        .td-desk-mosaic {
          background: #1a1a2e !important;
        }
        .td-desk-mosaic .mosaic-window .mosaic-window-toolbar {
          background: #16213e;
          color: #e0e0e0;
          border-bottom: 1px solid #2a2a4a;
        }
        .td-desk-mosaic .mosaic-window .mosaic-window-toolbar .mosaic-window-title {
          color: #e0e0e0;
          font-weight: 600;
        }
        .td-desk-mosaic .mosaic-window .mosaic-window-body {
          background: #1a1a2e;
        }
        .td-desk-mosaic .mosaic-split.-row,
        .td-desk-mosaic .mosaic-split.-column {
          background: #2a2a4a;
        }
        .td-desk-mosaic .mosaic-tile {
          margin: 1px;
        }
        .td-desk-mosaic .mosaic-window {
          border: 1px solid #2a2a4a;
          border-radius: 4px;
          overflow: hidden;
        }
        /* AG Grid single-row header */
        .ag-header-center .ag-header-cell-label {
          justify-content: center !important;
        }
        .ag-header-call {
          background: rgba(59, 130, 246, 0.05) !important;
        }
        .ag-header-put {
          background: rgba(168, 85, 247, 0.05) !important;
        }
        .ag-header-strike .ag-header-cell-label {
          justify-content: center !important;
          font-weight: 700 !important;
          color: #facc15 !important;
        }
        .option-chain-grid .ag-cell {
          text-align: center !important;
        }
        .option-chain-grid .ag-cell-wrapper,
        .option-chain-grid .ag-cell-value,
        .option-chain-grid .ag-right-aligned-cell .ag-cell-value {
          justify-content: center !important;
          text-align: center !important;
          width: 100%;
        }
        .option-chain-grid .option-action-cell {
          background: rgba(59, 130, 246, 0.05) !important;
        }
        .option-chain-grid .ag-row-hover .option-action-cell {
          background: rgba(59, 130, 246, 0.15) !important;
        }
        .option-chain-grid .ag-row-hover .option-action-value {
          opacity: 0.18;
        }
        .option-chain-grid .ag-row-hover .option-action-buttons {
          opacity: 1;
        }
        .cell-leg-sell {
          background: rgba(239, 68, 68, 0.15) !important;
        }
        .cell-leg-buy {
          background: rgba(34, 197, 94, 0.15) !important;
        }
        .row-has-leg {
          background: rgba(59, 130, 246, 0.08) !important;
        }
        .row-itm-call {
          background: rgba(59, 130, 246, 0.03) !important;
        }
        .row-has-position {
          border-left: 3px solid rgba(250, 204, 21, 0.7) !important;
          background: rgba(250, 204, 21, 0.08) !important;
        }

        /* Spot-price divider row */
        .spot-divider-row {
          display: flex;
          align-items: center;
          width: 100%;
          height: 100%;
          padding: 0 8px;
        }
        .spot-divider-line {
          flex: 1;
          height: 1.5px;
          background: rgba(59, 130, 246, 0.5);
        }
        .spot-divider-pill {
          flex-shrink: 0;
          padding: 2px 16px;
          margin: 0 8px;
          border: 1.5px solid rgba(59, 130, 246, 0.5);
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          color: #93c5fd;
          white-space: nowrap;
          background: rgba(30, 58, 138, 0.3);
        }
        .spot-change-up { color: #4ade80; font-weight: 600; }
        .spot-change-down { color: #f87171; font-weight: 600; }
        /* Hide the full-width row background so it blends */
        .ag-full-width-row {
          background: transparent !important;
          border: none !important;
        }

        /* ── High-DPI / 4K scaling for order UI ── */
        @media (-webkit-min-device-pixel-ratio: 1.5), (min-resolution: 144dpi) {
          .order-leg-row {
            font-size: 16px;
            gap: 12px;
            padding: 6px 16px;
          }
          .order-drag-handle {
            font-size: 14px;
          }
          .order-side-pill {
            width: 72px;
            font-size: 14px;
            padding: 4px 8px;
          }
          .order-type-label {
            width: 40px;
            font-size: 14px;
          }
          .order-strike {
            width: 100px;
            font-size: 16px;
          }
          .order-premium-input,
          .order-premium-display {
            width: 140px;
            font-size: 16px;
            padding: 4px 8px;
          }
          .order-qty-input,
          .order-qty-display {
            width: 100px;
            font-size: 16px;
            padding: 4px 8px;
          }
          .order-qty-toggle {
            font-size: 12px;
            padding: 4px 10px;
          }
          .order-qty-indicator {
            font-size: 11px;
          }
          .order-type-select {
            font-size: 12px;
            padding: 4px 8px;
          }
          .order-remove-btn {
            font-size: 14px;
            padding: 4px 10px;
          }
          .order-template-bar {
            gap: 10px;
            padding: 10px 16px;
          }
          .order-template-chip {
            font-size: 14px;
            padding: 6px 16px;
          }
          .order-action-bar {
            gap: 10px;
            padding: 10px 16px;
          }
          .order-btn {
            font-size: 14px;
            padding: 6px 16px;
          }
          .order-collapsed-bar {
            font-size: 15px;
            padding: 0 16px;
          }
        }

        /* ── Ultra-high-DPI (2x+, true 4K at native) ── */
        @media (-webkit-min-device-pixel-ratio: 2), (min-resolution: 192dpi) {
          .order-leg-row {
            font-size: 18px;
            gap: 16px;
            padding: 8px 20px;
          }
          .order-drag-handle {
            font-size: 16px;
          }
          .order-side-pill {
            width: 84px;
            font-size: 16px;
            padding: 5px 10px;
          }
          .order-type-label {
            width: 48px;
            font-size: 16px;
          }
          .order-strike {
            width: 120px;
            font-size: 18px;
          }
          .order-premium-input,
          .order-premium-display {
            width: 180px;
            font-size: 18px;
            padding: 6px 10px;
          }
          .order-qty-input,
          .order-qty-display {
            width: 120px;
            font-size: 18px;
            padding: 6px 10px;
          }
          .order-qty-toggle {
            font-size: 14px;
            padding: 5px 12px;
          }
          .order-qty-indicator {
            font-size: 13px;
          }
          .order-type-select {
            font-size: 14px;
            padding: 5px 10px;
          }
          .order-remove-btn {
            font-size: 16px;
            padding: 6px 14px;
          }
          .order-template-bar {
            gap: 12px;
            padding: 12px 20px;
          }
          .order-template-chip {
            font-size: 16px;
            padding: 8px 20px;
          }
          .order-action-bar {
            gap: 12px;
            padding: 12px 20px;
          }
          .order-btn {
            font-size: 16px;
            padding: 8px 20px;
          }
          .order-collapsed-bar {
            font-size: 17px;
            padding: 0 20px;
          }
        }
      `}</style>
      <div className="flex h-screen w-screen flex-col bg-panel">
        <GlobalToolbar
          onOpenSettings={onOpenSettings}
          onSwitchAccount={onSwitchAccount}
          activeUcc={activeUcc}
        />
        {showPanelBar && <PanelVisibilityBar />}
        <div className="min-h-0 flex-1">
          <Mosaic<PanelId>
            className="td-desk-mosaic"
            value={layout}
            onChange={handleChange}
            renderTile={renderTile}
          />
        </div>
        {floatingPanels.map((panel) => (
          <FloatingPanel key={panel.id} panel={panel} />
        ))}
      </div>
    </>
  );
}
