//! Carr-Madan FFT pricing engine.
//!
//! Prices an entire strip of European call options in O(N log N) by evaluating
//! the characteristic function (CF) of the log-price at N points and applying
//! a single FFT. Any model that implements `CharacteristicFunction` can be
//! priced through this engine.
//!
//! Reference: Carr & Madan (1999), "Option valuation using the fast Fourier transform".

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex, OnceLock};

use num_complex::Complex64;
use rustfft::{Fft, FftPlanner};

use crate::batch_complex::{batch_complex_mul, SoA};

// ─── Characteristic function trait ──────────────────────────────────

/// Any stochastic model whose log-price has a known characteristic function.
pub trait CharacteristicFunction {
    /// Evaluate φ(u) = E[exp(i·u·ln S_T)] under the risk-neutral measure.
    fn cf(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64;

    /// Batch-evaluate the CF at N frequency points using SoA layout.
    ///
    /// Default implementation calls scalar `cf()` in a loop.  Models should
    /// override this with a vectorized kernel that operates on contiguous
    /// `f64` arrays so LLVM can autovectorize the arithmetic.
    fn cf_batch(
        &self,
        u_re: &[f64],
        u_im: &[f64],
        t: f64,
        r: f64,
        spot: f64,
        out_re: &mut [f64],
        out_im: &mut [f64],
    ) {
        let n = u_re.len();
        for j in 0..n {
            let u = Complex64::new(u_re[j], u_im[j]);
            let val = self.cf(u, t, r, spot);
            out_re[j] = val.re;
            out_im[j] = val.im;
        }
    }
}

// ─── Carr-Madan parameters ──────────────────────────────────────────

/// Configuration for the FFT grid.
#[derive(Debug, Clone, Copy)]
pub struct CarrMadanConfig {
    /// Number of FFT points (must be a power of 2).
    pub n: usize,
    /// Spacing in the frequency domain.
    pub eta: f64,
    /// Dampening factor α (must be > 0; typically 1.5).
    pub alpha: f64,
}

impl Default for CarrMadanConfig {
    fn default() -> Self {
        Self {
            n: 4096,
            eta: 0.25,
            alpha: 1.5,
        }
    }
}

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq)]
struct ContextKey {
    n: usize,
    eta_bits: u64,
    alpha_bits: u64,
}

struct FftContext {
    n: usize,
    alpha: f64,
    log_strikes: Vec<f64>,
    v_grid: Vec<f64>,
    simpson_weights: Vec<f64>,
    price_scales: Vec<f64>,
    fft: Arc<dyn Fft<f64>>,
    // SoA layout for batch post-processing (SIMD-friendly)
    phase_re: Vec<f64>,
    phase_im: Vec<f64>,
    denom_re: Vec<f64>,
    denom_im: Vec<f64>,
    denom_inv_norm: Vec<f64>, // precomputed 1/(re²+im²) to avoid per-element division
}

static FFT_CONTEXT_CACHE: OnceLock<Mutex<HashMap<ContextKey, Arc<FftContext>>>> = OnceLock::new();

