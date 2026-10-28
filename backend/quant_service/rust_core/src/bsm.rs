//! Black-Scholes-Merton pricing, Greeks, and implied volatility solver.
//!
//! All functions assume European-style options with continuous dividend yield q = 0.

use std::f64::consts::{FRAC_1_SQRT_2, PI};

use rayon::prelude::*;

// ─── Normal distribution helpers ─────────────────────────────────────

#[inline]
fn norm_cdf(x: f64) -> f64 {
    // Use erfc for better numerical stability
    0.5 * libm::erfc(-x * FRAC_1_SQRT_2)
}

#[inline]
fn norm_pdf(x: f64) -> f64 {
    (-0.5 * x * x).exp() / (2.0 * PI).sqrt()
}

// ─── d1 / d2 ─────────────────────────────────────────────────────────

#[inline]
fn d1(s: f64, k: f64, t: f64, r: f64, sigma: f64) -> f64 {
    ((s / k).ln() + (r + 0.5 * sigma * sigma) * t) / (sigma * t.sqrt())
}


// ─── Price ───────────────────────────────────────────────────────────

/// BSM call/put price. `is_call` = true for call, false for put.
pub fn price(s: f64, k: f64, t: f64, r: f64, sigma: f64, is_call: bool) -> f64 {
    if t <= 0.0 {
        return if is_call {
            (s - k).max(0.0)
        } else {
            (k - s).max(0.0)
        };
    }
    let d1v = d1(s, k, t, r, sigma);
    let d2v = d1v - sigma * t.sqrt();
    let df = (-r * t).exp();
    if is_call {
        s * norm_cdf(d1v) - k * df * norm_cdf(d2v)
    } else {
        k * df * norm_cdf(-d2v) - s * norm_cdf(-d1v)
    }
}

// ─── Greeks ──────────────────────────────────────────────────────────

pub fn delta(s: f64, k: f64, t: f64, r: f64, sigma: f64, is_call: bool) -> f64 {
    if t <= 0.0 {
        return if is_call {
            if s > k { 1.0 } else { 0.0 }
        } else {
            if s < k { -1.0 } else { 0.0 }
        };
    }
    let d1v = d1(s, k, t, r, sigma);
    if is_call {
        norm_cdf(d1v)
    } else {
        norm_cdf(d1v) - 1.0
    }
}

pub fn gamma(s: f64, k: f64, t: f64, r: f64, sigma: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    norm_pdf(d1v) / (s * sigma * t.sqrt())
}

/// Theta per calendar day (÷ 365).
pub fn theta(s: f64, k: f64, t: f64, r: f64, sigma: f64, is_call: bool) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    let d2v = d1v - sigma * t.sqrt();
    let sqrt_t = t.sqrt();
    let common = -(s * norm_pdf(d1v) * sigma) / (2.0 * sqrt_t);
    let df = (-r * t).exp();
    if is_call {
        (common - r * k * df * norm_cdf(d2v)) / 365.0
    } else {
        (common + r * k * df * norm_cdf(-d2v)) / 365.0
    }
}

/// Vega per 1% vol move (÷ 100).
pub fn vega(s: f64, k: f64, t: f64, r: f64, sigma: f64) -> f64 {
    if t <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    s * norm_pdf(d1v) * t.sqrt() / 100.0
}

/// Vanna = ∂Delta/∂σ = ∂Vega/∂S — measures how delta changes with IV.
///
/// Formula: vanna = -e^(-qT) * φ(d1) * d2 / σ  (q=0 here)
/// Scaled per 1% vol move (÷ 100) for consistency with vega.
pub fn vanna(s: f64, k: f64, t: f64, r: f64, sigma: f64) -> f64 {
    if t <= 0.0 || sigma <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    let d2v = d1v - sigma * t.sqrt();
    -norm_pdf(d1v) * d2v / sigma / 100.0
}

