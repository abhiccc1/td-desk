"""Domain exceptions for the td-desk trading platform."""


class TDDeskBaseError(Exception):
    """Base exception for all td-desk errors."""


class BrokerAuthError(TDDeskBaseError):
    """Raised when broker authentication fails (bad credentials, invalid OTP)."""


class AuthStateError(TDDeskBaseError):
    """Raised when auth methods are called out of order."""


class BrokerConnectionError(TDDeskBaseError):
    """Raised when a broker WebSocket connection fails."""