fn fft_context_cache() -> &'static Mutex<HashMap<ContextKey, Arc<FftContext>>> {
    FFT_CONTEXT_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn build_context(config: &CarrMadanConfig) -> Arc<FftContext> {
    let key = ContextKey {
        n: config.n,
        eta_bits: config.eta.to_bits(),
        alpha_bits: config.alpha.to_bits(),
    };

    let mut cache = fft_context_cache()
        .lock()
        .expect("fft context cache poisoned");
    if let Some(existing) = cache.get(&key) {
        return Arc::clone(existing);
    }

    let n = config.n;
    let eta = config.eta;
    let alpha = config.alpha;
    let lambda = 2.0 * PI / (n as f64 * eta);
    let b = (n as f64) * lambda / 2.0;

    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);

    let mut v_grid = Vec::with_capacity(n);
    let mut log_strikes = Vec::with_capacity(n);
    let mut simpson_weights = Vec::with_capacity(n);
    let mut price_scales = Vec::with_capacity(n);
    let mut phase_re = Vec::with_capacity(n);
    let mut phase_im = Vec::with_capacity(n);
    let mut denom_re = Vec::with_capacity(n);
    let mut denom_im = Vec::with_capacity(n);
    let mut denom_inv_norm = Vec::with_capacity(n);

    let inv_pi = 1.0 / PI;
    let two_alpha_plus_one = 2.0 * alpha + 1.0;
    let alpha_sq_plus_alpha = alpha * alpha + alpha;

    for j in 0..n {
        let v = j as f64 * eta;
        let k_j = -b + lambda * j as f64;
        let simpson_weight = if j == 0 {
            eta / 3.0
        } else if j % 2 == 0 {
            (eta / 3.0) * 2.0
        } else {
            (eta / 3.0) * 4.0
        };

        v_grid.push(v);
        log_strikes.push(k_j);
        simpson_weights.push(simpson_weight);
        price_scales.push(inv_pi * (-alpha * k_j).exp());

        // Phase: exp(i·v·b) = cos(v·b) + i·sin(v·b)
        let (ps, pc) = (v * b).sin_cos();
        phase_re.push(pc);
        phase_im.push(ps);

        // Denominator: (α²+α−v², (2α+1)·v)
        let dr = alpha_sq_plus_alpha - v * v;
        let di = two_alpha_plus_one * v;
        denom_re.push(dr);
        denom_im.push(di);
        denom_inv_norm.push(1.0 / (dr * dr + di * di));
    }

    let context = Arc::new(FftContext {
        n,
        alpha,
        log_strikes,
        v_grid,
        simpson_weights,
        price_scales,
        fft,
        phase_re,
        phase_im,
        denom_re,
        denom_im,
        denom_inv_norm,
    });

    cache.insert(key, Arc::clone(&context));
    context
}

fn interpolate_log_values(log_grid: &[f64], values: &[f64], strike: f64) -> f64 {
    if strike <= 0.0 || log_grid.is_empty() || values.is_empty() {
        return 0.0;
    }

    let log_strike = strike.ln();
    let idx = match log_grid.binary_search_by(|a| {
        a.partial_cmp(&log_strike)
            .unwrap_or(std::cmp::Ordering::Equal)
    }) {
        Ok(i) => return values[i],
        Err(i) => i,
    };

    if idx == 0 {
        values[0]
    } else if idx >= log_grid.len() {
        values[log_grid.len() - 1]
    } else {
        let x0 = log_grid[idx - 1];
        let x1 = log_grid[idx];
        let y0 = values[idx - 1];
        let y1 = values[idx];
        let frac = (log_strike - x0) / (x1 - x0);
        y0 + frac * (y1 - y0)
    }
}

// ─── FFT pricer ─────────────────────────────────────────────────────