/// Charm = ∂Delta/∂t — measures how delta decays over time (delta bleed).
///
/// For calls: charm = -φ(d1) * [2rT - d2·σ·√T] / (2T·σ·√T)
/// For puts:  charm = -φ(d1) * [2rT - d2·σ·√T] / (2T·σ·√T) + r·e^(-rT)
/// Scaled per calendar day (÷ 365) for consistency with theta.
pub fn charm(s: f64, k: f64, t: f64, r: f64, sigma: f64, is_call: bool) -> f64 {
    if t <= 0.0 || sigma <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    let d2v = d1v - sigma * t.sqrt();
    let sqrt_t = t.sqrt();
    let base = -norm_pdf(d1v) * (2.0 * r * t - d2v * sigma * sqrt_t) / (2.0 * t * sigma * sqrt_t);
    if is_call {
        base / 365.0
    } else {
        (base + r * (-r * t).exp()) / 365.0
    }
}

/// Vomma (Volga) = ∂²V/∂σ² = ∂Vega/∂σ — vega convexity.
///
/// Formula: vomma = vega * d1 * d2 / σ
/// Scaled per 1% vol move squared (÷ 10000) since vega is already per 1%.
pub fn vomma(s: f64, k: f64, t: f64, r: f64, sigma: f64) -> f64 {
    if t <= 0.0 || sigma <= 0.0 {
        return 0.0;
    }
    let d1v = d1(s, k, t, r, sigma);
    let d2v = d1v - sigma * t.sqrt();
    let v = vega(s, k, t, r, sigma); // already ÷100
    v * d1v * d2v / sigma / 100.0    // ÷100 again for ∂σ in 1% units
}

// ─── Implied Volatility ──────────────────────────────────────────────

const IV_MAX_ITER: u32 = 100;
const IV_TOL: f64 = 1e-8;
const IV_INITIAL_GUESS: f64 = 0.20;
const IV_MIN: f64 = 1e-6;
const IV_MAX: f64 = 5.0;

/// Newton-Raphson + bisection fallback IV solver with configurable initial guess.
fn iv_solve(
    market_price: f64,
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    is_call: bool,
    initial_guess: f64,
) -> Option<f64> {
    if market_price <= 0.0 || s <= 0.0 || k <= 0.0 || t <= 0.0 {
        return None;
    }

    let mut sigma = initial_guess.clamp(IV_MIN, IV_MAX);

    for _ in 0..IV_MAX_ITER {
        let p = price(s, k, t, r, sigma, is_call);
        let diff = p - market_price;

        if diff.abs() < IV_TOL {
            return Some(sigma);
        }

        // Vega for Newton step (raw, not divided by 100)
        let d1v = d1(s, k, t, r, sigma);
        let raw_vega = s * norm_pdf(d1v) * t.sqrt();

        if raw_vega < 1e-12 {
            break;
        }

        sigma -= diff / raw_vega;
        sigma = sigma.clamp(IV_MIN, IV_MAX);
    }

    // Bisection fallback
    let mut lo = IV_MIN;
    let mut hi = IV_MAX;
    for _ in 0..200 {
        let mid = (lo + hi) / 2.0;
        let p = price(s, k, t, r, mid, is_call);
        let diff = p - market_price;
        if diff.abs() < IV_TOL {
            return Some(mid);
        }
        if diff > 0.0 {
            hi = mid;
        } else {
            lo = mid;
        }
        if (hi - lo) < IV_TOL {
            return Some(mid);
        }
    }

    None
}

/// Solve for implied volatility (cold-start at 20%).
pub fn implied_volatility(
    market_price: f64,
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    is_call: bool,
) -> Option<f64> {
    iv_solve(market_price, s, k, t, r, is_call, IV_INITIAL_GUESS)
}

/// Solve for implied volatility with a caller-provided initial guess.
pub fn implied_volatility_with_guess(
    market_price: f64,
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    is_call: bool,
    initial_guess: f64,
) -> Option<f64> {
    iv_solve(market_price, s, k, t, r, is_call, initial_guess)
}

// ─── Single-option Greeks bundle ─────────────────────────────────────

#[derive(Debug, Clone)]
pub struct GreeksBundle {
    pub iv: f64,
    pub delta: f64,
    pub gamma: f64,
    pub theta: f64,
    pub vega: f64,
    pub vanna: f64,
    pub charm: f64,
    pub vomma: f64,
    pub price: f64,
}

