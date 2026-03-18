mod bsm;
mod fft;
mod heston;
mod svi;
mod vg;

use pyo3::prelude::*;
use std::collections::HashMap;


/// Compute IV + all Greeks for a single option.
/// Returns (iv, delta, gamma, theta, vega, price) or None.
#[pyfunction]
#[pyo3(signature = (market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call))]
fn compute_greeks(
    market_price: f64,
    underlying_price: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    is_call: bool,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    bsm::compute_greeks(market_price, underlying_price, strike, time_to_expiry, risk_free_rate, is_call)
        .map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.price))
}

/// Batch compute IV + all Greeks (legacy, cold-start).
#[pyfunction]
fn batch_compute_greeks(
    options: Vec<(f64, f64, f64, f64, f64, bool)>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64)>> {
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
        .map(|opt| opt.map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.price)))
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
///     list of (iv, delta, gamma, theta, vega, price) tuples, or None where IV fails.
#[pyfunction]
#[pyo3(signature = (underlying_price, risk_free_rate, time_to_expiry, strikes, market_prices, is_calls))]
fn batch_compute_greeks_warm(
    underlying_price: f64,
    risk_free_rate: f64,
    time_to_expiry: f64,
    strikes: Vec<f64>,
    market_prices: Vec<f64>,
    is_calls: Vec<bool>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64)>> {
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
        .map(|opt| opt.map(|g| (g.iv, g.delta, g.gamma, g.theta, g.vega, g.price)))
        .collect()
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
    let p = svi::SviParams {
        a: *params.get("a").unwrap_or(&0.0),
        b: *params.get("b").unwrap_or(&0.0),
        rho: *params.get("rho").unwrap_or(&0.0),
        m: *params.get("m").unwrap_or(&0.0),
        sigma: *params.get("sigma").unwrap_or(&0.0),
    };
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
    let p = svi::SviParams {
        a: *params.get("a").unwrap_or(&0.0),
        b: *params.get("b").unwrap_or(&0.0),
        rho: *params.get("rho").unwrap_or(&0.0),
        m: *params.get("m").unwrap_or(&0.0),
        sigma: *params.get("sigma").unwrap_or(&0.0),
    };
    svi::svi_is_arbitrage_free(&p, k_min, k_max, 200)
}

// ─── Heston / FFT functions ─────────────────────────────────────────

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

/// td_core — Rust-powered quant engine for td-desk.
#[pymodule]
fn td_core(m: &Bound<'_, PyModule>) -> PyResult<()> {
    // BSM
    m.add_function(wrap_pyfunction!(compute_greeks, m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_greeks, m)?)?;
    m.add_function(wrap_pyfunction!(batch_compute_greeks_warm, m)?)?;
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
    // Heston / FFT
    m.add_function(wrap_pyfunction!(heston_price, m)?)?;
    m.add_function(wrap_pyfunction!(heston_price_chain, m)?)?;
    m.add_function(wrap_pyfunction!(heston_iv, m)?)?;
    m.add_function(wrap_pyfunction!(heston_iv_puts, m)?)?;
    // Variance Gamma
    m.add_function(wrap_pyfunction!(vg_price, m)?)?;
    m.add_function(wrap_pyfunction!(vg_price_chain, m)?)?;
    m.add_function(wrap_pyfunction!(vg_iv, m)?)?;
    m.add_function(wrap_pyfunction!(vg_iv_puts, m)?)?;
    // Generic FFT dispatch
    m.add_function(wrap_pyfunction!(fft_price_at_strikes, m)?)?;
    Ok(())
}
