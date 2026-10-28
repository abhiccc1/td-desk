//! SoA (Structure-of-Arrays) complex batch operations for SIMD-friendly processing.
//!
//! Stores N complex numbers as two contiguous `f64` slices (real, imaginary) instead
//! of N `Complex64` structs.  This layout lets LLVM autovectorize the arithmetic
//! portions (add, sub, mul, div) into AVX2 (4×f64) or NEON (2×f64) instructions
//! when compiled with `-C target-cpu=native`.
//!
//! Transcendental helpers (`batch_complex_exp`, `_ln`, `_sqrt`) split the work into
//! separate tight loops over `f64` arrays so the compiler can vectorize each phase
//! independently.

use num_complex::Complex64;

// ─── SoA container ──────────────────────────────────────────────────

/// N complex numbers stored as two parallel `Vec<f64>`.
#[derive(Clone)]
pub struct SoA {
    pub re: Vec<f64>,
    pub im: Vec<f64>,
}

impl SoA {
    #[inline]
    pub fn zeros(n: usize) -> Self {
        Self {
            re: vec![0.0; n],
            im: vec![0.0; n],
        }
    }

    #[inline]
    pub fn len(&self) -> usize {
        self.re.len()
    }

    /// Pack back into a `Complex64` slice (for `rustfft::Fft::process`).
    #[inline]
    pub fn write_to_complex_slice(&self, out: &mut [Complex64]) {
        let n = self.re.len();
        for j in 0..n {
            out[j] = Complex64::new(self.re[j], self.im[j]);
        }
    }
}

// ─── Batch arithmetic ───────────────────────────────────────────────

/// `out = a * b`  (complex multiply)
#[inline]
pub fn batch_complex_mul(
    a_re: &[f64], a_im: &[f64],
    b_re: &[f64], b_im: &[f64],
    out_re: &mut [f64], out_im: &mut [f64],
) {
    let n = a_re.len();
    for j in 0..n {
        out_re[j] = a_re[j] * b_re[j] - a_im[j] * b_im[j];
        out_im[j] = a_re[j] * b_im[j] + a_im[j] * b_re[j];
    }
}

/// `out = a / b`  (complex divide)
#[inline]
pub fn batch_complex_div(
    a_re: &[f64], a_im: &[f64],
    b_re: &[f64], b_im: &[f64],
    out_re: &mut [f64], out_im: &mut [f64],
) {
    let n = a_re.len();
    for j in 0..n {
        let d = b_re[j] * b_re[j] + b_im[j] * b_im[j];
        out_re[j] = (a_re[j] * b_re[j] + a_im[j] * b_im[j]) / d;
        out_im[j] = (a_im[j] * b_re[j] - a_re[j] * b_im[j]) / d;
    }
}

// ─── Batch transcendentals ──────────────────────────────────────────

/// `out = exp(z)`  where `z = re + i·im`.
///
/// Split into three phases so LLVM can vectorize each independently:
///   1. `e[j] = exp(re[j])`
///   2. `(s[j], c[j]) = sincos(im[j])`
///   3. `out = e * (c + i·s)`
#[inline]
pub fn batch_complex_exp(
    re: &[f64], im: &[f64],
    out_re: &mut [f64], out_im: &mut [f64],
) {
    let n = re.len();

    // Phase 1 — exp of real parts (stored in out_re temporarily)
    for j in 0..n {
        out_re[j] = re[j].exp();
    }

    // Phase 2+3 — sincos of imaginary parts, fused with multiply
    for j in 0..n {
        let (s, c) = im[j].sin_cos();
        let e = out_re[j];
        out_re[j] = e * c;
        out_im[j] = e * s;
    }
}

/// `out = ln(z)`  where `z = re + i·im`.
///
///   `ln(z) = 0.5·ln(re² + im²)  +  i·atan2(im, re)`
#[inline]
pub fn batch_complex_ln(
    re: &[f64], im: &[f64],
    out_re: &mut [f64], out_im: &mut [f64],
) {
    let n = re.len();

    // Phase 1 — magnitude squared (vectorizable arithmetic)
    for j in 0..n {
        out_re[j] = re[j] * re[j] + im[j] * im[j];
    }

    // Phase 2 — ln of magnitude squared, halved
    for j in 0..n {
        out_re[j] = 0.5 * out_re[j].ln();
    }

    // Phase 3 — argument via atan2
    for j in 0..n {
        out_im[j] = im[j].atan2(re[j]);
    }
}