fn greeks_from_iv(s: f64, k: f64, t: f64, r: f64, iv: f64, is_call: bool) -> GreeksBundle {
    GreeksBundle {
        iv,
        delta: delta(s, k, t, r, iv, is_call),
        gamma: gamma(s, k, t, r, iv),
        theta: theta(s, k, t, r, iv, is_call),
        vega: vega(s, k, t, r, iv),
        vanna: vanna(s, k, t, r, iv),
        charm: charm(s, k, t, r, iv, is_call),
        vomma: vomma(s, k, t, r, iv),
        price: price(s, k, t, r, iv, is_call),
    }
}

/// Compute IV + all Greeks for a single option.
pub fn compute_greeks(
    market_price: f64,
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    is_call: bool,
) -> Option<GreeksBundle> {
    let iv = implied_volatility(market_price, s, k, t, r, is_call)?;
    Some(greeks_from_iv(s, k, t, r, iv, is_call))
}

// ─── Legacy batch (AoS, cold-start) ─────────────────────────────────

#[derive(Debug, Clone)]
pub struct OptionInput {
    pub market_price: f64,
    pub underlying_price: f64,
    pub strike: f64,
    pub time_to_expiry: f64,
    pub risk_free_rate: f64,
    pub is_call: bool,
}

pub fn batch_compute_greeks(inputs: &[OptionInput]) -> Vec<Option<GreeksBundle>> {
    inputs
        .iter()
        .map(|inp| {
            compute_greeks(
                inp.market_price,
                inp.underlying_price,
                inp.strike,
                inp.time_to_expiry,
                inp.risk_free_rate,
                inp.is_call,
            )
        })
        .collect()
}

// ─── Warm-start batch (SoA, parallel) ────────────────────────────────

/// SoA input for an entire option chain sharing one underlying, rate, and expiry.
pub struct ChainInput {
    pub underlying_price: f64,
    pub risk_free_rate: f64,
    pub time_to_expiry: f64,
    pub strikes: Vec<f64>,
    pub market_prices: Vec<f64>,
    pub is_calls: Vec<bool>,
}

/// Batch-compute IV + Greeks for an entire chain using warm-started IV solver.
///
/// Algorithm:
/// 1. Find ATM strike (closest to underlying_price)
/// 2. Solve ATM IV with Brenner-Subrahmanyam initial guess
/// 3. Walk outward from ATM, each strike seeded with the previous solved IV
/// 4. Compute Greeks for all strikes in parallel via rayon
pub fn batch_compute_greeks_warm(input: &ChainInput) -> Vec<Option<GreeksBundle>> {
    let n = input.strikes.len();
    if n == 0 {
        return vec![];
    }

    let s = input.underlying_price;
    let r = input.risk_free_rate;
    let t = input.time_to_expiry;

    let ivs = solve_chain_ivs(s, s, r, t, &input.strikes, &input.market_prices, &input.is_calls);

    // Step 3: compute Greeks in parallel (rayon for chains > 20, sequential otherwise)
    let compute_one = |i: usize| -> Option<GreeksBundle> {
        ivs[i].map(|iv| greeks_from_iv(s, input.strikes[i], t, r, iv, input.is_calls[i]))
    };

    if n > 20 {
        (0..n).into_par_iter().map(compute_one).collect()
    } else {
        (0..n).map(compute_one).collect()
    }
}

