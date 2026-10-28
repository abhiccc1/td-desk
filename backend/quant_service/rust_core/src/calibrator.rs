//! Model calibration — fits Heston and VG parameters to SVI IV surface.
//!
//! Implements Particle Swarm Optimization for Heston (5 params, global search)
//! and Nelder-Mead for VG (3 params, local search).  Both calibrations run
//! in parallel via `rayon::join`, reducing what was 500+ Python↔Rust crossings
//! to a single call.

use crate::heston::{self, HestonParams};
use crate::svi::{self, SviParams};
use crate::vg::{self, VgParams};

// ─── Simple PRNG (xorshift64*) ──────────────────────────────────────

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(if seed == 0 { 1 } else { seed })
    }

    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0.wrapping_mul(0x2545F4914F6CDD1D)
    }

    /// Uniform random f64 in [0, 1).
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / ((1u64 << 53) as f64)
    }

    /// Uniform random f64 in [lo, hi).
    fn uniform(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next_f64()
    }
}

// ─── Particle Swarm Optimization ────────────────────────────────────

struct PsoConfig {
    num_particles: usize,
    max_iter: usize,
    w: f64,
    c1: f64,
    c2: f64,
    seed: u64,
}

impl Default for PsoConfig {
    fn default() -> Self {
        Self {
            num_particles: 10,
            max_iter: 50,
            w: 0.7298,
            c1: 1.49618,
            c2: 1.49618,
            seed: 42,
        }
    }
}

fn pso_minimize<F>(
    objective: &F,
    bounds: &[(f64, f64)],
    config: &PsoConfig,
) -> (Vec<f64>, f64)
where
    F: Fn(&[f64]) -> f64,
{
    let dim = bounds.len();
    let n = config.num_particles;
    let mut rng = Rng::new(config.seed);

    // Initialize particles
    let mut positions: Vec<Vec<f64>> = (0..n)
        .map(|_| bounds.iter().map(|&(lo, hi)| rng.uniform(lo, hi)).collect())
        .collect();
    let mut velocities: Vec<Vec<f64>> = (0..n)
        .map(|_| {
            bounds
                .iter()
                .map(|&(lo, hi)| rng.uniform(-(hi - lo), hi - lo) * 0.1)
                .collect()
        })
        .collect();

    let mut personal_best_pos: Vec<Vec<f64>> = positions.clone();
    let mut personal_best_cost: Vec<f64> = positions.iter().map(|p| objective(p)).collect();

    // Global best
    let mut global_best_idx = 0;
    for i in 1..n {
        if personal_best_cost[i] < personal_best_cost[global_best_idx] {
            global_best_idx = i;
        }
    }
    let mut global_best_pos = personal_best_pos[global_best_idx].clone();
    let mut global_best_cost = personal_best_cost[global_best_idx];

    for _ in 0..config.max_iter {
        for i in 0..n {
            for d in 0..dim {
                let r1 = rng.next_f64();
                let r2 = rng.next_f64();
                velocities[i][d] = config.w * velocities[i][d]
                    + config.c1 * r1 * (personal_best_pos[i][d] - positions[i][d])
                    + config.c2 * r2 * (global_best_pos[d] - positions[i][d]);
                positions[i][d] += velocities[i][d];
                positions[i][d] = positions[i][d].clamp(bounds[d].0, bounds[d].1);
            }

            let cost = objective(&positions[i]);

            if cost < personal_best_cost[i] {
                personal_best_cost[i] = cost;
                personal_best_pos[i] = positions[i].clone();

                if cost < global_best_cost {
                    global_best_cost = cost;
                    global_best_pos = positions[i].clone();
                }
            }
        }
    }

    (global_best_pos, global_best_cost)
}

// ─── Nelder-Mead (Downhill Simplex) ────────────────────────────────

struct NelderMeadConfig {
    max_iter: usize,
    tol: f64,
}

impl Default for NelderMeadConfig {
    fn default() -> Self {
        Self {
            max_iter: 500,
            tol: 1e-8,
        }
    }
}

