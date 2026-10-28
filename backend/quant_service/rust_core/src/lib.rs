mod batch_complex;
mod bsm;
mod calibrator;
mod fft;
mod heston;
mod svi;
mod vg;

use pyo3::prelude::*;
use std::collections::HashMap;

type ModelSnapshotArrays = (
    Option<Vec<f64>>,
    Option<Vec<f64>>,
    Option<Vec<Option<f64>>>,
    Option<Vec<f64>>,
    Option<Vec<f64>>,
);

type DualModelSnapshotArrays = (ModelSnapshotArrays, ModelSnapshotArrays);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotMode {
    Fast,
    Slow,
    Full,
}

impl SnapshotMode {
    fn parse(mode: &str) -> PyResult<Self> {
        match mode {
            "fast" => Ok(Self::Fast),
            "slow" => Ok(Self::Slow),
            "full" => Ok(Self::Full),
            _ => Err(pyo3::exceptions::PyValueError::new_err(
                format!("Unknown snapshot mode: {mode}. Supported: fast, slow, full"),
            )),
        }
    }

    fn needs_fast(self) -> bool {
        matches!(self, Self::Fast | Self::Full)
    }

    fn needs_slow(self) -> bool {
        matches!(self, Self::Slow | Self::Full)
    }
}

fn compute_snapshot_for_model<P, F>(
    mode: SnapshotMode,
    params: &P,
    spot: f64,
    r: f64,
    t: f64,
    strikes: &[f64],
    spot_grid: Option<&[f64]>,
    config: &fft::CarrMadanConfig,
    chain_fn: F,
) -> ModelSnapshotArrays
where
    P: fft::CharacteristicFunction,
    F: Fn(&P, f64, f64, f64, &[f64]) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>),
{
    let (calls, puts, ivs) = if mode.needs_fast() {
        let (calls, puts, ivs) = chain_fn(params, spot, r, t, strikes);
        (Some(calls), Some(puts), Some(ivs))
    } else {
        (None, None, None)
    };

    let (density, cdf) = if mode.needs_slow() {
        let grid = spot_grid.expect("spot grid required for slow/full snapshot mode");
        let (density, cdf) = fft::risk_neutral_density_and_cdf(params, spot, r, t, grid, config);
        (Some(density), Some(cdf))
    } else {
        (None, None)
    };

    (calls, puts, ivs, density, cdf)
}

fn compute_model_snapshot_impl(
    mode: SnapshotMode,
    heston_params: HashMap<String, f64>,
    vg_params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
    spot_grid: Option<Vec<f64>>,
) -> DualModelSnapshotArrays {
    let hp = parse_heston_params(&heston_params);
    let vp = parse_vg_params(&vg_params);
    let config = fft::CarrMadanConfig::default();
    let spot_grid_ref = spot_grid.as_deref();

    (
        compute_snapshot_for_model(
            mode,
            &hp,
            spot,
            r,
            t,
            &strikes,
            spot_grid_ref,
            &config,
            heston::heston_chain_full,
        ),
        compute_snapshot_for_model(
            mode,
            &vp,
            spot,
            r,
            t,
            &strikes,
            spot_grid_ref,
            &config,
            vg::vg_chain_full,
        ),
    )
}


/// Compute IV + all Greeks for a single option.
/// Returns (iv, delta, gamma, theta, vega, vanna, charm, vomma, price) or None.
#[pyfunction]
#[pyo3(signature = (market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call))]
fn compute_greeks(
    market_price: f64,
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    is_call: bool,
) -> Option<(f64, f64, f64, f64, f64, f64, f64, f64, f64)> {
    bsm::compute_greeks(market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call)
        .map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.vanna, g.charm, g.vomma, g.price))
}

/// Batch compute IV + all Greeks (legacy, cold-start).
#[pyfunction]
fn batch_compute_greeks(
    options: Vec<(f64, f64, f64, f64, f64, bool)>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64, f64, f64, f64)>> {
    let inputs: Vec<bsm::OptionInput> = options
        .iter()
        .map(|&(mp, s, k, t, r, is_call)| bsm::OptionInput {
            market_price: mp,
            underlying_price: s,
            strike: k,
            time_to_expiry: t,
            risk_free_rate: r,
            is_call,
        })
        .collect();

    bsm::batch_compute_greeks(&inputs)
        .into_iter()
        .map(|opt| opt.map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.vanna, g.charm, g.vomma, g.price)))
        .collect()
}

