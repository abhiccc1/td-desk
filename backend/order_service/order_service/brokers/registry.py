"""Broker executor registry for order service."""

from __future__ import annotations

from order_service.brokers.base import BrokerExecutor

_brokers: dict[str, BrokerExecutor] = {}


def register_broker(exchange: str, executor: BrokerExecutor) -> None:
    _brokers[exchange.upper()] = executor


def get_broker(exchange: str) -> BrokerExecutor | None:
    return _brokers.get(exchange.upper())