fn nelder_mead_minimize<F>(
    objective: &F,
    x0: &[f64],
    step_size: f64,
    config: &NelderMeadConfig,
    bounds: Option<&[(f64, f64)]>,
) -> (Vec<f64>, f64)
where
    F: Fn(&[f64]) -> f64,
{
    let n = x0.len();
    let alpha = 1.0; // reflection
    let gamma = 2.0; // expansion
    let rho = 0.5; // contraction
    let sigma = 0.5; // shrink

    let clamp = |point: &mut [f64]| {
        if let Some(b) = bounds {
            for (i, &(lo, hi)) in b.iter().enumerate() {
                point[i] = point[i].clamp(lo, hi);
            }
        }
    };

    // Build initial simplex
    let mut simplex: Vec<(Vec<f64>, f64)> = Vec::with_capacity(n + 1);
    let mut p0 = x0.to_vec();
    clamp(&mut p0);
    simplex.push((p0.clone(), objective(&p0)));

    for i in 0..n {
        let mut p = x0.to_vec();
        p[i] += step_size;
        clamp(&mut p);
        simplex.push((p.clone(), objective(&p)));
    }

    for _ in 0..config.max_iter {
        simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));

        if simplex.last().unwrap().1 - simplex.first().unwrap().1 < config.tol {
            break;
        }

        // Centroid (excluding worst)
        let mut centroid = vec![0.0; n];
        for j in 0..n {
            for d in 0..n {
                centroid[d] += simplex[j].0[d];
            }
        }
        for d in 0..n {
            centroid[d] /= n as f64;
        }

        // Reflection
        let mut reflected: Vec<f64> = (0..n)
            .map(|d| centroid[d] + alpha * (centroid[d] - simplex[n].0[d]))
            .collect();
        clamp(&mut reflected);
        let f_r = objective(&reflected);

        if f_r < simplex[n - 1].1 && f_r >= simplex[0].1 {
            simplex[n] = (reflected, f_r);
            continue;
        }

        if f_r < simplex[0].1 {
            // Expansion
            let mut expanded: Vec<f64> = (0..n)
                .map(|d| centroid[d] + gamma * (reflected[d] - centroid[d]))
                .collect();
            clamp(&mut expanded);
            let f_e = objective(&expanded);
            simplex[n] = if f_e < f_r {
                (expanded, f_e)
            } else {
                (reflected, f_r)
            };
            continue;
        }

        // Contraction
        let mut contracted: Vec<f64> = (0..n)
            .map(|d| centroid[d] + rho * (simplex[n].0[d] - centroid[d]))
            .collect();
        clamp(&mut contracted);
        let f_c = objective(&contracted);

        if f_c < simplex[n].1 {
            simplex[n] = (contracted, f_c);
            continue;
        }

        // Shrink toward best
        let best = simplex[0].0.clone();
        for j in 1..=n {
            let mut shrunk: Vec<f64> = (0..n)
                .map(|d| best[d] + sigma * (simplex[j].0[d] - best[d]))
                .collect();
            clamp(&mut shrunk);
            let f_s = objective(&shrunk);
            simplex[j] = (shrunk, f_s);
        }
    }

    simplex.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    simplex.into_iter().next().unwrap()
}

// ─── Target generation ──────────────────────────────────────────────

pub fn generate_svi_targets(
    svi_params: &SviParams,
    spot: f64,
    t: f64,
    num_points: usize,
    k_range: f64,
) -> (Vec<f64>, Vec<f64>) {
    let mut strikes = Vec::with_capacity(num_points);
    let mut target_ivs = Vec::with_capacity(num_points);

    let denom = if num_points > 1 {
        (num_points - 1) as f64
    } else {
        1.0
    };

    for i in 0..num_points {
        let k = -k_range + 2.0 * k_range * (i as f64) / denom;
        let iv = svi::svi_to_iv(svi_params, k, t);
        if iv > 0.01 && iv < 2.0 {
            strikes.push(spot * k.exp());
            target_ivs.push(iv);
        }
    }

    (strikes, target_ivs)
}

// ─── Heston calibration ─────────────────────────────────────────────

const HESTON_BOUNDS: [(f64, f64); 5] = [
    (0.1, 10.0),   // kappa
    (0.005, 1.0),  // theta
    (0.05, 3.0),   // sigma_v
    (-0.99, 0.01), // rho
    (0.005, 1.0),  // v0
];