/// Batch compute IV + Greeks for an entire option chain with warm-started IV solver.
///
/// Strikes should be sorted by value. The solver sweeps outward from ATM,
/// using each solved IV as the initial guess for the adjacent strike.
///
/// Args:
///     underlying_price: spot price of the underlying
///     risk_free_rate: annualized risk-free rate
///     time_to_expiry: time to expiry in years
///     strikes: sorted strike prices
///     market_prices: option mid-prices corresponding to each strike
///     is_calls: true=call, false=put for each strike
///
/// Returns:
///     list of (iv, delta, gamma, theta, vega, vanna, charm, vomma, price) tuples, or None where IV fails.
#[pyfunction]
#[pyo3(signature = (underlying_price, risk_free_rate, time_to_expiry, strikes, market_prices, is_calls))]
fn batch_compute_greeks_warm(
    underlying_price: f64,
    risk_free_rate: f64,
    time_to_expiry: f64,
    strikes: Vec<f64>,
    market_prices: Vec<f64>,
    is_calls: Vec<bool>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64, f64, f64, f64)>> {
    let input = bsm::ChainInput {
        underlying_price,
        risk_free_rate,
        time_to_expiry,
        strikes,
        market_prices,
        is_calls,
    };
    bsm::batch_compute_greeks_warm(&input)
        .into_iter()
        .map(|opt| opt.map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.vanna, g.charm, g.vomma, g.price)))
        .collect()
}

/// Black-76 counterpart of `batch_compute_greeks_warm` for European options on
/// futures (MCX). `futures_price` is the underlying future's price F; Greeks are
/// w.r.t. F. Same return shape as `batch_compute_greeks_warm`.
#[pyfunction]
#[pyo3(signature = (futures_price, risk_free_rate, time_to_expiry, strikes, market_prices, is_calls))]
fn batch_compute_greeks_warm_black76(
    futures_price: f64,
    risk_free_rate: f64,
    time_to_expiry: f64,
    strikes: Vec<f64>,
    market_prices: Vec<f64>,
    is_calls: Vec<bool>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64, f64, f64, f64)>> {
    let input = bsm::ChainInput {
        underlying_price: futures_price,
        risk_free_rate,
        time_to_expiry,
        strikes,
        market_prices,
        is_calls,
    };
    bsm::batch_compute_greeks_warm_black76(&input)
        .into_iter()
        .map(|opt| opt.map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.vanna, g.charm, g.vomma, g.price)))
        .collect()
}

/// Black-76 option price on a futures price F.
#[pyfunction]
#[pyo3(signature = (futures_price, strike, time_to_expiry, risk_free_rate, sigma, is_call))]
fn black76_price(
    futures_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
    is_call: bool,
) -> f64 {
    bsm::black76_greeks_from_iv(futures_price, strike, time_to_expiry, risk_free_rate, sigma, is_call).price
}

/// Compute implied volatility via Newton-Raphson + bisection fallback.
#[pyfunction]
#[pyo3(signature = (market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call))]
fn implied_volatility(
    market_price: f64,
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    is_call: bool,
) -> Option<f64> {
    bsm::implied_volatility(market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call)
}

/// BSM option price.
#[pyfunction]
#[pyo3(signature = (underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call))]
fn bs_price(
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
    is_call: bool,
) -> f64 {
    bsm::price(underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call)
}

/// BSM delta.
#[pyfunction]
#[pyo3(signature = (underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call))]
fn bs_delta(
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
    is_call: bool,
) -> f64 {
    bsm::delta(underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call)
}

/// BSM gamma.
#[pyfunction]
#[pyo3(signature = (underlying_price, strike, time_to_expiry, risk_free_rate, sigma))]
fn bs_gamma(
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
) -> f64 {
    bsm::gamma(underlying_price, strike, time_to_expiry, risk_free_rate, sigma)
}

