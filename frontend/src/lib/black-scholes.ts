/**
 * Black-Scholes pricing and Greeks — production-ready module.
 * All functions assume European-style options, continuous dividend yield = 0.
 */

/* ------------------------------------------------------------------ */
/*  Normal distribution helpers                                       */
/* ------------------------------------------------------------------ */

/** Standard normal probability density function. */
export function normalPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

/**
 * Cumulative standard normal distribution via the A&S 7.1.26 erf
 * approximation: Φ(x) = ½(1 + erf(x/√2)). Max abs error ~1.5e-7.
 */
export function normalCdf(x: number): number {
  if (x < -8) return 0;
  if (x > 8) return 1;

  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  // erf is evaluated at z = |x|/√2; e^{-z²} = e^{-x²/2}
  const z = absX / Math.SQRT2;
  const t = 1.0 / (1.0 + p * z);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

  return 0.5 * (1.0 + sign * y);
}

/* ------------------------------------------------------------------ */
/*  Black-Scholes d1 / d2                                             */
/* ------------------------------------------------------------------ */

function d1d2(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): [number, number] {
  const d1 =
    (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) /
    (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  return [d1, d2];
}

/* ------------------------------------------------------------------ */
/*  Price                                                             */
/* ------------------------------------------------------------------ */

/**
 * Black-Scholes call/put price.
 * @param type "CE" | "PE"
 */
export function bsPrice(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  if (T <= 0) {
    return type === "CE" ? Math.max(S - K, 0) : Math.max(K - S, 0);
  }

  const [d1, d2] = d1d2(S, K, T, r, sigma);

  if (type === "CE") {
    return S * normalCdf(d1) - K * Math.exp(-r * T) * normalCdf(d2);
  }
  return K * Math.exp(-r * T) * normalCdf(-d2) - S * normalCdf(-d1);
}

/* ------------------------------------------------------------------ */
/*  Greeks                                                            */
/* ------------------------------------------------------------------ */

export function bsDelta(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  if (T <= 0) return type === "CE" ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
  const [d1] = d1d2(S, K, T, r, sigma);
  return type === "CE" ? normalCdf(d1) : normalCdf(d1) - 1;
}

export function bsGamma(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) return 0;
  const [d1] = d1d2(S, K, T, r, sigma);
  return normalPdf(d1) / (S * sigma * Math.sqrt(T));
}

export function bsTheta(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  if (T <= 0) return 0;
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const common = -(S * normalPdf(d1) * sigma) / (2 * sqrtT);

  if (type === "CE") {
    return (common - r * K * Math.exp(-r * T) * normalCdf(d2)) / 365;
  }
  return (common + r * K * Math.exp(-r * T) * normalCdf(-d2)) / 365;
}

export function bsVega(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0) return 0;
  const [d1] = d1d2(S, K, T, r, sigma);
  return (S * normalPdf(d1) * Math.sqrt(T)) / 100;
}

export function bsVanna(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) return 0;
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  return -normalPdf(d1) * d2 / sigma / 100;
}

/**
 * Charm = ∂Delta/∂t — delta decay per calendar day.
 * Measures how much delta shifts overnight / over one day.
 * Scaled per calendar day (÷ 365).
 */
export function bsCharm(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  if (T <= 0 || sigma <= 0) return 0;
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  const sqrtT = Math.sqrt(T);
  const base = -normalPdf(d1) * (2 * r * T - d2 * sigma * sqrtT) / (2 * T * sigma * sqrtT);
  if (type === "CE") {
    return base / 365;
  }
  return (base + r * Math.exp(-r * T)) / 365;
}

/**
 * Vomma (Volga) = ∂²V/∂σ² = ∂Vega/∂σ — vega convexity.
 * Measures how vega changes with IV. Scaled per 1% vol move squared (÷ 10000).
 */
export function bsVomma(
  S: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
): number {
  if (T <= 0 || sigma <= 0) return 0;
  const [d1, d2] = d1d2(S, K, T, r, sigma);
  const v = bsVega(S, K, T, r, sigma); // already ÷100
  return v * d1 * d2 / sigma / 100;    // ÷100 again for ∂σ in 1% units
}

/* ------------------------------------------------------------------ */
/*  Implied Volatility (Newton-Raphson + bisection fallback)          */
/* ------------------------------------------------------------------ */

/**
 * Solve for implied volatility given market price.
 * Returns IV as a decimal (e.g. 0.25 = 25%), or null if solver fails.
 */
export function bsImpliedVol(
  marketPrice: number,
  S: number,
  K: number,
  T: number,
  r: number,
  type: "CE" | "PE",
): number | null {
  if (marketPrice <= 0 || S <= 0 || K <= 0 || T <= 0) return null;

  // Newton-Raphson
  let sigma = 0.25; // initial guess
  for (let i = 0; i < 50; i++) {
    const p = bsPrice(S, K, T, r, sigma, type);
    const diff = p - marketPrice;
    if (Math.abs(diff) < 1e-6) return sigma;

    const [d1] = d1d2(S, K, T, r, sigma);
    const rawVega = S * normalPdf(d1) * Math.sqrt(T);
    if (rawVega < 1e-10) break;

    sigma -= diff / rawVega;
    sigma = Math.max(0.001, Math.min(5.0, sigma));
  }

  // Bisection fallback
  let lo = 0.001, hi = 5.0;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(S, K, T, r, mid, type);
    if (p > marketPrice) hi = mid; else lo = mid;
    if (hi - lo < 1e-6) return (lo + hi) / 2;
  }
  return (lo + hi) / 2;
}

