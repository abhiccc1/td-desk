//! SVI (Stochastic Volatility Inspired) implied variance parameterization.
//!
//! Fits the Gatheral SVI model to a set of market-observed implied volatilities:
//!
//!   w(k) = a + b × (ρ(k − m) + √((k − m)² + σ²))
//!
//! where k = ln(K/F) is log-moneyness, w = σ²×T is total implied variance.
//!
//! Calibration uses the quasi-explicit Zeliade (2009) approach:
//! grid-search over (ρ, m), then solve (a, b, σ) analytically via
//! constrained least-squares for each grid point.

use rayon::prelude::*;

// ─── SVI parameters ─────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct SviParams {
    pub a: f64,     // vertical shift (overall variance level)
    pub b: f64,     // slope magnitude (controls wing steepness)
    pub rho: f64,   // asymmetry (-1 to 1)
    pub m: f64,     // horizontal shift (smile center offset)
    pub sigma: f64, // smoothness (minimum curvature at vertex)
}

// ─── Evaluation ─────────────────────────────────────────────────────

/// Evaluate total implied variance w(k) at a given log-moneyness.
#[inline]
pub fn svi_eval(params: &SviParams, k: f64) -> f64 {
    let dk = k - params.m;
    params.a + params.b * (params.rho * dk + (dk * dk + params.sigma * params.sigma).sqrt())
}

/// Convert total variance to implied vol: σ_impl = √(w/T).
pub fn svi_to_iv(params: &SviParams, k: f64, t: f64) -> f64 {
    let w = svi_eval(params, k);
    if w <= 0.0 || t <= 0.0 {
        return 0.0;
    }
    (w / t).sqrt()
}

// ─── Arbitrage check ────────────────────────────────────────────────

/// Check butterfly arbitrage constraint: g(k) = (1 − k w'/(2w))² − w'/4 (1/w + 1/4) + w''/2 ≥ 0
/// We simplify to checking d²w/dk² ≥ 0 at sample points (necessary but not sufficient).
/// Also checks w(k) > 0 everywhere (no negative variance).
pub fn svi_is_arbitrage_free(params: &SviParams, k_min: f64, k_max: f64, n_points: usize) -> bool {
    let step = (k_max - k_min) / (n_points as f64 - 1.0);
    let eps = 1e-6;

    for i in 0..n_points {
        let k = k_min + step * i as f64;
        let w = svi_eval(params, k);
        if w <= 0.0 {
            return false;
        }

        // Numerical second derivative: w''(k) ≈ (w(k+ε) − 2w(k) + w(k−ε)) / ε²
        let w_plus = svi_eval(params, k + eps);
        let w_minus = svi_eval(params, k - eps);
        let d2w = (w_plus - 2.0 * w + w_minus) / (eps * eps);
        if d2w < -1e-8 {
            return false;
        }
    }
    true
}

// ─── Calibration ────────────────────────────────────────────────────

/// Grid search resolution for (ρ, m) in quasi-explicit calibration.
const RHO_GRID: usize = 39;   // -0.95 to 0.95 (both skew directions)
const M_GRID: usize = 31;     // centered around data mean