/// Price European calls across a uniform log-strike grid using Carr-Madan FFT.
///
/// Returns `(log_strikes, call_prices)` — both vectors of length `config.n`.
pub fn carr_madan_fft<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    config: &CarrMadanConfig,
) -> (Vec<f64>, Vec<f64>) {
    let context = build_context(config);
    let n = context.n;
    let discount = (-r * t).exp();

    // ── Batch CF evaluation in SoA layout ────────────────────────────
    let u_im_val = -(context.alpha + 1.0);
    let u_im = vec![u_im_val; n];
    let mut cf_re = vec![0.0; n];
    let mut cf_im = vec![0.0; n];
    model.cf_batch(&context.v_grid, &u_im, t, r, spot, &mut cf_re, &mut cf_im);

    // ── Batch post-processing (all tight loops for autovectorization) ─
    // Fused: psi = discount * cf / denom, then input = psi * phase * weight
    // Step 1: cf / denom using precomputed inverse norm
    //   (a/b) = (a·b̄) / |b|², precomputed as (a·b̄) · inv_norm
    let mut psi = SoA::zeros(n);
    for j in 0..n {
        let inv = context.denom_inv_norm[j] * discount;
        psi.re[j] = (cf_re[j] * context.denom_re[j] + cf_im[j] * context.denom_im[j]) * inv;
        psi.im[j] = (cf_im[j] * context.denom_re[j] - cf_re[j] * context.denom_im[j]) * inv;
    }

    // Step 2: psi * phase in SoA form, then scale by quadrature weights.
    let mut fft_input_soa = SoA::zeros(n);
    batch_complex_mul(
        &psi.re,
        &psi.im,
        &context.phase_re,
        &context.phase_im,
        &mut fft_input_soa.re,
        &mut fft_input_soa.im,
    );

    for j in 0..n {
        let w = context.simpson_weights[j];
        fft_input_soa.re[j] *= w;
        fft_input_soa.im[j] *= w;
    }

    let mut input = vec![Complex64::new(0.0, 0.0); fft_input_soa.len()];
    fft_input_soa.write_to_complex_slice(&mut input);

    // ── FFT + extract call prices ────────────────────────────────────
    context.fft.process(&mut input);

    let call_prices = input
        .iter()
        .zip(context.price_scales.iter())
        .map(|(value, scale)| (value.re * scale).max(0.0))
        .collect();

    (context.log_strikes.clone(), call_prices)
}

/// Price calls at specific strikes by interpolating the FFT grid.
pub fn price_at_strikes<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    config: &CarrMadanConfig,
) -> Vec<f64> {
    let (log_strikes, call_prices) = carr_madan_fft(model, spot, r, t, config);
    strikes
        .iter()
        .map(|&strike| interpolate_log_values(&log_strikes, &call_prices, strike).max(0.0))
        .collect()
}

// ─── Risk-neutral density extraction ─────────────────────────────────

/// Extract the risk-neutral probability density of S_T via FFT of the CF.
pub fn risk_neutral_density<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    config: &CarrMadanConfig,
) -> Vec<f64> {
    let context = build_context(config);
    let n = context.n;

    // ── Batch CF evaluation (u_im = 0 for density) ──────────────────
    let u_im = vec![0.0; n];
    let mut cf_re = vec![0.0; n];
    let mut cf_im = vec![0.0; n];
    model.cf_batch(&context.v_grid, &u_im, t, r, spot, &mut cf_re, &mut cf_im);

    // ── Batch: input = cf * phase * simpson_weight ───────────────────
    let mut fft_input_soa = SoA::zeros(n);
    batch_complex_mul(
        &cf_re,
        &cf_im,
        &context.phase_re,
        &context.phase_im,
        &mut fft_input_soa.re,
        &mut fft_input_soa.im,
    );
    for j in 0..n {
        let w = context.simpson_weights[j];
        fft_input_soa.re[j] *= w;
        fft_input_soa.im[j] *= w;
    }

    let mut input = vec![Complex64::new(0.0, 0.0); fft_input_soa.len()];
    fft_input_soa.write_to_complex_slice(&mut input);

    context.fft.process(&mut input);

    let inv_pi = 1.0 / PI;
    let log_density: Vec<f64> = input
        .iter()
        .map(|value| (inv_pi * value.re).max(0.0))
        .collect();

    strikes
        .iter()
        .map(|&strike| {
            if strike <= 0.0 {
                return 0.0;
            }
            (interpolate_log_values(&context.log_strikes, &log_density, strike) / strike).max(0.0)
        })
        .collect()
}

/// Compute density and CDF on the same output grid in a single Rust call.
pub fn risk_neutral_density_and_cdf<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    config: &CarrMadanConfig,
) -> (Vec<f64>, Vec<f64>) {
    let density = risk_neutral_density(model, spot, r, t, strikes, config);
    let cdf = compute_cdf(strikes, &density);
    (density, cdf)
}