/// Warm-started IV sweep over a chain (steps 1–2 of the batch algorithm).
///
/// `s` is the price fed to the BSM pricer; `atm_ref` locates the ATM strike
/// (they differ only for Black-76, where `s = F·e^{-rT}` and `atm_ref = F`).
fn solve_chain_ivs(
    s: f64,
    atm_ref: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    market_prices: &[f64],
    is_calls: &[bool],
) -> Vec<Option<f64>> {
    let n = strikes.len();

    // Step 1: find ATM index (closest strike to underlying)
    let atm_idx = strikes
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            ((**a - atm_ref).abs()).partial_cmp(&((**b - atm_ref).abs())).unwrap()
        })
        .map(|(i, _)| i)
        .unwrap_or(0);

    // Step 2: solve IVs with warm-start sweep
    let mut ivs: Vec<Option<f64>> = vec![None; n];

    // ATM: Brenner-Subrahmanyam initial guess: σ ≈ √(2π/T) × C/S
    let atm_guess = if t > 0.0 && s > 0.0 && market_prices[atm_idx] > 0.0 {
        ((2.0 * PI / t).sqrt() * market_prices[atm_idx] / s).clamp(0.05, 2.0)
    } else {
        IV_INITIAL_GUESS
    };

    ivs[atm_idx] = implied_volatility_with_guess(
        market_prices[atm_idx],
        s,
        strikes[atm_idx],
        t,
        r,
        is_calls[atm_idx],
        atm_guess,
    );

    // Walk right from ATM
    let mut prev_iv = ivs[atm_idx].unwrap_or(IV_INITIAL_GUESS);
    for i in (atm_idx + 1)..n {
        let solved = implied_volatility_with_guess(
            market_prices[i],
            s,
            strikes[i],
            t,
            r,
            is_calls[i],
            prev_iv,
        );
        if let Some(v) = solved {
            prev_iv = v;
        }
        ivs[i] = solved;
    }

    // Walk left from ATM
    prev_iv = ivs[atm_idx].unwrap_or(IV_INITIAL_GUESS);
    for i in (0..atm_idx).rev() {
        let solved = implied_volatility_with_guess(
            market_prices[i],
            s,
            strikes[i],
            t,
            r,
            is_calls[i],
            prev_iv,
        );
        if let Some(v) = solved {
            prev_iv = v;
        }
        ivs[i] = solved;
    }

    ivs
}

// ─── Black-76 (European options on futures, e.g. MCX) ────────────────
//
// V = e^{-rT}[F·N(d1) − K·N(d2)], d1 = (ln(F/K) + σ²T/2)/(σ√T). Greeks are
// w.r.t. the futures price F with F held fixed through time (zero drift).
// Price and IV equal BSM evaluated at S = F·e^{-rT}, which the IV solver uses.

/// Black-76 Greeks for one option on a future. Same units as `greeks_from_iv`:
/// theta and charm per calendar day, vega/vanna per 1% vol, vomma per 1%².
pub fn black76_greeks_from_iv(f: f64, k: f64, t: f64, r: f64, iv: f64, is_call: bool) -> GreeksBundle {
    let df = (-r * t).exp();
    if t <= 0.0 || iv <= 0.0 {
        let intrinsic = if is_call { (f - k).max(0.0) } else { (k - f).max(0.0) };
        let delta = if is_call {
            if f > k { 1.0 } else { 0.0 }
        } else if f < k {
            -1.0
        } else {
            0.0
        };
        return GreeksBundle {
            iv, delta, gamma: 0.0, theta: 0.0, vega: 0.0, vanna: 0.0, charm: 0.0, vomma: 0.0,
            price: intrinsic,
        };
    }
    let sqrt_t = t.sqrt();
    let d1v = ((f / k).ln() + 0.5 * iv * iv * t) / (iv * sqrt_t);
    let d2v = d1v - iv * sqrt_t;
    let pdf = norm_pdf(d1v);

    let (price, delta, n_signed_d1) = if is_call {
        let p = df * (f * norm_cdf(d1v) - k * norm_cdf(d2v));
        (p, df * norm_cdf(d1v), norm_cdf(d1v))
    } else {
        let p = df * (k * norm_cdf(-d2v) - f * norm_cdf(-d1v));
        (p, -df * norm_cdf(-d1v), -norm_cdf(-d1v))
    };
    let gamma = df * pdf / (f * iv * sqrt_t);
    let raw_vega = f * df * pdf * sqrt_t;
    // −∂V/∂T at fixed F: time decay of the Black-76 value
    let theta = (-f * df * pdf * iv / (2.0 * sqrt_t) + r * price) / 365.0;
    let vanna = -df * pdf * d2v / iv / 100.0;
    // −∂Δ/∂T: Δ = e^{-rT}·N(±d1) and ∂d1/∂T = −d2/(2T)
    let charm = df * (r * n_signed_d1 + pdf * d2v / (2.0 * t)) / 365.0;
    let vega = raw_vega / 100.0;
    let vomma = vega * d1v * d2v / iv / 100.0;

    GreeksBundle { iv, delta, gamma, theta, vega, vanna, charm, vomma, price }
}

