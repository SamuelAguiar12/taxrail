"""TaxRail Python SDK for autonomous AI agents."""

from .client import (
    DEFAULT_BASE_URL,
    TaxRailAPIError,
    TaxRailClient,
    TaxRailPaymentRequiredError,
)
from .integrations import (
    as_crewai_tools,
    as_langchain_tools,
    get_openai_tools,
)

__all__ = [
    "DEFAULT_BASE_URL",
    "TaxRailAPIError",
    "TaxRailClient",
    "TaxRailPaymentRequiredError",
    "as_crewai_tools",
    "as_langchain_tools",
    "get_openai_tools",
]

__version__ = "0.2.0"
