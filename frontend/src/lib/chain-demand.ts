/**
 * Chain demand — decides how hard the backend should be working on the live
 * option chain, from what the UI is actually doing with it.
 *
 * Without this the whole pipeline (snapshot build → IV/Greeks solve → SVI fit
 * → fan-out → grid re-render) ran at the active cadence from the moment an
 * instrument was selected until the browser closed, regardless of whether a
 * chain panel was open, the tab was visible, or anyone was at the keyboard.
 *
 * Demand is recomputed from ground truth (the panel layout, document
 * visibility, last input time) rather than accumulated from events, so it
 * cannot drift out of sync with reality, and it is re-asserted on a timer so a
 * restart on either side self-heals.
 */

import { hasPanelInLayout, useLayoutStore } from "@/stores/layout-store";
import { useMarketDataStore } from "@/stores/market-data-store";
import type { PanelId } from "@/types/panels";

export type DemandLevel = "active" | "background" | "off";

/** Backend snapshot cadence per level. "off" has no cadence — the chain is
 *  released entirely and nothing is emitted for it. */
export const DEMAND_THROTTLE_MS: Record<Exclude<DemandLevel, "off">, number> = {
  active: 25,
  background: 2000,
};

/**
 * Analytics tiers quant_service can run. Kept in sync with
 * `quant_service/indicators/registry.py`.
 *
 *   greeks — IV solve, the Greeks strip, the SVI fit and its alerts, and VRP.
 *   models — Heston/VG calibration, FFT chain pricing, densities and PoP.
 *
 * Only the tiers a visible panel will actually render are requested, so a
 * layout with no model panels open skips the calibration and FFT work.
 */
export type AnalyticsTier = "greeks" | "models";

/**
 * Panels that consume the live chain pipeline, and what each one needs.
 * Deliberately over-inclusive on membership: listing a panel that doesn't need
 * the chain only costs CPU while that panel is open, whereas omitting one that
 * does leaves it showing stale data.
 *
 * Not listed, because they run off pipelines that are independent of chain
 * demand: positions/paper-positions/risk-management (the 5s position snapshot
 * pipeline), price-chart (spot ticks), adjustments (REST), order-basket and
 * payoff-diagram (basket store).
 *
 * `model-comparison` and `mispricing-scanner` list "greeks" as well because the
 * model pricers read the SVI fit the Greeks tier produces — asking for models
 * alone would leave them calibrating against a surface nobody is fitting.
 */
const CHAIN_CONSUMER_PANELS: Record<string, AnalyticsTier[]> = {
  "option-chain": ["greeks"],
  "iv-skew": ["greeks"],
  "vol-surface": ["greeks"],
  "greeks-exposure": ["greeks"],
  "model-comparison": ["greeks", "models"],
  "mispricing-scanner": ["greeks", "models"],
};

/**
 * VRP renders in the always-visible global toolbar, not in a panel, so the
 * Greeks tier is requested whenever any chain consumer is open.
 */
const TOOLBAR_TIERS: AnalyticsTier[] = ["greeks"];

/** No pointer or keyboard input for this long demotes to the background rate. */
const IDLE_AFTER_MS = 3 * 60_000;

/** How often the current demand is restated to the server. This is what makes
 *  the mechanism self-healing: any level lost to a gateway or market-data
 *  restart, or to a dropped fire-and-forget PUBLISH, is corrected within one
 *  interval instead of persisting until the next user action. */
export const DEMAND_REASSERT_INTERVAL_MS = 30_000;

/** Input events that count as the user being present. */
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
] as const;

export interface ChainDemand {
  underlying: string;
  expiry: string;
  level: DemandLevel;
  /** Analytics tiers the visible panels will render. Empty means quotes only. */
  analytics: AnalyticsTier[];
}

type DemandListener = (demand: ChainDemand) => void;

function panelVisible(panelId: PanelId): boolean {
  const { layout, floatingPanels } = useLayoutStore.getState();
  return (
    hasPanelInLayout(layout, panelId) ||
    floatingPanels.some((panel) => panel.id === panelId)
  );
}

