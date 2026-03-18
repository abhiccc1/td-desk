"use client";

import { useCallback, useRef } from "react";
import { X, Pin } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useLayoutStore, type FloatingPanel as FloatingPanelData } from "@/stores/layout-store";
import { PANEL_TITLES } from "@/types/panels";
import { renderPanelContent } from "./panel-registry";

interface FloatingPanelProps {
  panel: FloatingPanelData;
}

export function FloatingPanel({ panel }: FloatingPanelProps) {
  const updateFloatingPanel = useLayoutStore((s) => s.updateFloatingPanel);
  const removeFloatingPanel = useLayoutStore((s) => s.removeFloatingPanel);
  const bringToFront = useLayoutStore((s) => s.bringToFront);
  const dockPanel = useLayoutStore((s) => s.dockPanel);

  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const resizeRef = useRef<{ startX: number; startY: number; origW: number; origH: number } | null>(null);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      bringToFront(panel.id);
      dragRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origX: panel.x,
        origY: panel.y,
      };

      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const dx = ev.clientX - dragRef.current.startX;
        const dy = ev.clientY - dragRef.current.startY;
        updateFloatingPanel(panel.id, {
          x: dragRef.current.origX + dx,
          y: dragRef.current.origY + dy,
        });
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.id, panel.x, panel.y, updateFloatingPanel, bringToFront],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      bringToFront(panel.id);
      resizeRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        origW: panel.width,
        origH: panel.height,
      };

      const onMove = (ev: MouseEvent) => {
        if (!resizeRef.current) return;
        const dx = ev.clientX - resizeRef.current.startX;
        const dy = ev.clientY - resizeRef.current.startY;
        updateFloatingPanel(panel.id, {
          width: Math.max(300, resizeRef.current.origW + dx),
          height: Math.max(200, resizeRef.current.origH + dy),
        });
      };
      const onUp = () => {
        resizeRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [panel.id, panel.width, panel.height, updateFloatingPanel, bringToFront],
  );

  const handleClose = useCallback(() => {
    removeFloatingPanel(panel.id);
  }, [panel.id, removeFloatingPanel]);

  const handleDock = useCallback(() => {
    dockPanel(panel.id);
  }, [panel.id, dockPanel]);

  return (
    <div
      className="fixed flex flex-col overflow-hidden rounded-sm border border-panel-border bg-panel shadow-2xl shadow-black/60"
      style={{
        left: panel.x,
        top: panel.y,
        width: panel.width,
        height: panel.height,
        zIndex: 1000,
      }}
      onMouseDown={() => bringToFront(panel.id)}
    >
      {/* Title bar — draggable */}
      <div
        className="flex cursor-grab items-center justify-between border-b border-panel-border bg-panel-header px-3 py-1.5 active:cursor-grabbing"
        onMouseDown={handleDragStart}
      >
        <span className="select-none text-xs font-semibold text-panel-muted">
          {PANEL_TITLES[panel.id]}
        </span>
        <div className="flex items-center gap-0.5">
          <Button
            onClick={handleDock}
            variant="ghost"
            size="icon-xs"
            className="text-panel-faint hover:bg-panel hover:text-panel-muted"
            title="Dock panel"
          >
            <Pin size={12} />
          </Button>
          <Button
            onClick={handleClose}
            variant="ghost"
            size="icon-xs"
            className="text-panel-faint hover:bg-red-900/50 hover:text-red-400"
            title="Close panel"
          >
            <X size={12} />
          </Button>
        </div>
      </div>

      {/* Panel content */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {renderPanelContent(panel.id)}
      </div>

      {/* Resize handle — bottom-right corner */}
      <div
        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize"
        onMouseDown={handleResizeStart}
      >
        <svg
          className="h-3 w-3 text-panel-faint"
          viewBox="0 0 12 12"
          fill="currentColor"
        >
          <circle cx="9" cy="9" r="1.5" />
          <circle cx="5" cy="9" r="1.5" />
          <circle cx="9" cy="5" r="1.5" />
        </svg>
      </div>
    </div>
  );
}
