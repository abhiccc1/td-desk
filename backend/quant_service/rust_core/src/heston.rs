//! Heston stochastic volatility model.
//!
//! Implements the Heston (1993) characteristic function and pricing via the
//! Carr-Madan FFT engine. Also provides IV inversion (Heston price → BSM IV).
//!
//! The Heston model:
//!   dS = r S dt + √v S dW₁
//!   dv = κ(θ − v) dt + σ_v √v dW₂
//!   dW₁ dW₂ = ρ dt

use num_complex::Complex64;

use crate::bsm;
use crate::fft::{self, CarrMadanConfig, CharacteristicFunction};

// ─── Parameters ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct HestonParams {
    /// Mean-reversion speed.
    pub kappa: f64,
    /// Long-run variance.
    pub theta: f64,
    /// Vol-of-vol.
    pub sigma_v: f64,
    /// Correlation between spot and vol Brownian motions.
    pub rho: f64,
    /// Initial (current) variance.
    pub v0: f64,
}

// ─── Characteristic function ────────────────────────────────────────

impl CharacteristicFunction for HestonParams {
    /// Heston CF using the "Albrecher et al." (2007) formulation which avoids
    /// the branch-cut discontinuity in the original Heston formula.
    fn cf(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64 {
        let i = Complex64::i();
        let kappa = self.kappa;
        let theta = self.theta;
        let sigma = self.sigma_v;
        let rho = self.rho;
        let v0 = self.v0;

        let log_spot = spot.ln();

        // Auxiliary variables
        let xi = kappa - i * rho * sigma * u;
        let d = (xi * xi + sigma * sigma * u * (u + i)).sqrt();

        // Avoid numerical blow-up: use the formulation g = (xi - d) / (xi + d)
        let g = (xi - d) / (xi + d);
        let exp_dt = (-d * t).exp();

        let c = kappa * theta / (sigma * sigma)
            * ((xi - d) * t - 2.0 * ((1.0 - g * exp_dt) / (1.0 - g)).ln());

        let dd = (xi - d) / (sigma * sigma) * ((1.0 - exp_dt) / (1.0 - g * exp_dt));

        (i * u * (log_spot + r * t) + c + dd * v0).exp()
    }
}

// ─── Pricing ────────────────────────────────────────────────────────

/// Price European calls at given strikes under Heston via FFT.
pub fn heston_price_calls(
    params: &HestonParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<f64> {
    let config = CarrMadanConfig::default();
    fft::price_at_strikes(params, spot, r, t, strikes, &config)
}

/// Price European puts via put-call parity: P = C - S + K exp(-rT).
pub fn heston_price_puts(
    params: &HestonParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<f64> {
    let calls = heston_price_calls(params, spot, r, t, strikes);
    let df = (-r * t).exp();
    calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| (c - spot + k * df).max(0.0))
        .collect()
}

/// Price an entire chain (calls and puts) under Heston.
/// Returns `(strikes, call_prices, put_prices)`.
pub fn heston_price_chain(
    params: &HestonParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let calls = heston_price_calls(params, spot, r, t, strikes);
    let df = (-r * t).exp();
    let puts: Vec<f64> = calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| (c - spot + k * df).max(0.0))
        .collect();
    (calls, puts)
}

// ─── IV inversion ───────────────────────────────────────────────────

/// Convert Heston call prices to BSM implied vols using the warm-start IV solver.
pub fn heston_iv_calls(
    params: &HestonParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<Option<f64>> {
    let calls = heston_price_calls(params, spot, r, t, strikes);
    calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| bsm::implied_volatility(c, spot, k, t, r, true))
        .collect()
}

/// Convert Heston put prices to BSM implied vols.
pub fn heston_iv_puts(
    params: &HestonParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<Option<f64>> {
    let puts = heston_price_puts(params, spot, r, t, strikes);
    puts.iter()
        .zip(strikes.iter())
        .map(|(&p, &k)| bsm::implied_volatility(p, spot, k, t, r, false))
        .collect()
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_params() -> HestonParams {
        HestonParams {
            kappa: 1.8,
            theta: 0.04,
            sigma_v: 0.6,
            rho: -0.55,
            v0: 0.03,
        }
    }

    #[test]
    fn test_heston_cf_at_zero() {
        let p = test_params();
        // CF(0) should be 1 for any model
        let cf0 = p.cf(Complex64::new(0.0, 0.0), 0.5, 0.05, 100.0);
        assert!(
            (cf0.re - 1.0).abs() < 1e-10 && cf0.im.abs() < 1e-10,
            "CF(0) = {cf0}, expected 1+0i",
        );
    }

    #[test]
    fn test_heston_prices_positive() {
        let p = test_params();
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;
        let strikes: Vec<f64> = (20000..=24000).step_by(500).map(|k| k as f64).collect();

        let calls = heston_price_calls(&p, spot, r, t, &strikes);
        let puts = heston_price_puts(&p, spot, r, t, &strikes);

        for (i, &k) in strikes.iter().enumerate() {
            assert!(calls[i] >= 0.0, "Negative call at K={k}: {}", calls[i]);
            assert!(puts[i] >= 0.0, "Negative put at K={k}: {}", puts[i]);
        }
    }

    #[test]
    fn test_heston_put_call_parity() {
        let p = test_params();
        let spot = 100.0;
        let r = 0.05;
        let t = 0.5;
        let strikes = vec![90.0, 100.0, 110.0];

        let (calls, puts) = heston_price_chain(&p, spot, r, t, &strikes);
        let df = (-r * t).exp();

        for (i, &k) in strikes.iter().enumerate() {
            let parity = calls[i] - puts[i] - spot + k * df;
            assert!(
                parity.abs() < 0.1,
                "Parity violated at K={k}: C={:.4}, P={:.4}, err={parity:.6}",
                calls[i],
                puts[i],
            );
        }
    }

    #[test]
    fn test_heston_iv_roundtrip() {
        let p = test_params();
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;
        let strikes: Vec<f64> = (21000..=23000).step_by(500).map(|k| k as f64).collect();

        let ivs = heston_iv_calls(&p, spot, r, t, &strikes);

        for (i, iv_opt) in ivs.iter().enumerate() {
            assert!(
                iv_opt.is_some(),
                "IV solve failed at K={}",
                strikes[i],
            );
            let iv = iv_opt.unwrap();
            assert!(
                iv > 0.0 && iv < 2.0,
                "IV out of range at K={}: {}",
                strikes[i],
                iv,
            );
        }
    }

    #[test]
    fn test_heston_smile_shape() {
        // Heston with negative rho should produce a skew: OTM puts have higher IV
        let p = HestonParams {
            kappa: 2.0,
            theta: 0.04,
            sigma_v: 0.5,
            rho: -0.7,
            v0: 0.04,
        };
        let spot = 100.0;
        let r = 0.05;
        let t = 0.25;

        let strikes = vec![85.0, 100.0, 115.0];
        let ivs = heston_iv_calls(&p, spot, r, t, &strikes);

        let iv_otm_put = ivs[0].unwrap();  // K=85, deep ITM call = OTM put
        let iv_atm = ivs[1].unwrap();      // K=100
        let iv_otm_call = ivs[2].unwrap(); // K=115, OTM call

        // With rho=-0.7, downside IV should exceed upside IV (negative skew)
        assert!(
            iv_otm_put > iv_atm,
            "Expected downside skew: IV(85)={iv_otm_put:.4} > IV(100)={iv_atm:.4}",
        );
        assert!(
            iv_atm > iv_otm_call || (iv_atm - iv_otm_call).abs() < 0.02,
            "Expected ATM >= upside: IV(100)={iv_atm:.4}, IV(115)={iv_otm_call:.4}",
        );
    }
}