/// Black-76 counterpart of `batch_compute_greeks_warm`:
/// `input.underlying_price` is the futures price F.
pub fn batch_compute_greeks_warm_black76(input: &ChainInput) -> Vec<Option<GreeksBundle>> {
    let n = input.strikes.len();
    if n == 0 {
        return vec![];
    }

    let f = input.underlying_price;
    let r = input.risk_free_rate;
    let t = input.time_to_expiry;
    let s_equiv = f * (-r * t).exp();

    let ivs = solve_chain_ivs(s_equiv, f, r, t, &input.strikes, &input.market_prices, &input.is_calls);

    let compute_one = |i: usize| -> Option<GreeksBundle> {
        ivs[i].map(|iv| black76_greeks_from_iv(f, input.strikes[i], t, r, iv, input.is_calls[i]))
    };

    if n > 20 {
        (0..n).into_par_iter().map(compute_one).collect()
    } else {
        (0..n).map(compute_one).collect()
    }
}

// ─── IV filtering and weighting ─────────────────────────────────────

/// Filter IV outliers and compute Gaussian weights for SVI fitting.
///
/// Removes points with IV > `outlier_mult × median` (capped at `min_cap`),
/// then computes Gaussian weights centred at ATM: `exp(-0.5 × (k / atm_width)²)`.
///
/// Returns `(filtered_ks, filtered_ivs, weights)`.
pub fn filter_ivs_and_weight(
    log_moneyness: &[f64],
    ivs: &[f64],
    atm_width: f64,
    outlier_mult: f64,
    min_cap: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = log_moneyness.len();
    if n < 3 || ivs.len() != n {
        return (log_moneyness.to_vec(), ivs.to_vec(), vec![1.0; n]);
    }

    // Compute median IV via partial sort
    let mut sorted: Vec<f64> = ivs.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[n / 2];
    let cap = (median * outlier_mult).max(min_cap);

    let mut filt_ks = Vec::with_capacity(n);
    let mut filt_ivs = Vec::with_capacity(n);
    let mut weights = Vec::with_capacity(n);

    for (&k, &iv) in log_moneyness.iter().zip(ivs.iter()) {
        if iv <= cap {
            filt_ks.push(k);
            filt_ivs.push(iv);
            weights.push((-0.5 * (k / atm_width).powi(2)).exp());
        }
    }

    (filt_ks, filt_ivs, weights)
}

// ─── Strategy payoff ─────────────────────────────────────────────────

/// Compute payoff curve for a multi-leg strategy at expiration.
pub fn strategy_payoff(
    legs: &[(f64, f64, i64, bool)], // (strike, premium, signed_qty, is_call)
    spot_min: f64,
    spot_max: f64,
    num_points: usize,
) -> (Vec<f64>, Vec<f64>) {
    let step = (spot_max - spot_min) / (num_points as f64 - 1.0);
    let mut xs = Vec::with_capacity(num_points);
    let mut ys = Vec::with_capacity(num_points);

    for i in 0..num_points {
        let spot = spot_min + step * i as f64;
        xs.push(spot);

        let mut payoff = 0.0;
        for &(strike, premium, qty, is_call) in legs {
            let intrinsic = if is_call {
                (spot - strike).max(0.0)
            } else {
                (strike - spot).max(0.0)
            };
            payoff += (intrinsic - premium) * qty as f64;
        }
        ys.push(payoff);
    }

    (xs, ys)
}

