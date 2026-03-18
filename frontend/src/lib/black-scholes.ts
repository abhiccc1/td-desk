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
 * Cumulative standard normal distribution (Abramowitz & Stegun 26.2.17).
 * Max error ~7.5e-8.
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
  const t = 1.0 / (1.0 + p * absX);
  const y =
    1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-0.5 * absX * absX);

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
    iv: sigma,
  };
}