/// Compute Probability of Profit by integrating the risk-neutral density over
/// the region where the strategy payoff is positive.
///
/// Uses trapezoidal integration: PoP = integral of 1_{payoff>0} * f(S) dS
pub fn compute_pop_from_density(
    spot_grid: &[f64],
    density: &[f64],
    payoff: &[f64],
) -> f64 {
    if spot_grid.len() < 2 || density.len() != spot_grid.len() || payoff.len() != spot_grid.len() {
        return 0.0;
    }
    let mut pop = 0.0;
    for i in 0..spot_grid.len() - 1 {
        let ds = spot_grid[i + 1] - spot_grid[i];
        let f0 = if payoff[i] > 0.0 { density[i] } else { 0.0 };
        let f1 = if payoff[i + 1] > 0.0 { density[i + 1] } else { 0.0 };
        pop += 0.5 * (f0 + f1) * ds;
    }
    pop.clamp(0.0, 1.0)
}

/// Compute the cumulative distribution function (CDF) from density.
pub fn compute_cdf(spot_grid: &[f64], density: &[f64]) -> Vec<f64> {
    if spot_grid.len() < 2 || density.len() != spot_grid.len() {
        return vec![0.0; spot_grid.len()];
    }
    let mut cdf = Vec::with_capacity(spot_grid.len());
    cdf.push(0.0);
    let mut cum = 0.0;
    for i in 1..spot_grid.len() {
        let ds = spot_grid[i] - spot_grid[i - 1];
        cum += 0.5 * (density[i - 1] + density[i]) * ds;
        cdf.push(cum.min(1.0));
    }
    cdf
}

/// Compute Value-at-Risk for a strategy at a given confidence level.
pub fn compute_var(
    spot_grid: &[f64],
    density: &[f64],
    payoff: &[f64],
    confidence: f64,
) -> f64 {
    if spot_grid.len() < 2
        || density.len() != spot_grid.len()
        || payoff.len() != spot_grid.len()
    {
        return f64::NAN;
    }

    let n = spot_grid.len();
    let mut indexed: Vec<(f64, f64)> = Vec::with_capacity(n);
    for i in 0..n {
        let ds = if i == 0 {
            spot_grid[1] - spot_grid[0]
        } else if i == n - 1 {
            spot_grid[n - 1] - spot_grid[n - 2]
        } else {
            (spot_grid[i + 1] - spot_grid[i - 1]) / 2.0
        };
        indexed.push((payoff[i], density[i] * ds));
    }
    indexed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut cum = 0.0;
    for (pnl, weight) in &indexed {
        cum += weight;
        if cum >= confidence {
            return *pnl;
        }
    }
    indexed.last().map(|(pnl, _)| *pnl).unwrap_or(f64::NAN)
}

/// Compute Expected Shortfall (Conditional VaR) at a given confidence level.
pub fn compute_expected_shortfall(
    spot_grid: &[f64],
    density: &[f64],
    payoff: &[f64],
    confidence: f64,
) -> f64 {
    if spot_grid.len() < 2
        || density.len() != spot_grid.len()
        || payoff.len() != spot_grid.len()
        || confidence <= 0.0
    {
        return f64::NAN;
    }

    let n = spot_grid.len();
    let mut indexed: Vec<(f64, f64)> = Vec::with_capacity(n);
    for i in 0..n {
        let ds = if i == 0 {
            spot_grid[1] - spot_grid[0]
        } else if i == n - 1 {
            spot_grid[n - 1] - spot_grid[n - 2]
        } else {
            (spot_grid[i + 1] - spot_grid[i - 1]) / 2.0
        };
        indexed.push((payoff[i], density[i] * ds));
    }
    indexed.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));

    let mut cum = 0.0;
    let mut weighted_sum = 0.0;
    for (pnl, weight) in &indexed {
        if cum + weight > confidence {
            let remaining = confidence - cum;
            weighted_sum += pnl * remaining;
            cum = confidence;
            break;
        }
        weighted_sum += pnl * weight;
        cum += weight;
    }

    if cum > 0.0 {
        weighted_sum / cum
    } else {
        f64::NAN
    }
}

