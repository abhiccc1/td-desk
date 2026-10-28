import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { MosaicNode, MosaicSplitNode } from "react-mosaic-component";

import type { PanelId } from "@/types/panels";

function isSplitNode(node: MosaicNode<PanelId>): node is MosaicSplitNode<PanelId> {
  return typeof node === "object" && node !== null && "children" in node;
}

export interface FloatingPanel {
  id: PanelId;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface LayoutState {
  layout: MosaicNode<PanelId> | null;
  floatingPanels: FloatingPanel[];
  showPanelBar: boolean;
}

interface LayoutActions {
  setLayout: (layout: MosaicNode<PanelId> | null) => void;
  setRiskWorkspace: () => void;
  addFloatingPanel: (panel: FloatingPanel) => void;
  removeFloatingPanel: (id: PanelId) => void;
  updateFloatingPanel: (id: PanelId, patch: Partial<Omit<FloatingPanel, "id">>) => void;
  bringToFront: (id: PanelId) => void;
  dockPanel: (id: PanelId) => void;
  hidePanel: (id: PanelId) => void;
  togglePanelVisibility: (id: PanelId) => void;
  togglePanelBar: () => void;
  resetLayout: () => void;
}

export type LayoutStore = LayoutState & LayoutActions;

function removePanelFromLayout(
  layout: MosaicNode<PanelId> | null,
  panelId: PanelId,
): MosaicNode<PanelId> | null {
  if (!layout) return null;
  if (typeof layout === "string") {
    return layout === panelId ? null : layout;
  }
  if (!isSplitNode(layout)) return layout;

  const [left, right] = layout.children;
  const nextLeft = removePanelFromLayout(left, panelId);
  const nextRight = removePanelFromLayout(right, panelId);

  if (!nextLeft && !nextRight) return null;
  if (!nextLeft) return nextRight;
  if (!nextRight) return nextLeft;

  return {
    ...layout,
    children: [nextLeft, nextRight],
  };
}

export function hasPanelInLayout(
  layout: MosaicNode<PanelId> | null,
  panelId: PanelId,
): boolean {
  if (!layout) return false;
  if (typeof layout === "string") return layout === panelId;
  if (!isSplitNode(layout)) return false;
  return (
    hasPanelInLayout(layout.children[0], panelId) ||
    hasPanelInLayout(layout.children[1], panelId)
  );
}

function appendPanelToLayout(
  layout: MosaicNode<PanelId> | null,
  panelId: PanelId,
): MosaicNode<PanelId> {
  if (!layout) return panelId;
  return {
    type: "split",
    direction: "row",
    children: [layout, panelId],
    splitPercentages: [70, 30],
  };
}

export const DEFAULT_LAYOUT: MosaicNode<PanelId> = {
  type: "split",
  direction: "row",
  children: [
    "option-chain",
    {
      type: "split",
      direction: "column",
      children: ["positions", "iv-skew"],
      splitPercentages: [50, 50],
    },
  ],
  splitPercentages: [60, 40],
};

export const RISK_WORKSPACE_LAYOUT: MosaicNode<PanelId> = {
  type: "split",
  direction: "row",
  children: ["risk-management", "positions"],
  splitPercentages: [50, 50],
};

export const useLayoutStore = create<LayoutStore>()(
  persist(
    (set) => ({
      layout: DEFAULT_LAYOUT,
      floatingPanels: [],
      showPanelBar: false,

      setLayout: (layout: MosaicNode<PanelId> | null) => {
        set({ layout });
      },

      setRiskWorkspace: () => {
        set({ layout: RISK_WORKSPACE_LAYOUT, floatingPanels: [] });
      },

      addFloatingPanel: (panel: FloatingPanel) => {
        set((state) => ({
          floatingPanels: [
            ...state.floatingPanels.filter((p) => p.id !== panel.id),
            panel,
          ],
        }));
      },

      removeFloatingPanel: (id: PanelId) => {
        set((state) => ({
          floatingPanels: state.floatingPanels.filter((p) => p.id !== id),
        }));
      },

      updateFloatingPanel: (id: PanelId, patch: Partial<Omit<FloatingPanel, "id">>) => {
        set((state) => ({
          floatingPanels: state.floatingPanels.map((p) =>
            p.id === id ? { ...p, ...patch } : p,
          ),
        }));
      },

      bringToFront: (id: PanelId) => {
        set((state) => {
          const panel = state.floatingPanels.find((p) => p.id === id);
          if (!panel) return state;
          return {
            floatingPanels: [
              ...state.floatingPanels.filter((p) => p.id !== id),
              panel,
            ],
          };
        });
      },

      dockPanel: (id: PanelId) => {
        set((state) => {
          const layout = hasPanelInLayout(state.layout, id)
            ? state.layout
            : appendPanelToLayout(state.layout, id);

          return {
            layout,
            floatingPanels: state.floatingPanels.filter((p) => p.id !== id),
          };
        });
      },

      hidePanel: (id: PanelId) => {
        set((state) => ({
          layout: removePanelFromLayout(state.layout, id),
          floatingPanels: state.floatingPanels.filter((p) => p.id !== id),
        }));
      },

      togglePanelVisibility: (id: PanelId) => {
        set((state) => {
          const isVisible =
            hasPanelInLayout(state.layout, id) ||
            state.floatingPanels.some((p) => p.id === id);

          if (isVisible) {
            return {
              layout: removePanelFromLayout(state.layout, id),
              floatingPanels: state.floatingPanels.filter((p) => p.id !== id),
            };
          }

          return {
            layout: appendPanelToLayout(state.layout, id),
            floatingPanels: state.floatingPanels.filter((p) => p.id !== id),
          };
        });
      },

      togglePanelBar: () => {
        set((state) => ({ showPanelBar: !state.showPanelBar }));
      },

      resetLayout: () => {
        set({ layout: DEFAULT_LAYOUT, floatingPanels: [] });
      },
    }),
    {
      name: "td-desk-layout",
      merge: (persisted, current) => ({
        ...current,
        ...(persisted as Partial<LayoutStore>),
        layout: (persisted as Partial<LayoutState>)?.layout ?? current.layout,
        floatingPanels:
          (persisted as Partial<LayoutState>)?.floatingPanels ?? current.floatingPanels,
        showPanelBar:
          (persisted as Partial<LayoutState>)?.showPanelBar ?? current.showPanelBar,
      }),
    },
  ),
);