/// Fit SVI to market-observed (log-moneyness, implied vol) pairs.
///
/// Converts IVs to total variances internally: w_i = iv_i² × t.
/// Returns calibrated SviParams with lowest MSE.
pub fn svi_calibrate(
    log_moneyness: &[f64],
    ivs: &[f64],
    t: f64,
    weights: Option<&[f64]>,
) -> Option<SviParams> {
    let n = log_moneyness.len();
    if n < 3 || ivs.len() != n || t <= 0.0 {
        return None;
    }

    // Convert to total variance
    let total_vars: Vec<f64> = ivs.iter().map(|&iv| iv * iv * t).collect();

    // Default weights: uniform
    let uniform: Vec<f64> = vec![1.0; n];
    let w = weights.unwrap_or(&uniform);

    // Determine m grid range from data
    let k_min = log_moneyness.iter().cloned().fold(f64::INFINITY, f64::min);
    let k_max = log_moneyness.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let k_range = k_max - k_min;
    let m_lo = k_min - 0.2 * k_range;
    let m_hi = k_max + 0.2 * k_range;

    // Build grid points
    let rho_points: Vec<f64> = (0..RHO_GRID)
        .map(|i| -0.95 + i as f64 * 1.90 / (RHO_GRID as f64 - 1.0))
        .collect();
    let m_points: Vec<f64> = (0..M_GRID)
        .map(|i| m_lo + i as f64 * (m_hi - m_lo) / (M_GRID as f64 - 1.0))
        .collect();

    // Grid search (parallelized): for each (ρ, m), solve (a, b, σ) analytically
    let candidates: Vec<(f64, SviParams)> = rho_points
        .par_iter()
        .flat_map(|&rho| {
            m_points
                .iter()
                .filter_map(|&m| {
                    fit_abs_for_rho_m(log_moneyness, &total_vars, w, rho, m)
                        .map(|(a, b, sigma, mse)| (mse, SviParams { a, b, rho, m, sigma }))
                })
                .collect::<Vec<_>>()
        })
        .collect();

    // Find best
    candidates
        .into_iter()
        .min_by(|(mse_a, _), (mse_b, _)| mse_a.partial_cmp(mse_b).unwrap())
        .map(|(_, params)| params)
}

/// For fixed (ρ, m), solve for (a, b, σ) via least-squares.
///
/// The SVI formula for fixed ρ, m is:
///   w(k) = a + b × (ρ(k−m) + √((k−m)² + σ²))
///
/// Let y_i = ρ(k_i − m), z_i = √((k_i − m)² + σ²)
/// Then w(k_i) = a + b × y_i + b × z_i = a + b × (y_i + z_i)
///
/// For a given σ, this is linear in (a, b). We grid-search σ too
/// (small grid since it's well-bounded), then solve the 2×2 normal equations.
fn fit_abs_for_rho_m(
    ks: &[f64],
    ws: &[f64],
    weights: &[f64],
    rho: f64,
    m: f64,
) -> Option<(f64, f64, f64, f64)> {
    let n = ks.len();

    // σ grid: 10 points from 0.01 to max(|k−m|)
    let max_dk = ks.iter().map(|&k| (k - m).abs()).fold(0.0_f64, f64::max);
    let sigma_max = (max_dk * 2.0).max(0.1);
    let n_sigma = 15;

    let mut best_mse = f64::INFINITY;
    let mut best = None;

    for si in 0..n_sigma {
        let sigma = 0.01 + si as f64 * (sigma_max - 0.01) / (n_sigma as f64 - 1.0);

        // Build design matrix columns: x_i = ρ(k_i − m) + √((k_i − m)² + σ²)
        // Model: w_i = a + b × x_i
        let mut sum_w_wt = 0.0;
        let mut sum_x_wt = 0.0;
        let mut sum_xx_wt = 0.0;
        let mut sum_xw_wt = 0.0;
        let mut sum_wt = 0.0;

        for i in 0..n {
            let dk = ks[i] - m;
            let x = rho * dk + (dk * dk + sigma * sigma).sqrt();
            let wi = weights[i];

            sum_wt += wi;
            sum_w_wt += wi * ws[i];
            sum_x_wt += wi * x;
            sum_xx_wt += wi * x * x;
            sum_xw_wt += wi * x * ws[i];
        }

        // Solve 2×2 normal equations: [sum_wt, sum_x_wt; sum_x_wt, sum_xx_wt] [a; b] = [sum_w_wt; sum_xw_wt]
        let det = sum_wt * sum_xx_wt - sum_x_wt * sum_x_wt;
        if det.abs() < 1e-15 {
            continue;
        }
        let a = (sum_w_wt * sum_xx_wt - sum_xw_wt * sum_x_wt) / det;
        let b = (sum_wt * sum_xw_wt - sum_x_wt * sum_w_wt) / det;

        // b must be non-negative for no-arbitrage
        if b < 0.0 {
            continue;
        }

        // Compute weighted MSE
        let mut mse = 0.0;
        for i in 0..n {
            let dk = ks[i] - m;
            let x = rho * dk + (dk * dk + sigma * sigma).sqrt();
            let residual = ws[i] - (a + b * x);
            mse += weights[i] * residual * residual;
        }
        mse /= sum_wt;

        if mse < best_mse {
            best_mse = mse;
            best = Some((a, b, sigma, mse));
        }
    }

    best
}

