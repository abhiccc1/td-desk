# Quant Engine Roadmap — td_core

> Source of truth for pricing engine optimizations and feature implementation.
> Last updated: 2026-03-15

---

## Table of Contents

1. [Current State](#1-current-state)
2. [Phase 1 — Immediate Optimizations (BSM)](#2-phase-1--immediate-optimizations-bsm)
3. [Phase 2 — IV Surface Construction (SVI)](#3-phase-2--iv-surface-construction-svi)
4. [Phase 3 — Stochastic Volatility (Heston)](#4-phase-3--stochastic-volatility-heston)
5. [Phase 4 — FFT Pricing Engine (Carr-Madan)](#5-phase-4--fft-pricing-engine-carr-madan)
6. [Phase 5 — Jump-Diffusion Models (Variance Gamma)](#6-phase-5--jump-diffusion-models-variance-gamma)
7. [Rust Dependency Plan](#7-rust-dependency-plan)
8. [File Structure](#8-file-structure)
9. [References](#9-references)

---

## 1. Current State

### What exists

**Crate**: `td-core` (`backend/quant_service/rust_core/`)
**Dependencies**: `pyo3 0.25`, `libm 0.2`

| Function | What it does |
|----------|-------------|
| `compute_greeks` | Per-option IV solve (Newton-Raphson + bisection) + all Greeks |
| `batch_compute_greeks` | Sequential map over `compute_greeks` — no vectorization |
| `bs_price/delta/gamma/theta/vega` | Closed-form BSM given known IV |
| `implied_volatility` | Newton-Raphson (100 iter, tol 1e-8) with bisection fallback (200 iter) |
| `strategy_payoff` | Expiry payoff curve for multi-leg strategies (500 points) |
| `find_breakevens` | Linear interpolation zero-crossings |

### Key constants

```
IV_MAX_ITER      = 100
IV_TOL           = 1e-8
IV_INITIAL_GUESS = 0.20
IV_MIN           = 1e-6
IV_MAX           = 5.0
```

### Processing model

Per-tick: each `TICK` event → one `compute_greeks()` call in Python.
`batch_compute_greeks()` exists in Rust but is **never called** from Python.

### Limitations

- IV solver always starts at 0.20 regardless of adjacent strike IVs
- No chain-level batching — each tick processed independently
- No SIMD or parallelism in batch function
- BSM only — constant volatility assumption
- No IV surface model — each strike's IV is independent
- Greeks for OTM options are unreliable (BSM ignores skew dynamics)

---

## 2. Phase 1 — Immediate Optimizations (BSM)

**Goal**: 3-5x throughput improvement with zero model changes.
**Effort**: ~2 days. **Risk**: Low.

### 2a. Warm-Start IV Solver

**Problem**: Newton-Raphson starts at σ=0.20 for every option. Adjacent strikes on the same chain have IVs within 1-3 vol points, wasting 3-5 iterations per solve.

**Implementation**:

Add to `bsm.rs`:
```rust
pub fn implied_volatility_with_guess(
    market_price: f64, s: f64, k: f64, t: f64, r: f64,
    is_call: bool, initial_guess: f64,
) -> Option<f64>
```

Add to `lib.rs`:
```rust
#[pyfunction]
fn batch_compute_greeks_warm(
    underlying_price: f64,
    risk_free_rate: f64,
    time_to_expiry: f64,
    strikes: Vec<f64>,    // sorted by moneyness
    market_prices: Vec<f64>,
    is_calls: Vec<bool>,
) -> Vec<Option<(f64, f64, f64, f64, f64, f64)>>
```

**Algorithm**:
1. Find ATM strike (closest to `underlying_price`)
2. Solve ATM IV with Brenner-Subrahmanyam initial guess: `σ₀ ≈ √(2π/T) × C/S`
3. Walk outward from ATM in both directions
4. Each strike uses the previous strike's solved IV as initial guess

**Expected improvement**: 5-8 iterations → 2-3 iterations per strike (~60% reduction).

### 2b. Chain-Level Batch Greeks

**Problem**: `GreeksCalculator` processes one tick at a time. When a `CHAIN_SNAPSHOT` arrives (50-200 strikes), it's more efficient to batch-process the entire chain.

**Implementation** (Python side, `greeks.py`):

Register `GreeksCalculator` for `EventType.CHAIN_SNAPSHOT` in addition to `EventType.TICK`. When a snapshot arrives:
1. Extract all strikes with bid/ask data
2. Build sorted input arrays (strikes, midpoints, is_call flags)
3. Call `td_core.batch_compute_greeks_warm(...)` once
4. Emit one `GREEKS_COMPUTED` event per strike (or one batched event)

### 2c. Rayon Parallelism for Batch

**Problem**: `batch_compute_greeks` is a sequential `.iter().map().collect()`.

**Implementation**: Add `rayon` dependency, change to `.par_iter()` for chains > 20 options.

```rust
// In batch_compute_greeks:
if inputs.len() > 20 {
    inputs.par_iter().map(|inp| compute_greeks(...)).collect()
} else {
    inputs.iter().map(|inp| compute_greeks(...)).collect()
}
```

### 2d. SoA Memory Layout for SIMD

Restructure batch input from Array-of-Structs to Struct-of-Arrays:

```rust
pub struct ChainInput {
    pub underlying_price: f64,
    pub risk_free_rate: f64,
    pub time_to_expiry: f64,
    pub strikes: Vec<f64>,
    pub market_prices: Vec<f64>,
    pub is_calls: Vec<bool>,
}
```

This enables SIMD auto-vectorization for `norm_cdf`, `d1`, and price calculations. The compiler can process 4 f64s at once (AVX2) with contiguous memory access.

### Files to modify

| File | Change |
|------|--------|
| `rust_core/src/bsm.rs` | Add `implied_volatility_with_guess`, warm-start batch function |
| `rust_core/src/lib.rs` | Export `batch_compute_greeks_warm` |
| `rust_core/Cargo.toml` | Add `rayon = "1.10"` |
| `quant_service/indicators/greeks.py` | Register for `CHAIN_SNAPSHOT`, call batch function |

### Verification

```bash
# Rust unit tests
cd backend/quant_service/rust_core && cargo test

# Benchmark: warm-start vs cold-start on 100-strike chain
cargo bench  # (add criterion benchmarks)

# Integration: verify Greeks output matches for NIFTY chain
docker compose up -d
python -c "
import td_core
# Cold start
cold = [td_core.compute_greeks(100, 22000, k, 0.08, 0.065, True) for k in range(21000, 23000, 50)]
# Warm start
warm = td_core.batch_compute_greeks_warm(22000, 0.065, 0.08, list(range(21000, 23000, 50)), [100]*40, [True]*40)
assert all(abs(c[0] - w[0]) < 1e-6 for c, w in zip(cold, warm) if c and w)
print('IV values match')
"
```

---

## 3. Phase 2 — IV Surface Construction (SVI)

**Goal**: Replace independent per-strike IVs with a fitted volatility surface.
**Effort**: ~1 week. **Risk**: Medium.
**Depends on**: Phase 1 (batch Greeks provide the market IVs to fit).

### Why SVI

SVI (Stochastic Volatility Inspired, Gatheral 2004) parameterizes the implied variance smile with 5 parameters per expiry slice:

```
w(k) = a + b × (ρ(k - m) + √((k - m)² + σ²))
```

Where `k = ln(K/F)` (log-moneyness), `w` = total implied variance = σ²×T.

| Property | Value |
|----------|-------|
| Parameters per slice | 5: {a, b, ρ, m, σ} |
| Calibration time | ~108 μs per slice |
| Vol query time | ~4.7 ns |
| Arbitrage detection | Built-in (butterfly + calendar spread checks) |

### Why not SABR or cubic spline

- **SABR**: Better for rates/FX. Less natural for equity index skew. 4 parameters limits flexibility.
- **Cubic spline**: No-arbitrage not guaranteed. Extrapolation breaks. Fine for display, not for pricing.

### Implementation

**New file**: `rust_core/src/svi.rs`

```rust
pub struct SviParams {
    pub a: f64,   // vertical shift (overall variance level)
    pub b: f64,   // slope magnitude (controls wing steepness)
    pub rho: f64, // asymmetry (-1 to 1, typically -0.3 to -0.7 for equity)
    pub m: f64,   // horizontal shift (smile center offset)
    pub sigma: f64, // smoothness (minimum curvature at vertex)
}

/// Fit SVI to a set of market-observed (log-moneyness, total-variance) pairs.
pub fn svi_calibrate(
    log_moneyness: &[f64],
    total_variances: &[f64],
    weights: Option<&[f64]>,
) -> SviParams

/// Evaluate total implied variance at a given log-moneyness.
pub fn svi_eval(params: &SviParams, k: f64) -> f64

/// Convert total variance to implied vol: σ = √(w/T)
pub fn svi_to_iv(params: &SviParams, k: f64, t: f64) -> f64

/// Check butterfly arbitrage constraint: d²w/dk² ≥ 0
pub fn svi_is_arbitrage_free(params: &SviParams, k_range: (f64, f64)) -> bool
```

**Calibration method**: Quasi-explicit (Zeliade 2009) — fixes ρ and m via grid search, then solves a, b, σ analytically via constrained least-squares. Fast and robust.

**Python API**:
```python
# Fit surface to market IVs
params = td_core.svi_fit(
    log_moneyness=[...],  # ln(K/F) for each strike
    ivs=[...],            # market implied vols
    time_to_expiry=0.08,
)
# Returns: {"a": ..., "b": ..., "rho": ..., "m": ..., "sigma": ...}

# Query IV at arbitrary strike
iv = td_core.svi_iv(params, log_moneyness=-0.05, time_to_expiry=0.08)
```

### Integration with existing pipeline

When a `CHAIN_SNAPSHOT` arrives:
1. Compute market IVs via `batch_compute_greeks_warm` (Phase 1)
2. Fit SVI to the IV smile: `svi_fit(log_moneyness, ivs, T)`
3. Store SVI params in Redis: `cache:svi:{underlying}:{expiry}`
4. Use SVI for interpolation/extrapolation of illiquid strikes
5. Detect mispriced options: market IV significantly deviates from SVI-fitted IV

### Files to create/modify

| File | Change |
|------|--------|
| `rust_core/src/svi.rs` | **NEW** — SVI calibration, evaluation, arbitrage check |
| `rust_core/src/lib.rs` | Export `svi_fit`, `svi_iv`, `svi_check_arbitrage` |
| `quant_service/indicators/greeks.py` | After batch Greeks, fit SVI, cache params |
| `shared/schemas/greeks.py` | Add `SviParams` schema for Redis cache |

---

## 4. Phase 3 — Stochastic Volatility (Heston)

**Goal**: Model-consistent pricing that captures volatility smile dynamics.
**Effort**: ~2 weeks. **Risk**: High (calibration stability).
**Depends on**: Phase 2 (SVI provides initial parameter estimates and calibration targets).

### Why Heston for NSE options

BSM assumes constant volatility. In reality, NIFTY/BANKNIFTY options exhibit:

- **Negative put skew**: OTM puts trade at 3-8 vol points above ATM (leverage effect)
- **Smile steepening into expiry**: Weekly options show pronounced U-shape
- **Vol clustering**: Periods of high/low realized vol persist (mean-reverting)

The Heston model captures all three via stochastic variance:

```
dS = r×S×dt + √v×S×dW₁
dv = κ(θ - v)×dt + σᵥ×√v×dW₂
dW₁×dW₂ = ρ×dt
```

### Parameters and typical ranges for equity indices

| Parameter | Symbol | Range | Interpretation |
|-----------|--------|-------|----------------|
| Mean reversion speed | κ | 0.5 – 5.0 | How fast vol reverts to θ |
| Long-run variance | θ | 0.02 – 0.10 | ~14%–32% long-run vol |
| Vol of vol | σᵥ | 0.3 – 1.2 | Smile curvature / tail fatness |
| Spot-vol correlation | ρ | -0.3 – -0.8 | Negative = leverage effect |
| Current variance | v₀ | 0.01 – 0.08 | From ATM IV at calibration time |

### Characteristic function

The Heston CF has a closed-form solution (use Schoutens' log-formulation to avoid the "Little Heston Trap"):

```
φ(u) = exp(C(u, T) + D(u, T)×v₀ + i×u×ln(S))
```

Where C and D satisfy Riccati ODEs with explicit solutions involving complex exponentials and square roots.

### Calibration

**Objective**: Minimize weighted IV error between model and market across strikes/expiries.

```
min_{κ,θ,σᵥ,ρ,v₀}  Σᵢ wᵢ × (σ_heston(Kᵢ,Tᵢ) - σ_market(Kᵢ,Tᵢ))²
```

**Weighting**: Vega-weighted (wᵢ = vegaᵢ²) — approximates price-space fit, numerically stable.

**Data requirements**:
- Minimum 15-20 liquid strikes across 2-3 expiry tenors
- Recommended: 30-50 options spanning 0.85–1.15 moneyness

**Optimizer strategy** (two-phase):

| Phase | Method | Iterations | Purpose |
|-------|--------|------------|---------|
| 1 | Differential Evolution | ~200 | Global search, find basin |
| 2 | Levenberg-Marquardt | ~20 | Local refinement with analytical gradients |

Total calibration time target: **<50ms** in Rust with analytical Jacobian.

**Recalibration trigger**: When ATM IV moves > 0.5 vol points from last calibration, or every 30-60 seconds.

**Parameter constraints**:

| Parameter | Lower | Upper | Note |
|-----------|-------|-------|------|
| κ | 0.001 | 15.0 | |
| θ | 0.001 | 1.0 | |
| σᵥ | 0.01 | 4.0 | |
| ρ | -0.999 | 0.0 | Always negative for equity |
| v₀ | 0.0001 | 1.0 | Initialize from ATM IV² |

**Feller condition** (2κθ > σᵥ²): Add as soft penalty rather than hard constraint — real market calibrations often violate it, which is acceptable for pricing (not for MC simulation).

### Implementation

**New file**: `rust_core/src/heston.rs`

```rust
pub struct HestonParams {
    pub kappa: f64,    // mean reversion speed
    pub theta: f64,    // long-run variance
    pub sigma_v: f64,  // vol of vol
    pub rho: f64,      // spot-vol correlation
    pub v0: f64,       // current variance
}

/// Heston characteristic function (Schoutens log-formulation).
pub fn heston_cf(u: Complex<f64>, params: &HestonParams, t: f64, r: f64, s: f64) -> Complex<f64>

/// Price a single European option via numerical integration of the CF.
pub fn heston_price(params: &HestonParams, s: f64, k: f64, t: f64, r: f64, is_call: bool) -> f64

/// Compute Heston IV for a single strike (price → BSM inversion).
pub fn heston_iv(params: &HestonParams, s: f64, k: f64, t: f64, r: f64, is_call: bool) -> Option<f64>

/// Calibrate Heston to market IVs. Returns fitted params + RMSE.
pub fn heston_calibrate(
    market_strikes: &[f64],
    market_ivs: &[f64],
    spot: f64,
    risk_free_rate: f64,
    times_to_expiry: &[f64],
    initial_guess: Option<HestonParams>,
) -> (HestonParams, f64)
```

**Python API**:
```python
params, rmse = td_core.heston_calibrate(
    market_strikes=[21000, 21200, ..., 23000],
    market_ivs=[0.22, 0.20, ..., 0.18],
    spot=22000.0,
    risk_free_rate=0.065,
    times_to_expiry=[0.02, 0.02, ..., 0.08, 0.08],  # mixed expiries
)
# params = {"kappa": 1.8, "theta": 0.04, "sigma_v": 0.6, "rho": -0.55, "v0": 0.03}
# rmse = 0.003  (0.3 vol points)

# Price under Heston
price = td_core.heston_price(params, spot=22000, strike=21500, T=0.08, r=0.065, is_call=False)
```

### Integration with existing pipeline

1. `CHAIN_SNAPSHOT` arrives → batch BSM IV solve (Phase 1) → SVI fit (Phase 2)
2. Every 30-60s (or on ATM IV shift > 0.5): calibrate Heston to current SVI surface
3. Store `HestonParams` in Redis: `cache:heston:{underlying}`
4. Use Heston Greeks for risk exposure calculation instead of BSM Greeks
5. Strategy analyzer: price legs under Heston for skew-aware P&L estimates

### Files to create/modify

| File | Change |
|------|--------|
| `rust_core/src/heston.rs` | **NEW** — CF, pricing, IV, calibration |
| `rust_core/Cargo.toml` | Add `num-complex`, `argmin`, `nalgebra` |
| `rust_core/src/lib.rs` | Export `heston_calibrate`, `heston_price`, `heston_iv` |
| `quant_service/indicators/greeks.py` | Periodic Heston recalibration, Heston Greeks |
| `shared/schemas/greeks.py` | Add `HestonParams` schema |

---

## 5. Phase 4 — FFT Pricing Engine (Carr-Madan)

**Goal**: Price entire strike strips in O(N log N) — essential for Heston calibration performance.
**Effort**: ~1 week. **Risk**: Medium (numerical stability of dampening parameter).
**Depends on**: Phase 3 (Heston CF is the primary consumer of FFT pricing).

### Why FFT

Without FFT, pricing N strikes under Heston requires N × M operations (M = quadrature points per strike, typically 1000-10000). With FFT, it's N log N for all N strikes simultaneously.

| Method | 100 strikes | 4096 strikes |
|--------|-------------|--------------|
| Per-strike quadrature | ~100ms | ~4s |
| Carr-Madan FFT | ~0.1ms | ~0.5ms |

This makes Heston calibration (which reprices all strikes per optimizer step) practical in real-time.

### Carr-Madan algorithm

1. Dampened call price: `c_T(k) = exp(α×k) × C_T(k)` where k = ln(K)
2. Fourier transform in closed form via characteristic function:
   ```
   ψ_T(v) = exp(-rT) × φ_T(v - (α+1)i) / (α² + α - v² + i(2α+1)v)
   ```
3. Discretize: `v_j = η×j`, `k_u = -b + λ×u` where `b = N×λ/2`, `λ = 2π/(Nη)`
4. Apply Simpson's weights and compute via FFT
5. Extract call prices: `C(K_u) = exp(-α×k_u)/π × Re(FFT output)_u`

### Parameters

| Parameter | Default | Notes |
|-----------|---------|-------|
| N | 4096 | Power of 2 for FFT efficiency |
| α | 1.5 | Dampening; must satisfy `φ_T(-(α+1)i) < ∞` |
| η | 0.25 | Frequency grid spacing |
| λ | 2π/(Nη) ≈ 0.006 | Log-strike spacing (derived) |

### Implementation

**New file**: `rust_core/src/fft.rs`

```rust
use num_complex::Complex64;
use rustfft::FftPlanner;

/// Characteristic function type — any model that implements this can use FFT pricing.
pub trait CharacteristicFunction {
    fn evaluate(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64;
}

/// Price an entire strip of European calls via Carr-Madan FFT.
pub fn fft_price_calls(
    cf: &dyn CharacteristicFunction,
    spot: f64,
    r: f64,
    t: f64,
    n: usize,        // FFT points (default 4096)
    alpha: f64,      // dampening (default 1.5)
    eta: f64,        // frequency spacing (default 0.25)
) -> (Vec<f64>, Vec<f64>)  // (strikes, call_prices)

/// Put prices via put-call parity: P = C - S + K×exp(-rT)
pub fn fft_price_puts(
    call_strikes: &[f64],
    call_prices: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> Vec<f64>

/// Price calls at specific market strikes (interpolate from FFT grid).
pub fn fft_price_at_strikes(
    cf: &dyn CharacteristicFunction,
    spot: f64,
    r: f64,
    t: f64,
    market_strikes: &[f64],
    alpha: f64,
    eta: f64,
) -> Vec<f64>
```

**Python API**:
```python
# Price entire chain under any CF-based model
strikes, prices = td_core.fft_price_chain(
    model="heston",
    params={"kappa": 1.8, "theta": 0.04, ...},
    spot=22000.0, r=0.065, T=0.08,
    n=4096, alpha=1.5, eta=0.25,
)

# Price at specific market strikes
prices = td_core.fft_price_at_strikes(
    model="heston",
    params={...},
    spot=22000.0, r=0.065, T=0.08,
    strikes=[21000, 21500, 22000, 22500, 23000],
)
```

### Impact on Heston calibration

Replace per-strike quadrature in calibration loop with FFT:
- Calibration inner loop: FFT prices all strikes → compute IV errors → compute Jacobian
- Total calibration: ~200 DE steps × 0.5ms FFT + ~20 LM steps × 0.5ms FFT ≈ **110ms**
- Without FFT: ~200 DE steps × 100ms + ~20 LM steps × 100ms ≈ **22 seconds**

### Files to create/modify

| File | Change |
|------|--------|
| `rust_core/src/fft.rs` | **NEW** — Carr-Madan FFT, trait, interpolation |
| `rust_core/Cargo.toml` | Add `rustfft = "6.4"` |
| `rust_core/src/heston.rs` | Implement `CharacteristicFunction` for `HestonParams` |
| `rust_core/src/lib.rs` | Export `fft_price_chain`, `fft_price_at_strikes` |

---

## 6. Phase 5 — Jump-Diffusion Models (Variance Gamma)

**Goal**: Capture discrete jump risk for short-dated weekly options around events.
**Effort**: ~1 week. **Risk**: Low (model is simpler than Heston, reuses FFT infra).
**Depends on**: Phase 4 (FFT pricing engine).

### Why Variance Gamma for NIFTY weeklies

NIFTY weekly options (Thursday expiry) are heavily affected by discrete events: RBI meetings, US Fed decisions, budget, earnings. These cause sudden price jumps that continuous-diffusion models (BSM, Heston) underestimate.

VG models **all** price changes as jumps (pure jump process with 3 parameters):

| Parameter | Symbol | Controls |
|-----------|--------|----------|
| σ | sigma | Volatility of the Brownian component |
| θ | theta | Drift of subordinated process (skewness) |
| ν | nu | Variance rate of gamma process (kurtosis/tail weight) |

### Characteristic function

```
φ_VG(u; t) = (1 / (1 - iuθν + ½σ²νu²))^(t/ν)
```

This plugs directly into the Carr-Madan FFT engine from Phase 4 — zero new FFT code needed.

### Implementation

**New file**: `rust_core/src/vg.rs`

```rust
pub struct VgParams {
    pub sigma: f64,  // volatility
    pub theta: f64,  // drift (skewness control)
    pub nu: f64,     // variance rate (kurtosis control)
}

impl CharacteristicFunction for VgParams {
    fn evaluate(&self, u: Complex64, t: f64, r: f64, spot: f64) -> Complex64 { ... }
}

pub fn vg_calibrate(
    market_strikes: &[f64],
    market_ivs: &[f64],
    spot: f64,
    r: f64,
    t: f64,
) -> (VgParams, f64)
```

### When to use VG vs Heston

| Scenario | Model |
|----------|-------|
| Weekly options, event risk | **VG** — better tail modeling |
| Monthly options, smooth skew | **Heston** — captures vol persistence |
| Calibrating full term structure | **Heston** — time-homogeneous dynamics |
| Pricing OTM puts for hedging | **VG** — heavier tails match market better |

---

## 7. Rust Dependency Plan

### Current
```toml
pyo3 = { version = "0.25", features = ["extension-module"] }
libm = "0.2"
```

### Phase 1 additions
```toml
rayon = "1.10"        # Parallel batch computation
```

### Phase 3 additions
```toml
num-complex = "0.4"   # Complex arithmetic for CFs
argmin = "0.10"       # Optimization (LM, DE, Nelder-Mead)
argmin-math = { version = "0.4", features = ["nalgebra_latest-serde"] }
nalgebra = "0.33"     # Linear algebra for Jacobians
```

### Phase 4 additions
```toml
rustfft = "6.4"       # FFT for Carr-Madan pricing
```

### Optional / evaluate
```toml
# volsurf = "0.1"     # Pre-built SVI/SABR/SSVI (evaluate vs custom impl)
# criterion = "0.5"   # Benchmarking (dev dependency)
```

---

## 8. File Structure

### Current
```
rust_core/src/
├── lib.rs       # PyO3 module + exports
└── bsm.rs       # BSM pricing, Greeks, IV solver
```

### After all phases
```
rust_core/src/
├── lib.rs        # PyO3 module + all exports
├── bsm.rs        # BSM pricing, Greeks, IV solver (+ warm-start)
├── svi.rs        # SVI surface calibration + evaluation
├── heston.rs     # Heston CF, pricing, calibration
├── fft.rs        # Carr-Madan FFT pricing engine + CF trait
├── vg.rs         # Variance Gamma CF + calibration
└── bench/        # Criterion benchmarks
    ├── iv_solver.rs
    ├── fft_pricing.rs
    └── calibration.rs
```

### Python consumer changes
```
quant_service/indicators/
├── greeks.py             # + chain-level batch, SVI fit, Heston recalib
├── strategy_analyzer.py  # + Heston-aware payoff curves
├── risk_exposure.py      # + Heston Greeks for portfolio risk
└── surface.py            # NEW — IV surface management + caching
```

---

## 9. References

### Papers
- Carr, P. & Madan, D. (1999). "Option Valuation Using the Fast Fourier Transform." *Journal of Computational Finance*, 2(4), 61-73. [PDF (NYU)](https://engineering.nyu.edu/sites/default/files/2018-08/CarrMadan2_0.pdf)
- Heston, S. (1993). "A Closed-Form Solution for Options with Stochastic Volatility." *Review of Financial Studies*, 6(2), 327-343.
- Gatheral, J. (2004). "A Parsimonious Arbitrage-Free Implied Volatility Parameterization." [Gatheral & Jacquier (arXiv)](https://arxiv.org/pdf/1204.0646)
- Madan, D., Carr, P. & Chang, E. (1998). "The Variance Gamma Process and Option Pricing." *European Finance Review*, 2, 79-105. [PDF (NYU)](https://engineering.nyu.edu/sites/default/files/2018-09/CarrEuropeanFinReview1998.pdf)
- Singh, V.K. & Dixit, A. (2016). "Performance of the Heston's Stochastic Volatility Model: Indian Index Options." [SCIRP](https://www.scirp.org/journal/paperinformation?paperid=65330)
- Jaeckel, P. (2015). "Let's Be Rational." [jaeckel.org](http://www.jaeckel.org/LetsBeRational.pdf)
- Albrecher, H., Mayer, P. & Schoutens, W. "The Little Heston Trap." [PDF](https://perswww.kuleuven.be/~u0009713/HestonTrap.pdf)
- Chourdakis, K. (2005). "Option Pricing Using the Fractional FFT." [CiteSeerX](https://citeseerx.ist.psu.edu/document?repid=rep1&type=pdf&doi=6bdf4696312d37427eda2740137650c09deacda7)

### Rust crates
- [rustfft 6.4](https://docs.rs/rustfft/latest/rustfft/) — FFT (pure Rust, SIMD)
- [argmin](https://argmin-rs.org/) — Optimization framework
- [nalgebra](https://nalgebra.org/) — Linear algebra
- [num-complex](https://docs.rs/num-complex/latest/num_complex/) — Complex arithmetic
- [rayon](https://docs.rs/rayon/latest/rayon/) — Data parallelism
- [volsurf](https://github.com/volsurf-rs/volsurf) — Vol surface library (SVI/SABR/SSVI)

### Calibration references
- [Heston Calibration in Rust (rust-dd.com)](https://rust-dd.com/post/calibrate-option-price-under-the-heston-model-using-rust)
- [Heston Calibration with QuantLib + SciPy](http://gouthamanbalaraman.com/blog/heston-calibration-scipy-optimize-quantlib-python.html)
- [Full and Fast Calibration of Heston (LSE)](https://eprints.lse.ac.uk/83754/1/Germano_Full%20and%20fast%20calibration_2017.pdf)