/// BSM theta (per calendar day).
#[pyfunction]
#[pyo3(signature = (underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call))]
fn bs_theta(
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
    is_call: bool,
) -> f64 {
    bsm::theta(underlying_price, strike, time_to_expiry, risk_free_rate, sigma, is_call)
}

/// BSM vega (per 1% vol).
#[pyfunction]
#[pyo3(signature = (underlying_price, strike, time_to_expiry, risk_free_rate, sigma))]
fn bs_vega(
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    sigma: f64,
) -> f64 {
    bsm::vega(underlying_price, strike, time_to_expiry, risk_free_rate, sigma)
}

/// Compute expiration payoff curve for a multi-leg strategy.
#[pyfunction]
#[pyo3(signature = (legs, spot_min, spot_max, num_points = 500))]
fn strategy_payoff(
    legs: Vec<(f64, f64, i64, bool)>,
    spot_min: f64,
    spot_max: f64,
    num_points: usize,
) -> (Vec<f64>, Vec<f64>) {
    bsm::strategy_payoff(&legs, spot_min, spot_max, num_points)
}

/// Find breakeven points (zero crossings) from payoff arrays.
#[pyfunction]
fn find_breakevens(xs: Vec<f64>, ys: Vec<f64>) -> Vec<f64> {
    bsm::find_breakevens(&xs, &ys)
}

// ─── SVI surface functions ──────────────────────────────────────────

/// Fit SVI to market implied vols.
///
/// Args:
///     log_moneyness: ln(K/F) for each strike
///     ivs: market implied volatilities
///     time_to_expiry: time to expiry in years
///     weights: optional per-point weights (e.g. vega²)
///
/// Returns: dict {"a", "b", "rho", "m", "sigma"} or None if calibration fails.
#[pyfunction]
#[pyo3(signature = (log_moneyness, ivs, time_to_expiry, weights = None))]
fn svi_fit(
    log_moneyness: Vec<f64>,
    ivs: Vec<f64>,
    time_to_expiry: f64,
    weights: Option<Vec<f64>>,
) -> Option<HashMap<String, f64>> {
    let w_ref = weights.as_deref();
    svi::svi_calibrate(&log_moneyness, &ivs, time_to_expiry, w_ref).map(|p| {
        let mut map = HashMap::new();
        map.insert("a".to_string(), p.a);
        map.insert("b".to_string(), p.b);
        map.insert("rho".to_string(), p.rho);
        map.insert("m".to_string(), p.m);
        map.insert("sigma".to_string(), p.sigma);
        map
    })
}

/// Evaluate implied vol from fitted SVI params at a given log-moneyness.
///
/// Args:
///     params: dict {"a", "b", "rho", "m", "sigma"}
///     log_moneyness: ln(K/F)
///     time_to_expiry: T in years
///
/// Returns: implied volatility (float)
#[pyfunction]
#[pyo3(signature = (params, log_moneyness, time_to_expiry))]
fn svi_iv(
    params: HashMap<String, f64>,
    log_moneyness: f64,
    time_to_expiry: f64,
) -> f64 {
    let p = parse_svi_params(&params);
    svi::svi_to_iv(&p, log_moneyness, time_to_expiry)
}

/// Check if SVI params are arbitrage-free over a log-moneyness range.
///
/// Args:
///     params: dict {"a", "b", "rho", "m", "sigma"}
///     k_min: lower bound of log-moneyness range
///     k_max: upper bound of log-moneyness range
///
/// Returns: True if no arbitrage detected.
#[pyfunction]
#[pyo3(signature = (params, k_min, k_max))]
fn svi_check_arbitrage(
    params: HashMap<String, f64>,
    k_min: f64,
    k_max: f64,
) -> bool {
    let p = parse_svi_params(&params);
    svi::svi_is_arbitrage_free(&p, k_min, k_max, 200)
}

/// Compute RMSE between SVI-fitted IVs and observed IVs.
#[pyfunction]
#[pyo3(signature = (params, log_moneyness, ivs, time_to_expiry))]
fn svi_rmse(
    params: HashMap<String, f64>,
    log_moneyness: Vec<f64>,
    ivs: Vec<f64>,
    time_to_expiry: f64,
) -> f64 {
    let p = parse_svi_params(&params);
    svi::svi_rmse(&p, &log_moneyness, &ivs, time_to_expiry)
}