fn heston_objective(
    x: &[f64],
    strikes: &[f64],
    target_ivs: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> f64 {
    let params = HestonParams {
        kappa: x[0],
        theta: x[1],
        sigma_v: x[2],
        rho: x[3],
        v0: x[4],
    };

    // Feller condition penalty: 2κθ > σ_v²
    let feller_gap = 2.0 * params.kappa * params.theta - params.sigma_v * params.sigma_v;
    if feller_gap < 0.0 {
        return 1e6 + feller_gap.abs() * 100.0;
    }

    let model_ivs = heston::heston_iv_calls(&params, spot, r, t, strikes);

    let mut sse = 0.0;
    let mut n_valid = 0usize;
    for (&tgt, mdl) in target_ivs.iter().zip(model_ivs.iter()) {
        if let Some(&iv) = mdl.as_ref() {
            if iv > 0.0 {
                sse += (iv - tgt) * (iv - tgt);
                n_valid += 1;
            }
        }
    }

    // Reject if >50% strikes failed IV inversion
    if n_valid < target_ivs.len() / 2 {
        return 1e6;
    }

    sse / n_valid as f64
}

pub fn calibrate_heston(
    strikes: &[f64],
    target_ivs: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> Option<(HestonParams, f64)> {
    let obj = |x: &[f64]| heston_objective(x, strikes, target_ivs, spot, r, t);

    // Phase 1: PSO global search
    let pso_config = PsoConfig {
        num_particles: 10,
        max_iter: 50,
        seed: 42,
        ..Default::default()
    };
    let (pso_best, _) = pso_minimize(&obj, &HESTON_BOUNDS, &pso_config);

    // Phase 2: Nelder-Mead polish
    let nm_config = NelderMeadConfig {
        max_iter: 200,
        ..Default::default()
    };
    let (best, cost) = nelder_mead_minimize(&obj, &pso_best, 0.01, &nm_config, Some(&HESTON_BOUNDS));

    if cost > 0.01 {
        return None;
    }

    Some((
        HestonParams {
            kappa: best[0],
            theta: best[1],
            sigma_v: best[2],
            rho: best[3],
            v0: best[4],
        },
        cost.sqrt(),
    ))
}

// ─── VG calibration ─────────────────────────────────────────────────

const VG_BOUNDS: [(f64, f64); 3] = [
    (0.01, 2.0),  // sigma
    (-1.0, 0.5),  // theta
    (0.01, 2.0),  // nu
];

fn vg_objective(
    x: &[f64],
    strikes: &[f64],
    target_ivs: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> f64 {
    let params = VgParams {
        sigma: x[0],
        theta: x[1],
        nu: x[2],
    };

    // Martingale condition: 1 − θν − ½σ²ν > 0
    let martingale = 1.0 - params.theta * params.nu - 0.5 * params.sigma * params.sigma * params.nu;
    if martingale <= 0.0 {
        return 1e6 + martingale.abs() * 100.0;
    }

    let model_ivs = vg::vg_iv_calls(&params, spot, r, t, strikes);

    let mut sse = 0.0;
    let mut n_valid = 0usize;
    for (&tgt, mdl) in target_ivs.iter().zip(model_ivs.iter()) {
        if let Some(&iv) = mdl.as_ref() {
            if iv > 0.0 {
                sse += (iv - tgt) * (iv - tgt);
                n_valid += 1;
            }
        }
    }

    if n_valid < target_ivs.len() / 2 {
        return 1e6;
    }

    sse / n_valid as f64
}

pub fn calibrate_vg(
    strikes: &[f64],
    target_ivs: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> Option<(VgParams, f64)> {
    let atm_iv = target_ivs.get(target_ivs.len() / 2).copied().unwrap_or(0.20);
    let x0 = [atm_iv, -0.10, 0.20];

    let obj = |x: &[f64]| vg_objective(x, strikes, target_ivs, spot, r, t);

    // First: Nelder-Mead from informed starting point
    let nm_config = NelderMeadConfig {
        max_iter: 500,
        ..Default::default()
    };
    let (best, cost) = nelder_mead_minimize(&obj, &x0, 0.05, &nm_config, Some(&VG_BOUNDS));

    // If NM didn't converge, try PSO + NM
    let (final_best, final_cost) = if cost > 0.001 {
        let pso_config = PsoConfig {
            num_particles: 10,
            max_iter: 50,
            seed: 42,
            ..Default::default()
        };
        let (pso_best, _) = pso_minimize(&obj, &VG_BOUNDS, &pso_config);
        let (nm_best, nm_cost) =
            nelder_mead_minimize(&obj, &pso_best, 0.01, &nm_config, Some(&VG_BOUNDS));
        if nm_cost < cost {
            (nm_best, nm_cost)
        } else {
            (best, cost)
        }
    } else {
        (best, cost)
    };

    if final_cost > 0.01 {
        return None;
    }

    Some((
        VgParams {
            sigma: final_best[0],
            theta: final_best[1],
            nu: final_best[2],
        },
        final_cost.sqrt(),
    ))
}

// ─── Combined calibration ───────────────────────────────────────────

pub struct CalibrationResult {
    pub heston: Option<(HestonParams, f64)>,
    pub vg: Option<(VgParams, f64)>,
}

pub fn calibrate_both(
    svi_params: &SviParams,
    spot: f64,
    r: f64,
    t: f64,
    num_points: usize,
    k_range: f64,
) -> CalibrationResult {
    let (strikes, target_ivs) = generate_svi_targets(svi_params, spot, t, num_points, k_range);

    if strikes.len() < 10 {
        return CalibrationResult {
            heston: None,
            vg: None,
        };
    }

    let (heston, vg) = rayon::join(
        || calibrate_heston(&strikes, &target_ivs, spot, r, t),
        || calibrate_vg(&strikes, &target_ivs, spot, r, t),
    );

    CalibrationResult { heston, vg }
}

// ─── Tests ──────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pso_rosenbrock() {
        let rosenbrock =
            |x: &[f64]| (1.0 - x[0]).powi(2) + 100.0 * (x[1] - x[0] * x[0]).powi(2);
        let bounds = [(-5.0, 5.0), (-5.0, 5.0)];
        let config = PsoConfig {
            num_particles: 20,
            max_iter: 200,
            seed: 42,
            ..Default::default()
        };
        let (best, cost) = pso_minimize(&rosenbrock, &bounds, &config);
        assert!(
            cost < 1.0,
            "PSO should approach Rosenbrock minimum, got cost={cost}"
        );
        assert!(
            (best[0] - 1.0).abs() < 0.5,
            "x should be near 1.0, got {}",
            best[0]
        );
    }

    #[test]
    fn test_nelder_mead_quadratic() {
        let quadratic = |x: &[f64]| (x[0] - 3.0).powi(2) + (x[1] + 1.0).powi(2);
        let config = NelderMeadConfig::default();
        let (best, cost) = nelder_mead_minimize(&quadratic, &[0.0, 0.0], 1.0, &config, None);
        assert!(
            cost < 1e-8,
            "NM should converge near the minimum, got cost={cost}"
        );
        assert!((best[0] - 3.0).abs() < 1e-4);
        assert!((best[1] + 1.0).abs() < 1e-4);
    }

    #[test]
    fn test_generate_svi_targets() {
        let svi = SviParams {
            a: 0.04,
            b: 0.08,
            rho: -0.4,
            m: 0.01,
            sigma: 0.15,
        };
        let (strikes, ivs) = generate_svi_targets(&svi, 22000.0, 0.08, 25, 0.15);
        assert!(
            strikes.len() >= 20,
            "Should generate enough targets, got {}",
            strikes.len()
        );
        for &iv in &ivs {
            assert!(iv > 0.01 && iv < 2.0, "IV out of range: {iv}");
        }
    }

    #[test]
    fn test_heston_calibration_roundtrip() {
        let true_heston = HestonParams {
            kappa: 1.8,
            theta: 0.04,
            sigma_v: 0.6,
            rho: -0.55,
            v0: 0.03,
        };
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;

        // Generate Heston IVs → fit SVI → calibrate Heston back
        let strikes: Vec<f64> = (0..25)
            .map(|i| spot * (-0.15 + 0.3 * i as f64 / 24.0).exp())
            .collect();
        let heston_ivs = heston::heston_iv_calls(&true_heston, spot, r, t, &strikes);

        let ks: Vec<f64> = strikes.iter().map(|&k| (k / spot).ln()).collect();
        let (valid_ks, valid_ivs): (Vec<f64>, Vec<f64>) = ks
            .iter()
            .zip(heston_ivs.iter())
            .filter_map(|(&k, iv)| iv.map(|v| (k, v)))
            .unzip();

        let svi = svi::svi_calibrate(&valid_ks, &valid_ivs, t, None).unwrap();

        let result = calibrate_both(&svi, spot, r, t, 25, 0.15);
        assert!(result.heston.is_some(), "Heston calibration should succeed");

        let (_, rmse) = result.heston.unwrap();
        assert!(rmse < 0.05, "RMSE should be < 5%, got {rmse:.4}");
    }

    #[test]
    fn test_vg_calibration_roundtrip() {
        let true_vg = VgParams {
            sigma: 0.12,
            theta: -0.14,
            nu: 0.2,
        };
        let spot = 22000.0;
        let r = 0.065;
        let t = 0.08;

        let strikes: Vec<f64> = (0..25)
            .map(|i| spot * (-0.15 + 0.3 * i as f64 / 24.0).exp())
            .collect();
        let vg_ivs = vg::vg_iv_calls(&true_vg, spot, r, t, &strikes);

        let (valid_ks, valid_ivs): (Vec<f64>, Vec<f64>) = strikes
            .iter()
            .map(|&k| (k / spot).ln())
            .zip(vg_ivs.iter())
            .filter_map(|(k, iv)| iv.map(|v| (k, v)))
            .unzip();

        let svi = svi::svi_calibrate(&valid_ks, &valid_ivs, t, None).unwrap();

        let result = calibrate_both(&svi, spot, r, t, 25, 0.15);
        assert!(result.vg.is_some(), "VG calibration should succeed");

        let (_, rmse) = result.vg.unwrap();
        assert!(rmse < 0.05, "RMSE should be < 5%, got {rmse:.4}");
    }
}
