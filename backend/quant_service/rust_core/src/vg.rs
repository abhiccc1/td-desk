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

use crate::batch_complex::{batch_complex_exp, batch_complex_ln, batch_complex_mul};
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
        if u_im.len() != n || out_re.len() != n || out_im.len() != n {
            return;
        }

        let sigma = self.sigma;
        let theta = self.theta;
        let nu = self.nu;

        let half_sigma_sq_nu = 0.5 * sigma * sigma * nu;
        let theta_nu = theta * nu;
        let exponent = -t / nu;
        let drift_scale = spot.ln() + (r + (1.0 / nu) * (1.0 - theta * nu - 0.5 * sigma * sigma * nu).ln()) * t;

        let mut u_sq_re = vec![0.0; n];
        let mut u_sq_im = vec![0.0; n];
        batch_complex_mul(u_re, u_im, u_re, u_im, &mut u_sq_re, &mut u_sq_im);

        let mut kernel_re = vec![0.0; n];
        let mut kernel_im = vec![0.0; n];
        for j in 0..n {
            kernel_re[j] = 1.0 + theta_nu * u_im[j] + half_sigma_sq_nu * u_sq_re[j];
            kernel_im[j] = -theta_nu * u_re[j] + half_sigma_sq_nu * u_sq_im[j];
        }

        let mut log_kernel_re = vec![0.0; n];
        let mut log_kernel_im = vec![0.0; n];
        batch_complex_ln(
            &kernel_re,
            &kernel_im,
            &mut log_kernel_re,
            &mut log_kernel_im,
        );

        let mut vg_exp_re = vec![0.0; n];
        let mut vg_exp_im = vec![0.0; n];
        for j in 0..n {
            vg_exp_re[j] = exponent * log_kernel_re[j];
            vg_exp_im[j] = exponent * log_kernel_im[j];
        }

        let mut vg_part_re = vec![0.0; n];
        let mut vg_part_im = vec![0.0; n];
        batch_complex_exp(&vg_exp_re, &vg_exp_im, &mut vg_part_re, &mut vg_part_im);

        let mut drift_re = vec![0.0; n];
        let mut drift_im = vec![0.0; n];
        for j in 0..n {
            drift_re[j] = -u_im[j] * drift_scale;
            drift_im[j] = u_re[j] * drift_scale;
        }

        let mut drift_part_re = vec![0.0; n];
        let mut drift_part_im = vec![0.0; n];
        batch_complex_exp(
            &drift_re,
            &drift_im,
            &mut drift_part_re,
            &mut drift_part_im,
        );

        batch_complex_mul(
            &drift_part_re,
            &drift_part_im,
            &vg_part_re,
            &vg_part_im,
            out_re,
            out_im,
        );
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

// ─── Combined chain (prices + IVs in a single FFT pass) ─────────────

/// Compute call prices, put prices, and call IVs from a single FFT pass.
///
/// This avoids the redundancy of calling `vg_price_chain` followed by N
/// individual `bsm::implied_volatility` calls — everything is done in Rust
/// with only one Python↔Rust crossing.
pub fn vg_chain_full(
    params: &VgParams,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>) {
    // 1. Compute call prices via FFT (single pass)
    let calls = vg_price_calls(params, spot, r, t, strikes);

    // 2. Compute puts via put-call parity (same formula as vg_price_chain)
    let df = (-r * t).exp();
    let puts: Vec<f64> = calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| (c - spot + k * df).max(0.0))
        .collect();

    // 3. Batch IV inversion from call prices (all in Rust, no Python round-trips)
    let ivs: Vec<Option<f64>> = calls
        .iter()
        .zip(strikes.iter())
        .map(|(&c, &k)| bsm::implied_volatility(c, spot, k, t, r, true))
        .collect();

    (calls, puts, ivs)
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
    fn test_vg_cf_batch_matches_scalar() {
        let p = test_params();
        let u_re = vec![0.0, 0.2, 0.7, 1.1];
        let u_im = vec![0.0, -0.5, -1.5, 0.4];
        let mut out_re = vec![0.0; u_re.len()];
        let mut out_im = vec![0.0; u_re.len()];

        p.cf_batch(&u_re, &u_im, 0.08, 0.065, 22000.0, &mut out_re, &mut out_im);

        for j in 0..u_re.len() {
            let scalar = p.cf(Complex64::new(u_re[j], u_im[j]), 0.08, 0.065, 22000.0);
            assert!(
                (out_re[j] - scalar.re).abs() < 1e-10,
                "batch cf real mismatch at {j}: {} vs {}",
                out_re[j],
                scalar.re,
            );
            assert!(
                (out_im[j] - scalar.im).abs() < 1e-10,
                "batch cf imag mismatch at {j}: {} vs {}",
                out_im[j],
                scalar.im,
            );
        }
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
