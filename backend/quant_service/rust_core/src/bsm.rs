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
    pub price: f64,
}

fn greeks_from_iv(s: f64, k: f64, t: f64, r: f64, iv: f64, is_call: bool) -> GreeksBundle {
    GreeksBundle {
        iv,
        delta: delta(s, k, t, r, iv, is_call),
        gamma: gamma(s, k, t, r, iv),
        theta: theta(s, k, t, r, iv, is_call),
        vega: vega(s, k, t, r, iv),
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

    // Step 1: find ATM index (closest strike to underlying)
    let atm_idx = input
        .strikes
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| {
            ((**a - s).abs()).partial_cmp(&((**b - s).abs())).unwrap()
        })
        .map(|(i, _)| i)
        .unwrap_or(0);

    // Step 2: solve IVs with warm-start sweep
    let mut ivs: Vec<Option<f64>> = vec![None; n];

    // ATM: Brenner-Subrahmanyam initial guess: σ ≈ √(2π/T) × C/S
    let atm_guess = if t > 0.0 && s > 0.0 && input.market_prices[atm_idx] > 0.0 {
        ((2.0 * PI / t).sqrt() * input.market_prices[atm_idx] / s).clamp(0.05, 2.0)
    } else {
        IV_INITIAL_GUESS
    };

    ivs[atm_idx] = iv_solve(
        input.market_prices[atm_idx],
        s,
        input.strikes[atm_idx],
        t,
        r,
        input.is_calls[atm_idx],
        atm_guess,
    );

    // Walk right from ATM
    let mut prev_iv = ivs[atm_idx].unwrap_or(IV_INITIAL_GUESS);
    for i in (atm_idx + 1)..n {
        let solved = iv_solve(
            input.market_prices[i],
            s,
            input.strikes[i],
            t,
            r,
            input.is_calls[i],
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
        let solved = iv_solve(
            input.market_prices[i],
            s,
            input.strikes[i],
            t,
            r,
            input.is_calls[i],
            prev_iv,
        );
        if let Some(v) = solved {
            prev_iv = v;
        }
        ivs[i] = solved;
    }

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
}