/// Filter IV outliers and compute Gaussian weights for SVI fitting.
///
/// Returns (filtered_ks, filtered_ivs, weights).
#[pyfunction]
#[pyo3(signature = (log_moneyness, ivs, atm_width = 0.15, outlier_mult = 3.0, min_cap = 0.05))]
fn filter_ivs_and_weight(
    log_moneyness: Vec<f64>,
    ivs: Vec<f64>,
    atm_width: f64,
    outlier_mult: f64,
    min_cap: f64,
) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    bsm::filter_ivs_and_weight(&log_moneyness, &ivs, atm_width, outlier_mult, min_cap)
}

/// Calibrate Heston model parameters against the SVI IV surface.
///
/// Returns (params_dict, rmse) or None if calibration fails (RMSE > 10%).
#[pyfunction]
#[pyo3(signature = (svi_params, spot, r, t, num_points = 25, k_range = 0.15))]
fn calibrate_heston_py(
    svi_params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    num_points: usize,
    k_range: f64,
) -> Option<(HashMap<String, f64>, f64)> {
    let sp = parse_svi_params(&svi_params);
    let (strikes, target_ivs) =
        calibrator::generate_svi_targets(&sp, spot, t, num_points, k_range);
    calibrator::calibrate_heston(&strikes, &target_ivs, spot, r, t).map(|(p, rmse)| {
        let mut map = HashMap::new();
        map.insert("kappa".to_string(), p.kappa);
        map.insert("theta".to_string(), p.theta);
        map.insert("sigma_v".to_string(), p.sigma_v);
        map.insert("rho".to_string(), p.rho);
        map.insert("v0".to_string(), p.v0);
        (map, rmse)
    })
}

/// Calibrate VG model parameters against the SVI IV surface.
///
/// Returns (params_dict, rmse) or None if calibration fails (RMSE > 10%).
#[pyfunction]
#[pyo3(signature = (svi_params, spot, r, t, num_points = 25, k_range = 0.15))]
fn calibrate_vg_py(
    svi_params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    num_points: usize,
    k_range: f64,
) -> Option<(HashMap<String, f64>, f64)> {
    let sp = parse_svi_params(&svi_params);
    let (strikes, target_ivs) =
        calibrator::generate_svi_targets(&sp, spot, t, num_points, k_range);
    calibrator::calibrate_vg(&strikes, &target_ivs, spot, r, t).map(|(p, rmse)| {
        let mut map = HashMap::new();
        map.insert("sigma".to_string(), p.sigma);
        map.insert("theta".to_string(), p.theta);
        map.insert("nu".to_string(), p.nu);
        (map, rmse)
    })
}

/// Calibrate both Heston and VG models in parallel (single Python→Rust crossing).
///
/// Returns (heston_result, vg_result) where each is (params_dict, rmse) or None.
#[pyfunction]
#[pyo3(signature = (svi_params, spot, r, t, num_points = 25, k_range = 0.15))]
fn calibrate_both(
    svi_params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    num_points: usize,
    k_range: f64,
) -> (
    Option<(HashMap<String, f64>, f64)>,
    Option<(HashMap<String, f64>, f64)>,
) {
    let sp = parse_svi_params(&svi_params);
    let result = calibrator::calibrate_both(&sp, spot, r, t, num_points, k_range);

    let heston = result.heston.map(|(p, rmse)| {
        let mut map = HashMap::new();
        map.insert("kappa".to_string(), p.kappa);
        map.insert("theta".to_string(), p.theta);
        map.insert("sigma_v".to_string(), p.sigma_v);
        map.insert("rho".to_string(), p.rho);
        map.insert("v0".to_string(), p.v0);
        (map, rmse)
    });

    let vg = result.vg.map(|(p, rmse)| {
        let mut map = HashMap::new();
        map.insert("sigma".to_string(), p.sigma);
        map.insert("theta".to_string(), p.theta);
        map.insert("nu".to_string(), p.nu);
        (map, rmse)
    });

    (heston, vg)
}

