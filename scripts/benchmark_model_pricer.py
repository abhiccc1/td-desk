"""Micro-benchmark the model pricer hot paths with representative strike strips."""

from __future__ import annotations

from statistics import mean
import time

import td_core


RISK_FREE_RATE = 0.065
REPEATS = 20

HESTON_PARAMS = {
    "kappa": 1.8,
    "theta": 0.04,
    "sigma_v": 0.6,
    "rho": -0.55,
    "v0": 0.03,
}

VG_PARAMS = {
    "sigma": 0.12,
    "theta": -0.14,
    "nu": 0.2,
}


def linspace(start: float, stop: float, points: int) -> list[float]:
    if points <= 1:
        return [start]
    step = (stop - start) / (points - 1)
    return [start + step * idx for idx in range(points)]


def bench(label: str, fn) -> None:
    samples_ms: list[float] = []
    for _ in range(REPEATS):
        start = time.perf_counter()
        fn()
        samples_ms.append((time.perf_counter() - start) * 1000)

    print(
        f"{label:24s} avg={mean(samples_ms):7.2f}ms "
        f"min={min(samples_ms):7.2f}ms max={max(samples_ms):7.2f}ms",
    )


def main() -> None:
    spot = 22_500.0
    t = 7.0 / 365.25
    strikes = [float(k) for k in range(21_000, 24_001, 50)]
    spot_grid = linspace(spot * 0.7, spot * 1.3, 500)

    bench(
        "heston_chain_full",
        lambda: td_core.heston_chain_full(HESTON_PARAMS, spot, RISK_FREE_RATE, t, strikes),
    )
    bench(
        "vg_chain_full",
        lambda: td_core.vg_chain_full(VG_PARAMS, spot, RISK_FREE_RATE, t, strikes),
    )
    bench(
        "heston_density",
        lambda: td_core.risk_neutral_density(
            "heston", HESTON_PARAMS, spot, RISK_FREE_RATE, t, spot_grid,
        ),
    )
    bench(
        "vg_density",
        lambda: td_core.risk_neutral_density(
            "vg", VG_PARAMS, spot, RISK_FREE_RATE, t, spot_grid,
        ),
    )


if __name__ == "__main__":
    main()
