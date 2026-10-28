const FALLBACK_LOT_SIZES: Record<string, number> = {
  NIFTY: 65,
  BANKNIFTY: 30,
  FINNIFTY: 65,
  MIDCPNIFTY: 50,
  SENSEX: 20,
  BANKEX: 20,
  CRUDEOIL: 100,
  CRUDEOILM: 10,
  NATURALGAS: 1250,
  NATGASMINI: 250,
  GOLD: 1,
  GOLDM: 100,
};

export function getResolvedLotSize(
  underlying: string,
  lotSizes?: Record<string, number>,
) {
  const key = underlying.trim().toUpperCase();
  return lotSizes?.[key] || FALLBACK_LOT_SIZES[key] || 1;
}

export function normalizeLotSizes(lotSizes: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(lotSizes).map(([key, value]) => [key.toUpperCase(), Number(value) || 0]),
  );
}

export function hasKnownLotSize(
  underlying: string,
  lotSizes?: Record<string, number>,
) {
  const key = underlying.trim().toUpperCase();
  return Boolean(lotSizes?.[key] || FALLBACK_LOT_SIZES[key]);
}

/**
 * Fill gaps in the /lot-sizes map with lot sizes carried on /underlyings rows.
 * Keys already present in `lotSizes` win, so NSE/BSE behaviour is unchanged.
 */
export function mergeLotSizes(
  lotSizes: Record<string, number> | undefined,
  underlyings: { name: string; lotSize?: number }[] | undefined,
) {
  if (!underlyings?.length) return lotSizes;
  const merged: Record<string, number> = { ...(lotSizes ?? {}) };
  for (const item of underlyings) {
    const key = item.name.trim().toUpperCase();
    if (!merged[key] && item.lotSize) merged[key] = item.lotSize;
  }
  return merged;
}