// ─── Heston / FFT functions ─────────────────────────────────────────

fn parse_svi_params(params: &HashMap<String, f64>) -> svi::SviParams {
    svi::SviParams {
        a: *params.get("a").unwrap_or(&0.0),
        b: *params.get("b").unwrap_or(&0.0),
        rho: *params.get("rho").unwrap_or(&0.0),
        m: *params.get("m").unwrap_or(&0.0),
        sigma: *params.get("sigma").unwrap_or(&0.0),
    }
}

fn parse_heston_params(params: &HashMap<String, f64>) -> heston::HestonParams {
    heston::HestonParams {
        kappa: *params.get("kappa").unwrap_or(&1.5),
        theta: *params.get("theta").unwrap_or(&0.04),
        sigma_v: *params.get("sigma_v").unwrap_or(&0.5),
        rho: *params.get("rho").unwrap_or(&-0.5),
        v0: *params.get("v0").unwrap_or(&0.04),
    }
}

/// Price European calls at given strikes under the Heston model via FFT.
///
/// Args:
///     params: dict {"kappa", "theta", "sigma_v", "rho", "v0"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of call prices
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn heston_price(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<f64> {
    let hp = parse_heston_params(&params);
    heston::heston_price_calls(&hp, spot, r, t, &strikes)
}

/// Price an entire chain (calls + puts) under Heston via FFT.
///
/// Args:
///     params: dict {"kappa", "theta", "sigma_v", "rho", "v0"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: (call_prices, put_prices)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn heston_price_chain(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> (Vec<f64>, Vec<f64>) {
    let hp = parse_heston_params(&params);
    heston::heston_price_chain(&hp, spot, r, t, &strikes)
}

/// Compute BSM implied vols from Heston call prices.
///
/// Args:
///     params: dict {"kappa", "theta", "sigma_v", "rho", "v0"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of implied vols (None where IV solver fails)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn heston_iv(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<Option<f64>> {
    let hp = parse_heston_params(&params);
    heston::heston_iv_calls(&hp, spot, r, t, &strikes)
}

/// Compute BSM implied vols from Heston put prices.
///
/// Args:
///     params: dict {"kappa", "theta", "sigma_v", "rho", "v0"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of implied vols (None where IV solver fails)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn heston_iv_puts(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<Option<f64>> {
    let hp = parse_heston_params(&params);
    heston::heston_iv_puts(&hp, spot, r, t, &strikes)
}

/// Compute call prices, put prices, and call IVs under Heston from a single FFT pass.
///
/// Args:
///     params: dict {"kappa", "theta", "sigma_v", "rho", "v0"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: (call_prices, put_prices, call_ivs) where call_ivs entries may be None
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn heston_chain_full(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>) {
    let hp = parse_heston_params(&params);
    heston::heston_chain_full(&hp, spot, r, t, &strikes)
}

// ─── Variance Gamma / FFT functions ─────────────────────────────────

fn parse_vg_params(params: &HashMap<String, f64>) -> vg::VgParams {
    vg::VgParams {
        sigma: *params.get("sigma").unwrap_or(&0.12),
        theta: *params.get("theta").unwrap_or(&-0.14),
        nu: *params.get("nu").unwrap_or(&0.2),
    }
}

/// Price European calls at given strikes under the Variance Gamma model via FFT.
///
/// Args:
///     params: dict {"sigma", "theta", "nu"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of call prices
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn vg_price(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<f64> {
    let vp = parse_vg_params(&params);
    vg::vg_price_calls(&vp, spot, r, t, &strikes)
}

/// Price an entire chain (calls + puts) under Variance Gamma via FFT.
///
/// Args:
///     params: dict {"sigma", "theta", "nu"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: (call_prices, put_prices)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn vg_price_chain(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> (Vec<f64>, Vec<f64>) {
    let vp = parse_vg_params(&params);
    vg::vg_price_chain(&vp, spot, r, t, &strikes)
}

/// Compute BSM implied vols from Variance Gamma call prices.
///
/// Args:
///     params: dict {"sigma", "theta", "nu"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of implied vols (None where IV solver fails)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn vg_iv(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<Option<f64>> {
    let vp = parse_vg_params(&params);
    vg::vg_iv_calls(&vp, spot, r, t, &strikes)
}