/* ------------------------------------------------------------------ */
/*  Convenience: days-to-expiry → T in years                          */
/* ------------------------------------------------------------------ */

export function dteToYears(dte: number): number {
  return Math.max(dte / 365, 1 / 365); // floor at 1 day
}

/** Days to expiry from today to a given expiry string (YYYY-MM-DD). */
export function daysToExpiry(expiry: string): number {
  const now = new Date();
  const exp = new Date(expiry + "T15:30:00+05:30"); // IST market close
  const diff = exp.getTime() - now.getTime();
  return Math.max(Math.ceil(diff / (1000 * 60 * 60 * 24)), 1);
}

/**
 * Convenience: compute all Greeks for a single option.
 * @param r Risk-free rate (default 0.07 = 7%)
 */
export function computeAllGreeks(
  S: number,
  K: number,
  T: number,
  sigma: number,
  type: "CE" | "PE",
  r: number = 0.07,
) {
  return {
    price: bsPrice(S, K, T, r, sigma, type),
    delta: bsDelta(S, K, T, r, sigma, type),
    gamma: bsGamma(S, K, T, r, sigma),
    theta: bsTheta(S, K, T, r, sigma, type),
    vega: bsVega(S, K, T, r, sigma),
    vanna: bsVanna(S, K, T, r, sigma),
    charm: bsCharm(S, K, T, r, sigma, type),
    vomma: bsVomma(S, K, T, r, sigma),
    iv: sigma,
  };
}

/* ------------------------------------------------------------------ */
/*  Black-76 (European options on futures — MCX)                      */
/* ------------------------------------------------------------------ */
//
// V = e^{-rT}[F·N(d1) − K·N(d2)], d1 = (ln(F/K) + σ²T/2)/(σ√T). Greeks are
// w.r.t. the futures price F with F held fixed through time. Mirrors
// `black76_greeks_from_iv` in backend/quant_service/rust_core/src/bsm.rs.

/** Black-76 price for an option on a future F. */
export function black76Price(
  F: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  // Price equals BSM evaluated at the discounted forward S = F·e^{-rT}
  if (T <= 0) return type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
  return bsPrice(F * Math.exp(-r * T), K, T, r, sigma, type);
}

/** Black-76 implied volatility (identical to BSM IV at S = F·e^{-rT}). */
export function black76ImpliedVol(
  marketPrice: number,
  F: number,
  K: number,
  T: number,
  r: number,
  type: "CE" | "PE",
): number | null {
  if (F <= 0 || T <= 0) return null;
  return bsImpliedVol(marketPrice, F * Math.exp(-r * T), K, T, r, type);
}

/** All Black-76 Greeks; same units as `computeAllGreeks` (theta/charm per day, vega/vanna per 1%). */
export function computeAllGreeksBlack76(
  F: number,
  K: number,
  T: number,
  sigma: number,
  type: "CE" | "PE",
  r: number = 0.065,
) {
  const df = Math.exp(-r * T);
  if (T <= 0 || sigma <= 0) {
    const price = type === "CE" ? Math.max(F - K, 0) : Math.max(K - F, 0);
    const delta = type === "CE" ? (F > K ? 1 : 0) : (F < K ? -1 : 0);
    return { price, delta, gamma: 0, theta: 0, vega: 0, vanna: 0, charm: 0, vomma: 0, iv: sigma };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const pdf = normalPdf(d1);
  const nSigned = type === "CE" ? normalCdf(d1) : -normalCdf(-d1);
  const price = type === "CE"
    ? df * (F * normalCdf(d1) - K * normalCdf(d2))
    : df * (K * normalCdf(-d2) - F * normalCdf(-d1));
  const vega = (F * df * pdf * sqrtT) / 100;
  return {
    price,
    delta: df * nSigned,
    gamma: (df * pdf) / (F * sigma * sqrtT),
    theta: (-(F * df * pdf * sigma) / (2 * sqrtT) + r * price) / 365,
    vega,
    vanna: (-df * pdf * d2) / sigma / 100,
    charm: (df * (r * nSigned + (pdf * d2) / (2 * T))) / 365,
    vomma: (vega * d1 * d2) / sigma / 100,
    iv: sigma,
  };
}

/* ------------------------------------------------------------------ */
/*  Model dispatch — pick BSM (index spot) or Black-76 (future)       */
/* ------------------------------------------------------------------ */

export type OptionModel = "bsm" | "black76";

/** Option price under the underlying's model; `U` is spot (bsm) or future (black76). */
export function modelPrice(
  model: OptionModel,
  U: number,
  K: number,
  T: number,
  r: number,
  sigma: number,
  type: "CE" | "PE",
): number {
  return model === "black76" ? black76Price(U, K, T, r, sigma, type) : bsPrice(U, K, T, r, sigma, type);
}

export function modelImpliedVol(
  model: OptionModel,
  marketPrice: number,
  U: number,
  K: number,
  T: number,
  r: number,
  type: "CE" | "PE",
): number | null {
  return model === "black76"
    ? black76ImpliedVol(marketPrice, U, K, T, r, type)
    : bsImpliedVol(marketPrice, U, K, T, r, type);
}

export function modelGreeks(
  model: OptionModel,
  U: number,
  K: number,
  T: number,
  sigma: number,
  type: "CE" | "PE",
  r: number,
) {
  return model === "black76"
    ? computeAllGreeksBlack76(U, K, T, sigma, type, r)
    : computeAllGreeks(U, K, T, sigma, type, r);
}
