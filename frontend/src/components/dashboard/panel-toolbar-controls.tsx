"use client";

import { useCallback, useContext } from "react";
import {
  MosaicContext,
  MosaicWindowContext,
  createRemoveUpdate,
  updateTree,
} from "react-mosaic-component";
import type { MosaicNode } from "react-mosaic-component";
import { X, ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { PanelId } from "@/types/panels";
import { useLayoutStore } from "@/stores/layout-store";

interface PanelToolbarControlsProps {
  panelId: PanelId;
}

export function PanelToolbarControls({ panelId }: PanelToolbarControlsProps) {
  const { mosaicActions } = useContext(MosaicContext);
  const { mosaicWindowActions } = useContext(MosaicWindowContext);
  const addFloatingPanel = useLayoutStore((s) => s.addFloatingPanel);

  const handleClose = useCallback(() => {
    const path = mosaicWindowActions.getPath();
    const update = createRemoveUpdate(
      mosaicActions.getRoot() as MosaicNode<PanelId>,
      path,
    );
    const newRoot = updateTree(
      mosaicActions.getRoot() as MosaicNode<PanelId>,
      [update],
    );
    mosaicActions.replaceWith([], newRoot);
  }, [mosaicActions, mosaicWindowActions]);

  const handleUndock = useCallback(() => {
    // Add as floating panel at a centered position
    addFloatingPanel({
      id: panelId,
      x: Math.round(window.innerWidth / 2 - 400),
      y: Math.round(window.innerHeight / 2 - 300),
      width: 800,
      height: 600,
    });

    // Remove from mosaic layout
    handleClose();
  }, [panelId, addFloatingPanel, handleClose]);

  return (
    <div className="flex items-center gap-0.5">
      <Button
        onClick={handleUndock}
        variant="ghost"
        size="icon-xs"
        className="text-panel-faint hover:bg-panel hover:text-panel-muted"
        title="Undock panel"
      >
        <ExternalLink size={12} />
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
  );
}