/// Compute BSM implied vols from Variance Gamma put prices.
///
/// Args:
///     params: dict {"sigma", "theta", "nu"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of implied vols (None where IV solver fails)
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn vg_iv_puts(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> Vec<Option<f64>> {
    let vp = parse_vg_params(&params);
    vg::vg_iv_puts(&vp, spot, r, t, &strikes)
}

/// Compute call prices, put prices, and call IVs under Variance Gamma from a single FFT pass.
///
/// Args:
///     params: dict {"sigma", "theta", "nu"}
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: (call_prices, put_prices, call_ivs) where call_ivs entries may be None
#[pyfunction]
#[pyo3(signature = (params, spot, r, t, strikes))]
fn vg_chain_full(
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>) {
    let vp = parse_vg_params(&params);
    vg::vg_chain_full(&vp, spot, r, t, &strikes)
}

/// Price calls at given strikes using FFT for any supported model.
///
/// Args:
///     model: model name ("heston", "vg")
///     params: model-specific parameter dict
///     spot: underlying spot price
///     r: risk-free rate
///     t: time to expiry in years
///     strikes: list of strike prices
///
/// Returns: list of call prices
#[pyfunction]
#[pyo3(signature = (model, params, spot, r, t, strikes))]
fn fft_price_at_strikes(
    model: &str,
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> PyResult<Vec<f64>> {
    match model {
        "heston" => {
            let hp = parse_heston_params(&params);
            Ok(heston::heston_price_calls(&hp, spot, r, t, &strikes))
        }
        "vg" => {
            let vp = parse_vg_params(&params);
            Ok(vg::vg_price_calls(&vp, spot, r, t, &strikes))
        }
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            format!("Unknown model: {model}. Supported: heston, vg"),
        )),
    }
}

/// Extract risk-neutral density of S_T at given strikes.
///
/// Args:
///     model: "heston" or "vg"
///     params: model-specific parameter dict
///     spot, r, t: market params
///     strikes: output grid (list of spot prices)
///
/// Returns: list of density values f(S) at each strike
#[pyfunction]
#[pyo3(signature = (model, params, spot, r, t, strikes))]
fn risk_neutral_density(
    model: &str,
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> PyResult<Vec<f64>> {
    let config = fft::CarrMadanConfig::default();
    match model {
        "heston" => {
            let hp = parse_heston_params(&params);
            Ok(fft::risk_neutral_density(&hp, spot, r, t, &strikes, &config))
        }
        "vg" => {
            let vp = parse_vg_params(&params);
            Ok(fft::risk_neutral_density(&vp, spot, r, t, &strikes, &config))
        }
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            format!("Unknown model: {model}. Supported: heston, vg"),
        )),
    }
}

/// Extract risk-neutral density of S_T and its CDF on the same grid.
#[pyfunction]
#[pyo3(signature = (model, params, spot, r, t, strikes))]
fn risk_neutral_density_cdf(
    model: &str,
    params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
) -> PyResult<(Vec<f64>, Vec<f64>)> {
    let config = fft::CarrMadanConfig::default();
    match model {
        "heston" => {
            let hp = parse_heston_params(&params);
            Ok(fft::risk_neutral_density_and_cdf(&hp, spot, r, t, &strikes, &config))
        }
        "vg" => {
            let vp = parse_vg_params(&params);
            Ok(fft::risk_neutral_density_and_cdf(&vp, spot, r, t, &strikes, &config))
        }
        _ => Err(pyo3::exceptions::PyValueError::new_err(
            format!("Unknown model: {model}. Supported: heston, vg"),
        )),
    }
}