// ─── BSM characteristic function (for testing) ──────────────────────

/// BSM model as a CF (used to validate FFT against closed-form BSM prices).
#[cfg(test)]
pub struct BsmCF {
    pub sigma: f64,
}

#[cfg(test)]
impl CharacteristicFunction for BsmCF {
    fn cf(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64 {
        let i = Complex64::i();
        let s = self.sigma;
        let log_spot = spot.ln();
        let drift = (r - 0.5 * s * s) * t;
        let var = s * s * t;
        (i * u * (log_spot + drift) - 0.5 * var * u * u).exp()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fft_context_reused() {
        let config = CarrMadanConfig::default();
        let a = build_context(&config);
        let b = build_context(&config);
        assert!(Arc::ptr_eq(&a, &b), "expected cached FFT context reuse");
    }

    #[test]
    fn test_fft_vs_bsm_atm() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let config = CarrMadanConfig::default();
        let strikes = vec![100.0];
        let fft_prices = price_at_strikes(&model, spot, r, t, &strikes, &config);

        let bsm_price = crate::bsm::price(spot, 100.0, t, r, 0.20, true);

        assert!(
            (fft_prices[0] - bsm_price).abs() < 0.05,
            "FFT={:.4}, BSM={:.4}",
            fft_prices[0],
            bsm_price,
        );
    }

    #[test]
    fn test_fft_vs_bsm_otm_strip() {
        let model = BsmCF { sigma: 0.25 };
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;

        let strikes: Vec<f64> = (20000..=24000).step_by(500).map(|k| k as f64).collect();

        let config = CarrMadanConfig::default();
        let fft_prices = price_at_strikes(&model, spot, r, t, &strikes, &config);

        for (i, &k) in strikes.iter().enumerate() {
            let bsm = crate::bsm::price(spot, k, t, r, 0.25, true);
            let err = (fft_prices[i] - bsm).abs();
            let rel = if bsm > 1.0 { err / bsm } else { err };
            assert!(
                rel < 0.01,
                "Strike={k}: FFT={:.4}, BSM={:.4}, rel_err={rel:.6}",
                fft_prices[i],
                bsm,
            );
        }
    }

    #[test]
    fn test_fft_put_call_parity() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 0.5;

        let strikes = vec![90.0, 100.0, 110.0];
        let config = CarrMadanConfig::default();
        let calls = price_at_strikes(&model, spot, r, t, &strikes, &config);

        for (i, &k) in strikes.iter().enumerate() {
            let put_parity = calls[i] - spot + k * (-r * t).exp();
            let bsm_put = crate::bsm::price(spot, k, t, r, 0.20, false);
            assert!(
                (put_parity - bsm_put).abs() < 0.05,
                "K={k}: parity_put={put_parity:.4}, bsm_put={bsm_put:.4}",
            );
        }
    }

    #[test]
    fn test_density_non_negative() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let strikes: Vec<f64> = (50..=200).map(|k| k as f64).collect();
        let config = CarrMadanConfig::default();
        let density = risk_neutral_density(&model, spot, r, t, &strikes, &config);

