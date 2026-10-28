import { AppState } from "react-native";

import { streamClient, type ChainDemand } from "./stream-client";

/**
 * Compute demand for the mobile client.
 *
 * The app renders strike/LTP/bid/ask on the chain tab and derives position P&L
 * from the raw tick stream. It subscribes no `greeks:*`, `model:*`, `svi:*` or
 * `vrp:*` topic and displays no Greek, so it asks for **no analytics tiers at
 * all**: the backend then skips the IV solve, the SVI fit, Heston/VG
 * calibration, FFT pricing and VRP for every chain this client is the only
 * consumer of. A desktop client connecting at the same time unions its own
 * tiers back in, so this can only ever subtract work nobody is rendering.
 *
 * Several screens contribute demand at once (the chain tab, and the position
 * expiries), and the wire format is a complete set rather than a delta, so
 * contributions are merged here by source instead of each hook overwriting the
 * other's claim.
 */
const NO_ANALYTICS: string[] = [];

/**
 * Snapshot cadence. Deliberately far slower than the desktop's 25 ms: a phone
 * cannot usefully render a chain at 40 fps, and every snapshot costs a payload
 * over cellular. Position expiries get the slow rate — nothing on screen shows
 * a chain for them, only the position's own LTP, which rides the tick stream.
 */
export const FOREGROUND_THROTTLE_MS = 250;
export const BACKGROUND_THROTTLE_MS = 2000;
export const POSITION_THROTTLE_MS = 2000;

/** Restate demand this often. Claims are fire-and-forget and held in memory by
 *  the market-data service, so a restart on either side costs one interval. */
export const REASSERT_INTERVAL_MS = 30_000;

export type DemandSource = "chain" | "positions";

type Contribution = { underlying: string; expiry: string; throttleMs: number };

const contributions = new Map<DemandSource, Contribution[]>();

function appActive(): boolean {
  return AppState.currentState === "active";
}

/** Cadence for a contribution, demoted whenever the app isn't foregrounded. */
export function throttleFor(base: number): number {
  return appActive() ? base : Math.max(base, BACKGROUND_THROTTLE_MS);
}

/**
 * Replace one source's claims and push the merged set.
 *
 * Merging takes the fastest cadence per chain, matching how the gateway
 * reduces claims across clients — so the chain tab's rate wins over the slower
 * position rate for an expiry that is both open and on screen.
 */
export function setDemandContribution(source: DemandSource, chains: Contribution[]): void {
  contributions.set(source, chains);

  const merged = new Map<string, ChainDemand>();
  for (const list of contributions.values()) {
    for (const chain of list) {
      const key = `${chain.underlying}:${chain.expiry}`;
      const existing = merged.get(key);
      if (existing && existing.throttleMs <= chain.throttleMs) continue;
      merged.set(key, {
        underlying: chain.underlying,
        expiry: chain.expiry,
        throttleMs: chain.throttleMs,
        analytics: NO_ANALYTICS,
      });
    }
  }

  streamClient.setDemand([...merged.values()]);
}

/** Drop a source's claims entirely (screen unmounted). */
export function clearDemandContribution(source: DemandSource): void {
  setDemandContribution(source, []);
}