export class ChainDemandController {
  private _listeners: DemandListener[] = [];
  private _current: ChainDemand | null = null;
  private _lastActivityAt = Date.now();
  private _idleTimer: ReturnType<typeof setInterval> | null = null;
  private _unsubLayout: (() => void) | null = null;
  private _unsubMarketData: (() => void) | null = null;
  private _onActivity: (() => void) | null = null;
  private _onVisibility: (() => void) | null = null;

  /** Tiers the currently visible chain-consuming panels need. */
  private _analytics(): AnalyticsTier[] {
    const tiers = new Set<AnalyticsTier>();
    for (const [panelId, panelTiers] of Object.entries(CHAIN_CONSUMER_PANELS)) {
      if (!panelVisible(panelId as PanelId)) continue;
      for (const tier of panelTiers) tiers.add(tier);
      for (const tier of TOOLBAR_TIERS) tiers.add(tier);
    }
    return [...tiers].sort();
  }

  private _compute(): ChainDemand {
    const { selectedUnderlying, selectedExpiry } = useMarketDataStore.getState();
    const analytics = this._analytics();
    // No chain consumer visible, or nothing selected: nothing to compute.
    if (analytics.length === 0 || !selectedUnderlying || !selectedExpiry) {
      return { underlying: "", expiry: "", level: "off", analytics: [] };
    }

    const hidden = typeof document !== "undefined" && document.hidden;
    const idle = Date.now() - this._lastActivityAt >= IDLE_AFTER_MS;
    return {
      underlying: selectedUnderlying,
      expiry: selectedExpiry,
      level: hidden || idle ? "background" : "active",
      analytics,
    };
  }

  /** Current demand, computed fresh. Used by the re-assert timer so a restated
   *  level can never be an echo of a stale cached value. */
  snapshot(): ChainDemand {
    return this._compute();
  }

  private _emitIfChanged(): void {
    const next = this._compute();
    const prev = this._current;
    if (
      prev &&
      prev.underlying === next.underlying &&
      prev.expiry === next.expiry &&
      prev.level === next.level &&
      prev.analytics.join(",") === next.analytics.join(",")
    ) {
      return;
    }
    this._current = next;
    for (const listener of this._listeners) listener(next);
  }

  onChange(listener: DemandListener): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  start(): void {
    if (this._unsubLayout) return; // already started

    this._lastActivityAt = Date.now();

    this._onActivity = () => {
      const wasIdle = Date.now() - this._lastActivityAt >= IDLE_AFTER_MS;
      this._lastActivityAt = Date.now();
      // Only re-evaluate on the idle→active edge. Doing it on every
      // pointermove would run the layout walk hundreds of times a second.
      if (wasIdle) this._emitIfChanged();
    };
    for (const name of ACTIVITY_EVENTS) {
      window.addEventListener(name, this._onActivity, { passive: true });
    }

    this._onVisibility = () => {
      // Returning to the tab counts as activity: the user is plainly back,
      // and without this they would wait out the idle timer at the slow rate.
      this._lastActivityAt = Date.now();
      this._emitIfChanged();
    };
    document.addEventListener("visibilitychange", this._onVisibility);

    // Crossing the idle threshold produces no event of its own, so poll for it.
    this._idleTimer = setInterval(() => this._emitIfChanged(), 15_000);

    this._unsubLayout = useLayoutStore.subscribe((state, prev) => {
      if (state.layout !== prev.layout || state.floatingPanels !== prev.floatingPanels) {
        this._emitIfChanged();
      }
    });

    this._unsubMarketData = useMarketDataStore.subscribe((state, prev) => {
      if (
        state.selectedUnderlying !== prev.selectedUnderlying ||
        state.selectedExpiry !== prev.selectedExpiry
      ) {
        this._emitIfChanged();
      }
    });

    this._emitIfChanged();
  }

  stop(): void {
    if (this._onActivity) {
      for (const name of ACTIVITY_EVENTS) {
        window.removeEventListener(name, this._onActivity);
      }
      this._onActivity = null;
    }
    if (this._onVisibility) {
      document.removeEventListener("visibilitychange", this._onVisibility);
      this._onVisibility = null;
    }
    if (this._idleTimer !== null) {
      clearInterval(this._idleTimer);
      this._idleTimer = null;
    }
    this._unsubLayout?.();
    this._unsubLayout = null;
    this._unsubMarketData?.();
    this._unsubMarketData = null;
    this._listeners = [];
    this._current = null;
  }
}