        for (i, &d) in density.iter().enumerate() {
            assert!(
                d >= 0.0,
                "Density negative at strike={}: d={d:.8}",
                strikes[i],
            );
        }
    }

    #[test]
    fn test_density_integrates_to_one() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let n_pts = 2000;
        let s_min = 20.0_f64;
        let s_max = 300.0_f64;
        let ds = (s_max - s_min) / (n_pts as f64 - 1.0);
        let strikes: Vec<f64> = (0..n_pts).map(|i| s_min + ds * i as f64).collect();

        let config = CarrMadanConfig::default();
        let density = risk_neutral_density(&model, spot, r, t, &strikes, &config);

        let mut integral = 0.0;
        for i in 0..n_pts - 1 {
            let h = strikes[i + 1] - strikes[i];
            integral += 0.5 * (density[i] + density[i + 1]) * h;
        }

        assert!(
            (integral - 1.0).abs() < 0.05,
            "Density integral = {integral:.6}, expected ~1.0",
        );
    }

    #[test]
    fn test_density_median_near_forward() {
        let model = BsmCF { sigma: 0.20 };
        let spot: f64 = 100.0;
        let r: f64 = 0.05;
        let t: f64 = 1.0;

        let forward = spot * (r * t).exp();
        let bsm_median = forward * (-0.5 * 0.20 * 0.20 * t).exp();

        let n_pts = 2000;
        let s_min = 20.0_f64;
        let s_max = 300.0_f64;
        let ds = (s_max - s_min) / (n_pts as f64 - 1.0);
        let strikes: Vec<f64> = (0..n_pts).map(|i| s_min + ds * i as f64).collect();

        let config = CarrMadanConfig::default();
        let density = risk_neutral_density(&model, spot, r, t, &strikes, &config);

        let mut cum = 0.0;
        let mut median_est = strikes[0];
        for i in 0..n_pts - 1 {
            let h = strikes[i + 1] - strikes[i];
            cum += 0.5 * (density[i] + density[i + 1]) * h;
            if cum >= 0.5 {
                median_est = strikes[i];
                break;
            }
        }

        let err = (median_est - bsm_median).abs();
        assert!(
            err < 2.0,
            "Median estimate={median_est:.2}, BSM median={bsm_median:.2}, err={err:.4}",
        );
    }

    #[test]
    fn test_cdf_monotonic() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let n_pts = 500;
        let s_min = 30.0_f64;
        let s_max = 300.0_f64;
        let ds = (s_max - s_min) / (n_pts as f64 - 1.0);
        let grid: Vec<f64> = (0..n_pts).map(|i| s_min + ds * i as f64).collect();

        let config = CarrMadanConfig::default();
        let density = risk_neutral_density(&model, spot, r, t, &grid, &config);
        let cdf = compute_cdf(&grid, &density);

        for i in 1..cdf.len() {
            assert!(
                cdf[i] >= cdf[i - 1] - 1e-10,
                "CDF not monotonic at i={}: {} < {}",
                i, cdf[i], cdf[i - 1],
            );
        }
        assert!(
            (cdf[cdf.len() - 1] - 1.0).abs() < 0.1,
            "CDF final = {}, expected ~1.0",
            cdf[cdf.len() - 1],
        );
    }

    #[test]
    fn test_var_and_es_long_call() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let n_pts = 500;
        let s_min = 30.0_f64;
        let s_max = 300.0_f64;
        let ds = (s_max - s_min) / (n_pts as f64 - 1.0);
        let grid: Vec<f64> = (0..n_pts).map(|i| s_min + ds * i as f64).collect();

        let config = CarrMadanConfig::default();
        let density = risk_neutral_density(&model, spot, r, t, &grid, &config);

        let premium = 10.45;
        let strike = 100.0;
        let payoff: Vec<f64> = grid.iter().map(|&s| (s - strike).max(0.0) - premium).collect();

        let var_5 = compute_var(&grid, &density, &payoff, 0.05);
        let es_5 = compute_expected_shortfall(&grid, &density, &payoff, 0.05);

        assert!(var_5 <= 0.0, "VaR(5%) should be negative for long call, got {var_5}");
        assert!(es_5 <= var_5 + 0.01, "ES should be ≤ VaR: ES={es_5}, VaR={var_5}");
        assert!(
            (var_5 - (-premium)).abs() < 2.0,
            "VaR ≈ -premium for long call: VaR={var_5}, premium={premium}",
        );
    }
}