/// Compute a model snapshot for both Heston and VG in one pure Rust call.
///
/// Modes:
///     "fast" -> calls, puts, ivs
///     "slow" -> density, cdf (requires spot_grid)
///     "full" -> calls, puts, ivs, density, cdf (requires spot_grid)
///
/// Returns:
///     ((h_calls, h_puts, h_ivs, h_density, h_cdf),
///      (v_calls, v_puts, v_ivs, v_density, v_cdf))
#[pyfunction]
#[pyo3(signature = (mode, heston_params, vg_params, spot, r, t, strikes, spot_grid = None))]
fn compute_model_snapshot(
    mode: &str,
    heston_params: HashMap<String, f64>,
    vg_params: HashMap<String, f64>,
    spot: f64,
    r: f64,
    t: f64,
    strikes: Vec<f64>,
    spot_grid: Option<Vec<f64>>,
) -> PyResult<DualModelSnapshotArrays> {
    let parsed_mode = SnapshotMode::parse(mode)?;
    if parsed_mode.needs_slow() && spot_grid.is_none() {
        return Err(pyo3::exceptions::PyValueError::new_err(
            "spot_grid is required for slow/full snapshot modes",
        ));
    }

    Ok(compute_model_snapshot_impl(
        parsed_mode,
        heston_params,
        vg_params,
        spot,
        r,
        t,
        strikes,
        spot_grid,
    ))
}

/// Compute Probability of Profit by integrating risk-neutral density over
/// the profitable region of a strategy payoff.
///
/// Args:
///     spot_grid: list of underlying prices
///     density: risk-neutral density at each spot_grid point
///     payoff: strategy payoff at each spot_grid point
///
/// Returns: probability of profit (0.0 to 1.0)
#[pyfunction]
#[pyo3(signature = (spot_grid, density, payoff))]
fn compute_pop(
    spot_grid: Vec<f64>,
    density: Vec<f64>,
    payoff: Vec<f64>,
) -> f64 {
    fft::compute_pop_from_density(&spot_grid, &density, &payoff)
}

/// Compute CDF from risk-neutral density.
#[pyfunction]
#[pyo3(signature = (spot_grid, density))]
fn compute_cdf(
    spot_grid: Vec<f64>,
    density: Vec<f64>,
) -> Vec<f64> {
    fft::compute_cdf(&spot_grid, &density)
}

/// Compute Value-at-Risk at a given confidence level.
///
/// Returns the P&L value below which `confidence` fraction of probability falls.
#[pyfunction]
#[pyo3(signature = (spot_grid, density, payoff, confidence))]
fn compute_var(
    spot_grid: Vec<f64>,
    density: Vec<f64>,
    payoff: Vec<f64>,
    confidence: f64,
) -> f64 {
    fft::compute_var(&spot_grid, &density, &payoff, confidence)
}

/// Compute Expected Shortfall (CVaR) at a given confidence level.
///
/// Returns the average P&L in the worst `confidence` fraction of scenarios.
#[pyfunction]
#[pyo3(signature = (spot_grid, density, payoff, confidence))]
fn compute_expected_shortfall(
    spot_grid: Vec<f64>,
    density: Vec<f64>,
    payoff: Vec<f64>,
    confidence: f64,
) -> f64 {
    fft::compute_expected_shortfall(&spot_grid, &density, &payoff, confidence)
}

