//! Variance Gamma (VG) jump-diffusion model.
//!
//! Implements the Madan, Carr & Chang (1998) characteristic function and pricing
//! via the Carr-Madan FFT engine.  Also provides IV inversion (VG price → BSM IV).
//!
//! The VG process is a Brownian motion with drift evaluated at a random time
//! given by a Gamma process, producing heavier tails and skew vs BSM.
//!
//! Parameters:
//!   σ  — volatility of the Brownian component
//!   θ  — drift of the Brownian component (controls skew)
//!   ν  — variance rate of the Gamma time change (controls kurtosis)

use num_complex::Complex64;

use crate::bsm;
use crate::fft::{self, CarrMadanConfig, CharacteristicFunction};

// ─── Parameters ─────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct VgParams {
    /// Volatility of the Brownian component.
    pub sigma: f64,
    /// Drift of the Brownian component (controls skew; negative → negative skew).
    pub theta: f64,
    /// Variance rate of the Gamma subordinator (controls excess kurtosis).
    pub nu: f64,
}

// ─── Characteristic function ────────────────────────────────────────

impl CharacteristicFunction for VgParams {
    /// Risk-neutral VG characteristic function:
    ///
    ///   φ(u) = exp(i·u·(ln S + (r + ω)·t)) × (1 − iuθν + ½σ²νu²)^(−t/ν)
    ///
    /// where ω = (1/ν) · ln(1 − θν − σ²ν/2) is the martingale correction.
    fn cf(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64 {
        let i = Complex64::i();
        let sigma = self.sigma;
        let theta = self.theta;
        let nu = self.nu;

        let log_spot = spot.ln();

        // Martingale correction: ω = (1/ν) ln(1 − θν − σ²ν/2)
        let omega = (1.0 / nu) * (1.0 - theta * nu - 0.5 * sigma * sigma * nu).ln();

        // VG CF kernel: (1 − iuθν + ½σ²νu²)^(−t/ν)
        let kernel = Complex64::new(1.0, 0.0)
            - i * u * theta * nu
            + 0.5 * sigma * sigma * nu * u * u;

        let exponent = -t / nu;

        // kernel^exponent via exp(exponent * ln(kernel))
        let vg_part = (exponent * kernel.ln()).exp();

        // Full CF: exp(iu(ln S + (r+ω)t)) × vg_part
        let drift_part = (i * u * (log_spot + (r + omega) * t)).exp();

        drift_part * vg_part
    }
}

// ─── Pricing ────────────────────────────────────────────────────────

/// Price European calls at given strikes under VG via FFT.
pub fn vg_price_calls(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<f64> {
    let config = CarrMadanConfig::default();
    fft::price_at_strikes(params, spot, r, t, strikes, &config)
}

/// Price European puts via put-call parity: P = C - S + K exp(-rT).
pub fn vg_price_puts(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<f64> {
    let calls = vg_price_calls(params, spot, r, t, strikes);
    let df = (-r * t).exp();
    calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| (c - spot + k * df).max(0.0))
        .collect()
}

/// Price an entire chain (calls and puts) under VG.
/// Returns `(call_prices, put_prices)`.
pub fn vg_price_chain(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> (Vec<f64>, Vec<f64>) {
    let calls = vg_price_calls(params, spot, r, t, strikes);
    let df = (-r * t).exp();
    let puts: Vec<f64> = calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| (c - spot + k * df).max(0.0))
        .collect();
    (calls, puts)
}

// ─── IV inversion ───────────────────────────────────────────────────

/// Convert VG call prices to BSM implied vols using the warm-start IV solver.
pub fn vg_iv_calls(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<Option<f64>> {
    let calls = vg_price_calls(params, spot, r, t, strikes);
    calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| bsm::implied_volatility(c, spot, k, t, r, true))
        .collect()
}

/// Convert VG put prices to BSM implied vols.
pub fn vg_iv_puts(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> Vec<Option<f64>> {
    let puts = vg_price_puts(params, spot, r, t, strikes);
    puts.iter()
        .zip(strikes.iter())
        .map(|(&p, &k)| bsm::implied_volatility(p, spot, k, t, r, false))
        .collect()
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn test_params() -> VgParams {
        VgParams {
            sigma: 0.12,
            theta: -0.14,
            nu: 0.2,
        }
    }

    #[test]
    fn test_vg_cf_at_zero() {
        let p = test_params();
        // CF(0) should be 1 for any model
        let cf0 = p.cf(Complex64::new(0.0, 0.0), 0.5, 0.05, 100.0);
        assert!(
            (cf0.re - 1.0).abs() < 1e-10 && cf0.im.abs() < 1e-10,
            "CF(0) = {cf0}, expected 1+0i",
        );
    }

    #[test]
    fn test_vg_prices_positive() {
        let p = test_params();
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;
        let strikes: Vec<f64> = (20000..=24000).step_by(500).map(|k| k as f64).collect();

        let calls = vg_price_calls(&p, spot, r, t, &strikes);
        let puts = vg_price_puts(&p, spot, r, t, &strikes);

        for (i, &k) in strikes.iter().enumerate() {
            assert!(calls[i] >= 0.0, "Negative call at K={k}: {}", calls[i]);
            assert!(puts[i] >= 0.0, "Negative put at K={k}: {}", puts[i]);
        }
    }

    #[test]
    fn test_vg_put_call_parity() {
        let p = test_params();
        let spot = 100.0;
        let r = 0.05;
        let t = 0.5;
        let strikes = vec![90.0, 100.0, 110.0];

        let (calls, puts) = vg_price_chain(&p, spot, r, t, &strikes);
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
    fn test_vg_iv_roundtrip() {
        let p = test_params();
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;
        let strikes: Vec<f64> = (21000..=23000).step_by(500).map(|k| k as f64).collect();

        let ivs = vg_iv_calls(&p, spot, r, t, &strikes);

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
    fn test_vg_fat_tails() {
        // High ν (more kurtosis) should produce higher OTM IVs than low ν
        let low_nu = VgParams {
            sigma: 0.15,
            theta: -0.10,
            nu: 0.05,
        };
        let high_nu = VgParams {
            sigma: 0.15,
            theta: -0.10,
            nu: 0.5,
        };
        let spot = 100.0;
        let r = 0.05;
        let t = 0.25;

        // Deep OTM put strike (= deep ITM call → low strike)
        let otm_strike = vec![85.0];

        let iv_low = vg_iv_calls(&low_nu, spot, r, t, &otm_strike)[0].unwrap();
        let iv_high = vg_iv_calls(&high_nu, spot, r, t, &otm_strike)[0].unwrap();

        assert!(
            iv_high > iv_low,
            "Higher ν should produce fatter tails: IV(ν=0.5)={iv_high:.4} <= IV(ν=0.05)={iv_low:.4}",
        );
    }

    #[test]
    fn test_vg_skew() {
        // Negative θ should produce negative skew: IV(low K) > IV(high K)
        let p = VgParams {
            sigma: 0.15,
            theta: -0.20,
            nu: 0.2,
        };
        let spot = 100.0;
        let r = 0.05;
        let t = 0.25;

        let strikes = vec![85.0, 100.0, 115.0];
        let ivs = vg_iv_calls(&p, spot, r, t, &strikes);

        let iv_low_k = ivs[0].unwrap();   // K=85
        let iv_atm = ivs[1].unwrap();     // K=100
        let iv_high_k = ivs[2].unwrap();  // K=115

        // Negative θ → negative skew: downside IV > ATM IV
        assert!(
            iv_low_k > iv_atm,
            "Expected negative skew: IV(85)={iv_low_k:.4} > IV(100)={iv_atm:.4}",
        );
        // Downside IV > upside IV
        assert!(
            iv_low_k > iv_high_k,
            "Expected skew: IV(85)={iv_low_k:.4} > IV(115)={iv_high_k:.4}",
        );
    }
}
