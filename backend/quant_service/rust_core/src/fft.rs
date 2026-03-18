//! Carr-Madan FFT pricing engine.
//!
//! Prices an entire strip of European call options in O(N log N) by evaluating
//! the characteristic function (CF) of the log-price at N points and applying
//! a single FFT.  Any model that implements `CharacteristicFunction` can be
//! priced through this engine.
//!
//! Reference: Carr & Madan (1999), "Option valuation using the fast Fourier transform".

use std::f64::consts::PI;

use num_complex::Complex64;
use rustfft::FftPlanner;

// ─── Characteristic function trait ──────────────────────────────────

/// Any stochastic model whose log-price has a known characteristic function.
pub trait CharacteristicFunction {
    /// Evaluate φ(u) = E[exp(i·u·ln S_T)] under the risk-neutral measure.
    fn cf(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64;
}

// ─── Carr-Madan parameters ──────────────────────────────────────────

/// Configuration for the FFT grid.
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

// ─── FFT pricer ─────────────────────────────────────────────────────

/// Price European calls across a uniform log-strike grid using Carr-Madan FFT.
///
/// Returns `(log_strikes, call_prices)` — both vectors of length `config.n`.
/// The log-strikes are `k_j = -b + lambda * j` where `lambda = 2π / (N * eta)`
/// and `b = N * lambda / 2`.
pub fn carr_madan_fft<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    config: &CarrMadanConfig,
) -> (Vec<f64>, Vec<f64>) {
    let n = config.n;
    let eta = config.eta;
    let alpha = config.alpha;

    let lambda = 2.0 * PI / (n as f64 * eta);
    let b = (n as f64) * lambda / 2.0;

    // Build the integrand x_j = exp(-r T) * psi(v_j) * exp(i v_j b) * eta
    // where psi(v) = exp(-i v ln(K)) CF(v - (α+1)i) / (α² + α - v² + i(2α+1)v)
    let mut input: Vec<Complex64> = Vec::with_capacity(n);

    for j in 0..n {
        let v = j as f64 * eta;
        let u = Complex64::new(v, -(alpha + 1.0));

        let cf_val = model.cf(u, t, r, spot);

        let denom = Complex64::new(
            alpha * alpha + alpha - v * v,
            (2.0 * alpha + 1.0) * v,
        );

        let psi = (-r * t).exp() * cf_val / denom;

        // Simpson's 3/8 weighting for improved accuracy
        let simpson_w = if j == 0 {
            eta / 3.0
        } else if j % 2 == 0 {
            (eta / 3.0) * 2.0
        } else {
            (eta / 3.0) * 4.0
        };

        let phase = Complex64::new(0.0, v * b).exp();
        input.push(psi * phase * simpson_w);
    }

    // FFT
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(n);
    fft.process(&mut input);

    // Extract call prices
    let mut log_strikes = Vec::with_capacity(n);
    let mut call_prices = Vec::with_capacity(n);

    let inv_pi = 1.0 / PI;

    for j in 0..n {
        let k_j = -b + lambda * j as f64;
        log_strikes.push(k_j);

        let c = (inv_pi * input[j].re * (-alpha * k_j).exp()).max(0.0);
        call_prices.push(c);
    }

    (log_strikes, call_prices)
}

/// Price calls at specific strikes by interpolating the FFT grid.
///
/// Returns call prices corresponding to each strike in `strikes`.
pub fn price_at_strikes<CF: CharacteristicFunction>(
    model: &CF,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    config: &CarrMadanConfig,
) -> Vec<f64> {
    let (log_strikes, call_prices) = carr_madan_fft(model, spot, r, t, config);
    let n = log_strikes.len();

    strikes
        .iter()
        .map(|&k| {
            if k <= 0.0 {
                return 0.0;
            }
            let lk = k.ln();

            // Binary search for bracketing interval
            let idx = match log_strikes.binary_search_by(|a| {
                a.partial_cmp(&lk).unwrap_or(std::cmp::Ordering::Equal)
            }) {
                Ok(i) => return call_prices[i],
                Err(i) => i,
            };

            if idx == 0 {
                call_prices[0]
            } else if idx >= n {
                call_prices[n - 1]
            } else {
                // Linear interpolation
                let x0 = log_strikes[idx - 1];
                let x1 = log_strikes[idx];
                let y0 = call_prices[idx - 1];
                let y1 = call_prices[idx];
                let frac = (lk - x0) / (x1 - x0);
                (y0 + frac * (y1 - y0)).max(0.0)
            }
        })
        .collect()
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
    fn test_fft_vs_bsm_atm() {
        let model = BsmCF { sigma: 0.20 };
        let spot = 100.0;
        let r = 0.05;
        let t = 1.0;

        let config = CarrMadanConfig::default();
        let strikes = vec![100.0];
        let fft_prices = price_at_strikes(&model, spot, r, t, &strikes, &config);

        // BSM closed-form for ATM call: ~10.45
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
        // Call(K) - Put(K) = S - K*exp(-rT)
        // Put via parity: Put = Call - S + K*exp(-rT)
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
}