// ─── RMSE ───────────────────────────────────────────────────────────

/// Compute RMSE between SVI-fitted IVs and observed IVs.
pub fn svi_rmse(params: &SviParams, ks: &[f64], ivs: &[f64], t: f64) -> f64 {
    if ks.is_empty() || ks.len() != ivs.len() {
        return 0.0;
    }
    let mse: f64 = ks
        .iter()
        .zip(ivs.iter())
        .map(|(&k, &iv)| {
            let fitted = svi_to_iv(params, k, t);
            (fitted - iv) * (fitted - iv)
        })
        .sum::<f64>()
        / ks.len() as f64;
    mse.sqrt()
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_svi_eval_at_center() {
        let params = SviParams {
            a: 0.04,
            b: 0.1,
            rho: -0.5,
            m: 0.0,
            sigma: 0.1,
        };
        let w = svi_eval(&params, 0.0);
        // At k=0 (ATM): w = a + b × (0 + √(0 + σ²)) = a + b×σ
        let expected = 0.04 + 0.1 * 0.1;
        assert!((w - expected).abs() < 1e-10, "w={w}, expected={expected}");
    }

    #[test]
    fn test_svi_to_iv() {
        let params = SviParams {
            a: 0.04,
            b: 0.1,
            rho: -0.5,
            m: 0.0,
            sigma: 0.1,
        };
        let t = 1.0;
        let iv = svi_to_iv(&params, 0.0, t);
        let w = svi_eval(&params, 0.0);
        let expected_iv = (w / t).sqrt();
        assert!((iv - expected_iv).abs() < 1e-10);
    }

    #[test]
    fn test_svi_roundtrip_calibration() {
        // Generate synthetic data from known SVI params
        let true_params = SviParams {
            a: 0.04,
            b: 0.08,
            rho: -0.4,
            m: 0.01,
            sigma: 0.15,
        };
        let t = 0.08; // ~1 month

        // 20 strikes spanning log-moneyness -0.15 to 0.15
        let n = 20;
        let ks: Vec<f64> = (0..n).map(|i| -0.15 + i as f64 * 0.30 / (n as f64 - 1.0)).collect();
        let ivs: Vec<f64> = ks.iter().map(|&k| svi_to_iv(&true_params, k, t)).collect();

        let fitted = svi_calibrate(&ks, &ivs, t, None).unwrap();

        // Check that fitted IVs match within 0.5 vol points
        for (i, &k) in ks.iter().enumerate() {
            let fitted_iv = svi_to_iv(&fitted, k, t);
            let diff = (fitted_iv - ivs[i]).abs();
            assert!(
                diff < 0.005,
                "IV mismatch at k={k:.4}: market={:.4}, fitted={fitted_iv:.4}, diff={diff:.6}",
                ivs[i],
            );
        }
    }

    #[test]
    fn test_svi_arbitrage_check() {
        let params = SviParams {
            a: 0.04,
            b: 0.08,
            rho: -0.4,
            m: 0.0,
            sigma: 0.15,
        };
        assert!(svi_is_arbitrage_free(&params, -0.3, 0.3, 100));
    }

    #[test]
    fn test_svi_negative_variance_detected() {
        // Pathological params that produce negative total variance
        let params = SviParams {
            a: -0.5,
            b: 0.01,
            rho: 0.0,
            m: 0.0,
            sigma: 0.01,
        };
        assert!(!svi_is_arbitrage_free(&params, -0.3, 0.3, 100));
    }
}