/// td_core — Rust-powered quant engine for td-desk.
#[pymodule]
fn td_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // BSM
    m.add_function(wrap_pyfunction!(compute_greeks, m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_greeks, m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_greeks_warm, m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_greeks_warm_black76, m)?)?;
    m.add_function(wrap_pyfunction!(black76_price, m)?)?;
    m.add_function(wrap_pyfunction!(implied_volatility, m)?)?;
    m.add_function(wrap_pyfunction!(bs_price, m)?)?;
    m.add_function(wrap_pyfunction!(bs_delta, m)?)?;
    m.add_function(wrap_pyfunction!(bs_gamma, m)?)?;
    m.add_function(wrap_pyfunction!(bs_theta, m)?)?;
    m.add_function(wrap_pyfunction!(bs_vega, m)?)?;
    m.add_function(wrap_pyfunction!(strategy_payoff, m)?)?;
    m.add_function(wrap_pyfunction!(find_breakevens, m)?)?;
    // SVI
    m.add_function(wrap_pyfunction!(svi_fit, m)?)?;
    m.add_function(wrap_pyfunction!(svi_iv, m)?)?;
    m.add_function(wrap_pyfunction!(svi_check_arbitrage, m)?)?;
    m.add_function(wrap_pyfunction!(svi_rmse, m)?)?;
    m.add_function(wrap_pyfunction!(filter_ivs_and_weight, m)?)?;
    // Calibration
    m.add_function(wrap_pyfunction!(calibrate_heston_py, m)?)?;
    m.add_function(wrap_pyfunction!(calibrate_vg_py, m)?)?;
    m.add_function(wrap_pyfunction!(calibrate_both, m)?)?;
    // Heston / FFT
    m.add_function(wrap_pyfunction!(heston_price, m)?)?;
    m.add_function(wrap_pyfunction!(heston_price_chain, m)?)?;
    m.add_function(wrap_pyfunction!(heston_iv, m)?)?;
    m.add_function(wrap_pyfunction!(heston_iv_puts, m)?)?;
    m.add_function(wrap_pyfunction!(heston_chain_full, m)?)?;
    // Variance Gamma
    m.add_function(wrap_pyfunction!(vg_price, m)?)?;
    m.add_function(wrap_pyfunction!(vg_price_chain, m)?)?;
    m.add_function(wrap_pyfunction!(vg_iv, m)?)?;
    m.add_function(wrap_pyfunction!(vg_iv_puts, m)?)?;
    m.add_function(wrap_pyfunction!(vg_chain_full, m)?)?;
    m.add_function(wrap_pyfunction!(compute_model_snapshot, m)?)?;
    // Generic FFT dispatch
    m.add_function(wrap_pyfunction!(fft_price_at_strikes, m)?)?;
    // Risk-neutral density & PoP
    m.add_function(wrap_pyfunction!(risk_neutral_density, m)?)?;
    m.add_function(wrap_pyfunction!(risk_neutral_density_cdf, m)?)?;
    m.add_function(wrap_pyfunction!(compute_pop, m)?)?;
    m.add_function(wrap_pyfunction!(compute_cdf, m)?)?;
    m.add_function(wrap_pyfunction!(compute_var, m)?)?;
    m.add_function(wrap_pyfunction!(compute_expected_shortfall, m)?)?;
    Ok(())
}

#[cfg(test)]
mod snapshot_tests {
    use super::*;

    fn heston_params() -> HashMap<String, f64> {
        HashMap::from([
            ("kappa".to_string(), 1.8),
            ("theta".to_string(), 0.04),
            ("sigma_v".to_string(), 0.6),
            ("rho".to_string(), -0.55),
            ("v0".to_string(), 0.03),
        ])
    }

    fn vg_params() -> HashMap<String, f64> {
        HashMap::from([
            ("sigma".to_string(), 0.12),
            ("theta".to_string(), -0.14),
            ("nu".to_string(), 0.2),
        ])
    }

    #[test]
    fn test_compute_model_snapshot_modes() {
        let strikes = vec![21000.0, 21500.0, 22000.0];
        let spot_grid = vec![18000.0, 20000.0, 22000.0, 24000.0, 26000.0];

        let (fast_heston, fast_vg) = compute_model_snapshot_impl(
            SnapshotMode::Fast,
            heston_params(),
            vg_params(),
            22000.0,
            0.065,
            0.08,
            strikes.clone(),
            None,
        );
        assert!(fast_heston.0.is_some() && fast_heston.3.is_none());
        assert!(fast_vg.0.is_some() && fast_vg.3.is_none());

        let (slow_heston, slow_vg) = compute_model_snapshot_impl(
            SnapshotMode::Slow,
            heston_params(),
            vg_params(),
            22000.0,
            0.065,
            0.08,
            strikes.clone(),
            Some(spot_grid.clone()),
        );
        assert!(slow_heston.0.is_none() && slow_heston.3.is_some());
        assert!(slow_vg.0.is_none() && slow_vg.3.is_some());

        let (full_heston, full_vg) = compute_model_snapshot_impl(
            SnapshotMode::Full,
            heston_params(),
            vg_params(),
            22000.0,
            0.065,
            0.08,
            strikes,
            Some(spot_grid),
        );
        assert!(full_heston.0.is_some() && full_heston.3.is_some());
        assert!(full_vg.0.is_some() && full_vg.3.is_some());
    }
}
