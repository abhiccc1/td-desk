"""Risk exposure calculator — tracks portfolio-level net Greeks and beta."""

import numpy as np
import structlog
import riskfolio as rp

from shared.schemas.events import EventType, RedisEvent

from quant_service.indicators.registry import IndicatorBase, register

log = structlog.get_logger()


@register([EventType.GREEKS_COMPUTED])
class RiskExposureCalculator(IndicatorBase):
    """Aggregate portfolio-level Greeks and compute portfolio beta."""

    def __init__(self) -> None:
        # Running totals of portfolio Greeks keyed by symbol
        self._positions: dict[str, dict[str, float]] = {}
        # Historical returns for beta calculation
        self._returns_history: dict[str, list[float]] = {}
        self._benchmark_returns: list[float] = []

    async def compute(self, event: RedisEvent) -> list[RedisEvent]:
        payload = event.payload

        symbol: str = payload.get("symbol", "")
        underlying: str = payload.get("underlying", "")
        delta: float = payload.get("delta", 0.0)
        gamma: float = payload.get("gamma", 0.0)
        theta: float = payload.get("theta", 0.0)
        vega: float = payload.get("vega", 0.0)

        # Update per-symbol Greeks
        self._positions[symbol] = {
            "delta": delta,
            "gamma": gamma,
            "theta": theta,
            "vega": vega,
            "underlying": underlying,
        }

        # Aggregate net portfolio Greeks
        net_delta = sum(pos["delta"] for pos in self._positions.values())
        net_gamma = sum(pos["gamma"] for pos in self._positions.values())
        net_theta = sum(pos["theta"] for pos in self._positions.values())
        net_vega = sum(pos["vega"] for pos in self._positions.values())

        # Compute portfolio beta using riskfolio-lib if we have enough data
        portfolio_beta = self._compute_portfolio_beta()

        exposure_payload = {
            "net_delta": round(net_delta, 6),
            "net_gamma": round(net_gamma, 6),
            "net_theta": round(net_theta, 6),
            "net_vega": round(net_vega, 6),
            "portfolio_beta": round(portfolio_beta, 4) if portfolio_beta is not None else None,
            "num_positions": len(self._positions),
            "positions": {
                sym: {
                    "delta": round(pos["delta"], 6),
                    "gamma": round(pos["gamma"], 6),
                    "theta": round(pos["theta"], 6),
                    "vega": round(pos["vega"], 6),
                }
                for sym, pos in self._positions.items()
            },
        }

        result_event = RedisEvent(
            event_type=EventType.RISK_EXPOSURE,
            source_service="quant_service",
            payload=exposure_payload,
        )

        log.info(
            "risk.exposure_updated",
            net_delta=exposure_payload["net_delta"],
            net_gamma=exposure_payload["net_gamma"],
            positions=len(self._positions),
        )

        return [result_event]

    def _compute_portfolio_beta(self) -> float | None:
        """Estimate portfolio beta using riskfolio-lib covariance estimation."""
        if len(self._returns_history) < 2 or len(self._benchmark_returns) < 20:
            return None

        try:
            import pandas as pd

            # Build returns DataFrame from historical data
            asset_names = list(self._returns_history.keys())
            min_len = min(len(v) for v in self._returns_history.values())
            min_len = min(min_len, len(self._benchmark_returns))

            if min_len < 20:
                return None

            returns_data = {
                name: self._returns_history[name][-min_len:]
                for name in asset_names
            }
            returns_df = pd.DataFrame(returns_data)

            # Use riskfolio Portfolio object for covariance estimation
            port = rp.Portfolio(returns=returns_df)
            port.assets_stats(method_mu="hist", method_cov="hist")

            # Portfolio beta = weighted covariance with benchmark / benchmark variance
            benchmark = np.array(self._benchmark_returns[-min_len:])
            benchmark_var = np.var(benchmark, ddof=1)

            if benchmark_var < 1e-12:
                return None

            # Equal-weight approximation for current portfolio
            n_assets = len(asset_names)
            weights = np.ones(n_assets) / n_assets
            portfolio_returns = returns_df.values @ weights

            cov_with_benchmark = np.cov(portfolio_returns, benchmark)[0, 1]
            beta = cov_with_benchmark / benchmark_var

            return float(beta)

        except Exception:
            log.debug("risk.beta_computation_skipped", reason="insufficient_data_or_error")
            return None

    def update_returns(self, symbol: str, ret: float, benchmark_ret: float | None = None) -> None:
        """Append a return observation for beta tracking."""
        if symbol not in self._returns_history:
            self._returns_history[symbol] = []
        self._returns_history[symbol].append(ret)

        if benchmark_ret is not None:
            self._benchmark_returns.append(benchmark_ret)
