"use client";

import { Button } from "@/components/ui/button";
import { useLayoutStore, hasPanelInLayout } from "@/stores/layout-store";
import { PANEL_IDS, PANEL_TITLES } from "@/types/panels";

export function PanelVisibilityBar() {
  const layout = useLayoutStore((s) => s.layout);
  const floatingPanels = useLayoutStore((s) => s.floatingPanels);
  const togglePanelVisibility = useLayoutStore((s) => s.togglePanelVisibility);

  return (
    <div className="flex shrink-0 items-center justify-end gap-1.5 overflow-x-auto border-b border-panel-border bg-panel px-3 py-1.5 scrollbar-none">
      {PANEL_IDS.map((panelId) => {
        const isVisible =
          hasPanelInLayout(layout, panelId) ||
          floatingPanels.some((panel) => panel.id === panelId);

        return (
          <Button
            key={panelId}
            type="button"
            variant="outline"
            size="xs"
            onClick={() => togglePanelVisibility(panelId)}
            className={
              isVisible
                ? "border-blue-500/50 bg-blue-500/15 text-blue-400 hover:bg-blue-500/20 hover:text-blue-300"
                : "border-panel-border bg-panel-header text-panel-faint hover:bg-panel hover:text-panel-muted"
            }
          >
            {PANEL_TITLES[panelId]}
          </Button>
        );
      })}
    </div>
  );
}