/// `out = sqrt(z)` via half-angle:
///
///   `|z|  = (re² + im²)^0.25`
///   `arg  = atan2(im, re) / 2`
///   `sqrt = |z| · (cos(arg) + i·sin(arg))`
#[inline]
pub fn batch_complex_sqrt(
    re: &[f64], im: &[f64],
    out_re: &mut [f64], out_im: &mut [f64],
) {
    let n = re.len();

    // Phase 1 — magnitude (fourth root of re²+im²)
    // and half-angle
    for j in 0..n {
        let mag_sq = re[j] * re[j] + im[j] * im[j];
        let mag = mag_sq.sqrt().sqrt(); // |z|^0.5
        let half_arg = 0.5 * im[j].atan2(re[j]);
        let (s, c) = half_arg.sin_cos();
        out_re[j] = mag * c;
        out_im[j] = mag * s;
    }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::PI;

    fn assert_close(a: f64, b: f64, tol: f64, msg: &str) {
        assert!(
            (a - b).abs() < tol,
            "{msg}: {a:.12} vs {b:.12}, diff={:.2e}",
            (a - b).abs()
        );
    }

    #[test]
    fn test_batch_complex_mul() {
        // (1+2i) * (3+4i) = (1·3 - 2·4) + i(1·4 + 2·3) = -5 + 10i
        let a_re = [1.0];
        let a_im = [2.0];
        let b_re = [3.0];
        let b_im = [4.0];
        let mut o_re = [0.0];
        let mut o_im = [0.0];
        batch_complex_mul(&a_re, &a_im, &b_re, &b_im, &mut o_re, &mut o_im);
        assert_close(o_re[0], -5.0, 1e-12, "mul re");
        assert_close(o_im[0], 10.0, 1e-12, "mul im");
    }

    #[test]
    fn test_batch_complex_div() {
        // (1+2i) / (3+4i) = (11/25) + i(2/25)
        let a_re = [1.0];
        let a_im = [2.0];
        let b_re = [3.0];
        let b_im = [4.0];
        let mut o_re = [0.0];
        let mut o_im = [0.0];
        batch_complex_div(&a_re, &a_im, &b_re, &b_im, &mut o_re, &mut o_im);
        assert_close(o_re[0], 11.0 / 25.0, 1e-12, "div re");
        assert_close(o_im[0], 2.0 / 25.0, 1e-12, "div im");
    }

    #[test]
    fn test_batch_complex_exp() {
        // exp(1 + i·π) = e·(cos π + i·sin π) = -e + 0i
        let re = [1.0];
        let im = [PI];
        let mut o_re = [0.0];
        let mut o_im = [0.0];
        batch_complex_exp(&re, &im, &mut o_re, &mut o_im);
        let e = 1.0_f64.exp();
        assert_close(o_re[0], -e, 1e-10, "exp re");
        assert_close(o_im[0], 0.0, 1e-10, "exp im");
    }

    #[test]
    fn test_batch_complex_ln() {
        // ln(e + 0i) = (1, 0)
        let e = 1.0_f64.exp();
        let re = [e];
        let im = [0.0];
        let mut o_re = [0.0];
        let mut o_im = [0.0];
        batch_complex_ln(&re, &im, &mut o_re, &mut o_im);
        assert_close(o_re[0], 1.0, 1e-10, "ln re");
        assert_close(o_im[0], 0.0, 1e-10, "ln im");

        // ln(i) = (0, π/2)
        let re2 = [0.0];
        let im2 = [1.0];
        batch_complex_ln(&re2, &im2, &mut o_re, &mut o_im);
        assert_close(o_re[0], 0.0, 1e-10, "ln(i) re");
        assert_close(o_im[0], PI / 2.0, 1e-10, "ln(i) im");
    }

    #[test]
    fn test_batch_complex_sqrt() {
        // sqrt(-1 + 0i) = (0, 1) = i
        let re = [-1.0];
        let im = [0.0];
        let mut o_re = [0.0];
        let mut o_im = [0.0];
        batch_complex_sqrt(&re, &im, &mut o_re, &mut o_im);
        assert_close(o_re[0], 0.0, 1e-10, "sqrt(-1) re");
        assert_close(o_im[0], 1.0, 1e-10, "sqrt(-1) im");

        // sqrt(3 + 4i) ≈ 2 + i
        let re2 = [3.0];
        let im2 = [4.0];
        batch_complex_sqrt(&re2, &im2, &mut o_re, &mut o_im);
        assert_close(o_re[0], 2.0, 1e-10, "sqrt(3+4i) re");
        assert_close(o_im[0], 1.0, 1e-10, "sqrt(3+4i) im");
    }

    #[test]
    fn test_exp_ln_roundtrip() {
        let re = [0.5, -1.2, 3.0, 0.0];
        let im = [1.0, -0.5, 2.5, 0.0];
        let n = re.len();
        let mut exp_re = vec![0.0; n];
        let mut exp_im = vec![0.0; n];
        batch_complex_exp(&re, &im, &mut exp_re, &mut exp_im);

        let mut rt_re = vec![0.0; n];
        let mut rt_im = vec![0.0; n];
        batch_complex_ln(&exp_re, &exp_im, &mut rt_re, &mut rt_im);

        for j in 0..n {
            assert_close(rt_re[j], re[j], 1e-10, &format!("roundtrip re[{j}]"));
            assert_close(rt_im[j], im[j], 1e-10, &format!("roundtrip im[{j}]"));
        }
    }

    #[test]
    fn test_sqrt_squares_back() {
        let re = [2.0, -1.0, 0.0, 5.0];
        let im = [3.0, 4.0, 1.0, -2.0];
        let n = re.len();
        let mut s_re = vec![0.0; n];
        let mut s_im = vec![0.0; n];
        batch_complex_sqrt(&re, &im, &mut s_re, &mut s_im);

        // Square the result: should get back original
        let mut sq_re = vec![0.0; n];
        let mut sq_im = vec![0.0; n];
        batch_complex_mul(&s_re, &s_im, &s_re, &s_im, &mut sq_re, &mut sq_im);

        for j in 0..n {
            assert_close(sq_re[j], re[j], 1e-10, &format!("sq re[{j}]"));
            assert_close(sq_im[j], im[j], 1e-10, &format!("sq im[{j}]"));
        }
    }
}