/// Find breakeven points (zero crossings) via linear interpolation.
pub fn find_breakevens(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let mut breakevens = Vec::new();
    for i in 1..ys.len() {
        if ys[i - 1] * ys[i] < 0.0 {
            let x0 = xs[i - 1];
            let x1 = xs[i];
            let y0 = ys[i - 1];
            let y1 = ys[i];
            let bp = x0 - y0 * (x1 - x0) / (y1 - y0);
            breakevens.push((bp * 100.0).round() / 100.0);
        }
    }
    breakevens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_call_price() {
        // S=100, K=100, T=1, r=5%, σ=20% → ~10.45
        let p = price(100.0, 100.0, 1.0, 0.05, 0.20, true);
        assert!((p - 10.45).abs() < 0.1);
    }

    #[test]
    fn test_put_call_parity() {
        let s = 100.0;
        let k = 100.0;
        let t = 1.0;
        let r = 0.05;
        let sigma = 0.20;
        let c = price(s, k, t, r, sigma, true);
        let p = price(s, k, t, r, sigma, false);
        let parity = c - p - s + k * (-r * t).exp();
        assert!(parity.abs() < 1e-10);
    }

    #[test]
    fn test_iv_roundtrip() {
        let sigma = 0.25;
        let p = price(100.0, 105.0, 0.5, 0.05, sigma, true);
        let iv = implied_volatility(p, 100.0, 105.0, 0.5, 0.05, true).unwrap();
        assert!((iv - sigma).abs() < 1e-6);
    }

    #[test]
    fn test_iv_with_guess_roundtrip() {
        let sigma = 0.25;
        let p = price(100.0, 105.0, 0.5, 0.05, sigma, true);
        // Good guess → should converge faster and produce same result
        let iv = implied_volatility_with_guess(p, 100.0, 105.0, 0.5, 0.05, true, 0.24).unwrap();
        assert!((iv - sigma).abs() < 1e-6);
    }

    #[test]
    fn test_delta_bounds() {
        let d = delta(100.0, 100.0, 1.0, 0.05, 0.20, true);
        assert!(d > 0.0 && d < 1.0);
        let d = delta(100.0, 100.0, 1.0, 0.05, 0.20, false);
        assert!(d > -1.0 && d < 0.0);
    }

    #[test]
    fn test_warm_batch_matches_cold() {
        let s = 22000.0;
        let r = 0.065;
        let t = 0.08;

        // Build a chain of call options across strikes
        let strikes: Vec<f64> = (21000..=23000).step_by(100).map(|k| k as f64).collect();
        let n = strikes.len();

        // Generate synthetic market prices at known IV = 0.18
        let true_iv = 0.18;
        let market_prices: Vec<f64> = strikes
            .iter()
            .map(|&k| price(s, k, t, r, true_iv, true))
            .collect();
        let is_calls = vec![true; n];

        // Cold-start: per-option compute_greeks
        let cold: Vec<Option<f64>> = strikes
            .iter()
            .zip(market_prices.iter())
            .map(|(&k, &mp)| implied_volatility(mp, s, k, t, r, true))
            .collect();

        // Warm-start batch
        let chain = ChainInput {
            underlying_price: s,
            risk_free_rate: r,
            time_to_expiry: t,
            strikes: strikes.clone(),
            market_prices: market_prices.clone(),
            is_calls,
        };
        let warm = batch_compute_greeks_warm(&chain);

        // IVs should match within tolerance
        for i in 0..n {
            match (cold[i], &warm[i]) {
                (Some(cold_iv), Some(warm_bundle)) => {
                    assert!(
                        (cold_iv - warm_bundle.iv).abs() < 1e-6,
                        "IV mismatch at strike {}: cold={} warm={}",
                        strikes[i],
                        cold_iv,
                        warm_bundle.iv,
                    );
                }
                (None, None) => {}
                _ => panic!("Solve mismatch at strike {}", strikes[i]),
            }
        }
    }

    // Black-76 reference: F=100, K=100, T=0.25, r=6.5%, σ=30%.
    // d1 = 0.075, d2 = −0.075, e^{-rT} = 0.983881…
    // Call = Put = e^{-rT}·F·(2N(0.075) − 1) ≈ 5.8813

    #[test]
    fn test_black76_atm_reference() {
        let g = black76_greeks_from_iv(100.0, 100.0, 0.25, 0.065, 0.30, true);
        let df = (-0.065f64 * 0.25).exp();
        let expected = df * 100.0 * (2.0 * norm_cdf(0.075) - 1.0);
        assert!((g.price - expected).abs() < 1e-10);
        assert!((g.price - 5.8813).abs() < 1e-3, "price {}", g.price);
        assert!((g.delta - df * norm_cdf(0.075)).abs() < 1e-12);
        let p = black76_greeks_from_iv(100.0, 100.0, 0.25, 0.065, 0.30, false);
        // ATM-forward: call = put
        assert!((g.price - p.price).abs() < 1e-10);
        // Δc − Δp = e^{-rT}
        assert!((g.delta - p.delta - df).abs() < 1e-12);
    }

    #[test]
    fn test_black76_equals_bsm_at_discounted_forward() {
        let (f, k, t, r, sig): (f64, f64, f64, f64, f64) = (7400.0, 7600.0, 0.06, 0.065, 0.42);
        let s = f * (-r * t).exp();
        for &is_call in &[true, false] {
            let g = black76_greeks_from_iv(f, k, t, r, sig, is_call);
            assert!((g.price - price(s, k, t, r, sig, is_call)).abs() < 1e-8);
            // Δ_F = e^{-rT}·Δ_S ; vega identical
            assert!((g.delta - (-r * t).exp() * delta(s, k, t, r, sig, is_call)).abs() < 1e-10);
            assert!((g.vega - vega(s, k, t, r, sig)).abs() < 1e-8);
        }
    }

    #[test]
    fn test_black76_greeks_match_finite_differences() {
        let (f, k, t, r, sig) = (152000.0, 154000.0, 0.09, 0.065, 0.18);
        let hf = 1.0;
        let ht = 1e-5;
        for &is_call in &[true, false] {
            let g = black76_greeks_from_iv(f, k, t, r, sig, is_call);
            let pv = |ff: f64, tt: f64| black76_greeks_from_iv(ff, k, tt, r, sig, is_call).price;
            let dv = |ff: f64, tt: f64| black76_greeks_from_iv(ff, k, tt, r, sig, is_call).delta;
            let fd_delta = (pv(f + hf, t) - pv(f - hf, t)) / (2.0 * hf);
            let fd_gamma = (pv(f + hf, t) - 2.0 * pv(f, t) + pv(f - hf, t)) / (hf * hf);
            let fd_theta = -(pv(f, t + ht) - pv(f, t - ht)) / (2.0 * ht) / 365.0;
            let fd_charm = -(dv(f, t + ht) - dv(f, t - ht)) / (2.0 * ht) / 365.0;
            assert!((g.delta - fd_delta).abs() < 1e-6, "delta {} vs {}", g.delta, fd_delta);
            assert!((g.gamma - fd_gamma).abs() < 1e-7, "gamma {} vs {}", g.gamma, fd_gamma);
            assert!((g.theta - fd_theta).abs() < 1e-4, "theta {} vs {}", g.theta, fd_theta);
            assert!((g.charm - fd_charm).abs() < 1e-7, "charm {} vs {}", g.charm, fd_charm);
        }
    }

    #[test]
    fn test_black76_batch_iv_roundtrip() {
        let (f, r, t, true_iv) = (7400.0, 0.065, 0.06, 0.40);
        let strikes: Vec<f64> = (6400..=8400).step_by(50).map(|k| k as f64).collect();
        let is_calls: Vec<bool> = strikes.iter().map(|&k| k >= f).collect();
        let market_prices: Vec<f64> = strikes
            .iter()
            .zip(&is_calls)
            .map(|(&k, &c)| black76_greeks_from_iv(f, k, t, r, true_iv, c).price)
            .collect();
        let chain = ChainInput {
            underlying_price: f,
            risk_free_rate: r,
            time_to_expiry: t,
            strikes: strikes.clone(),
            market_prices,
            is_calls,
        };
        for (i, g) in batch_compute_greeks_warm_black76(&chain).iter().enumerate() {
            let g = g.as_ref().unwrap_or_else(|| panic!("no IV at {}", strikes[i]));
            assert!((g.iv - true_iv).abs() < 1e-6, "iv {} at {}", g.iv, strikes[i]);
        }
    }
}
