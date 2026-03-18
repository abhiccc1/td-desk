/** Mock-mode seed constants for NIFTY options */

export const ATM_PRICE = 22_500;
export const STRIKE_STEP = 50;
export const STRIKES_EACH_SIDE = 12;
export const BASE_IV = 0.13;
export const LOT_SIZE = 75;
export const RISK_FREE_RATE = 0.07;

/** Pre-defined expiry dates (YYYY-MM-DD, Thursdays). */
export const EXPIRIES = [
  "2026-03-19",
  "2026-03-26",
  "2026-04-02",
  "2026-04-30",
] as const;

/** Default underlying for mock mode. */
export const UNDERLYING = "NIFTY";
export const EXCHANGE = "NSE";

/** Tick interval in ms for mock WS ticker. */
export const TICK_INTERVAL_MS = 500;

/** Simulated API delay range in ms [min, max]. */
export const API_DELAY: [number, number] = [50, 200];
