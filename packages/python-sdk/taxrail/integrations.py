"""OpenAI Function Calling, LangChain, and CrewAI tool adapters for TaxRail."""

from __future__ import annotations

import json
from typing import Any, Callable, Dict, List, Optional

from .client import TaxRailClient, TaxRailPaymentRequiredError


def _safe_exec(fn: Callable[..., Dict[str, Any]], **kwargs: Any) -> str:
    try:
        return json.dumps(fn(**kwargs))
    except TaxRailPaymentRequiredError as exc:
        return json.dumps({"status": 402, "paymentRequired": exc.payment_required})


def get_openai_tools() -> List[Dict[str, Any]]:
    """Return OpenAI / Responses API JSON tool definitions for TaxRail pre-trade & 1-click execution endpoints."""
    return [
        {
            "type": "function",
            "function": {
                "name": "taxrail_check_tax_impact",
                "description": (
                    "Call BEFORE swapping or selling crypto. Simulates US (IRS 1099-DA, HIFO/SpecID) "
                    "or Brazil (Lei 14.754, R$35k exemption) tax savings and returns an unlockable planId."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "jurisdiction": {"type": "string", "enum": ["US", "BR"]},
                        "chain": {"type": "string", "enum": ["base", "ethereum", "arbitrum"]},
                        "target_asset": {"type": "string"},
                        "sell_quantity": {"type": "number"},
                        "wallet_address": {"type": "string"},
                    },
                    "required": ["target_asset", "sell_quantity", "wallet_address"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "taxrail_borrow_vs_sell",
                "description": (
                    "Compare selling appreciated crypto (realizing capital gains tax) vs borrowing "
                    "USDC on Aave v3 before executing liquidity trades."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "jurisdiction": {"type": "string", "enum": ["US", "BR"]},
                        "chain": {"type": "string", "enum": ["base", "ethereum", "arbitrum"]},
                        "collateral_asset": {"type": "string"},
                        "collateral_quantity": {"type": "number"},
                        "collateral_price_usd": {"type": "number"},
                        "collateral_cost_basis_usd": {"type": "number"},
                        "liquidity_needed_usd": {"type": "number"},
                    },
                    "required": [
                        "collateral_asset",
                        "collateral_quantity",
                        "collateral_price_usd",
                        "collateral_cost_basis_usd",
                        "liquidity_needed_usd",
                    ],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "taxrail_pre_trade_check",
                "description": (
                    "$0.01 USDC x402 pre-trade swap guardrail: checks HIFO savings, ST->LT tax cliff, "
                    "and Aave v3 borrow-vs-sell before executing any swap."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "wallet_address": {"type": "string"},
                        "sell_asset": {"type": "string"},
                        "sell_amount": {"type": "number"},
                        "chain": {"type": "string", "enum": ["base", "ethereum", "arbitrum"]},
                        "jurisdiction": {"type": "string", "enum": ["US", "BR"]},
                        "payment_signature": {"type": "string"},
                    },
                    "required": ["wallet_address", "sell_asset", "sell_amount"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "taxrail_br_35k_status",
                "description": (
                    "$0.005 USDC x402 Brazil R$35k monthly domestic exemption vs Lei 14.754 15% flat tax check."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "monthly_sales_brl": {"type": "number"},
                        "planned_sale_usd": {"type": "number"},
                        "custody_location": {"type": "string", "enum": ["DOMESTIC", "OFFSHORE"]},
                        "usd_brl_rate": {"type": "number"},
                        "payment_signature": {"type": "string"},
                    },
                    "required": ["monthly_sales_brl", "planned_sale_usd", "custody_location"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "taxrail_prepare_execution",
                "description": (
                    "FREE $0-upfront builder: returns ready-to-sign 0x v2 swap or Aave v3 atomic borrow batch "
                    "paying TaxRail's exact 10% verified-savings fee directly out of the operation."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plan_id": {"type": "string"},
                        "taker_address": {"type": "string"},
                        "buy_asset": {"type": "string"},
                        "borrower_address": {"type": "string"},
                    },
                    "required": ["plan_id"],
                },
            },
        },
        {
            "type": "function",
            "function": {
                "name": "taxrail_claim_dossier",
                "description": (
                    "Verify settled swap or Aave borrow txHash on-chain and unlock SpecID lots + "
                    "IRS Form 8949 / Brazil DeCripto CSV dossier ($0 upfront)."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "plan_id": {"type": "string"},
                        "tx_hash": {"type": "string"},
                        "chain": {"type": "string", "enum": ["base", "ethereum", "arbitrum"]},
                    },
                    "required": ["plan_id", "tx_hash"],
                },
            },
        },
    ]


def _build_callable_specs(client: TaxRailClient) -> List[Dict[str, Any]]:
    return [
        {
            "name": "taxrail_check_tax_impact",
            "description": (
                "Pre-trade crypto tax optimization preview (US IRS 1099-DA / Brazil Lei 14.754). "
                "Returns baseline vs HIFO tax and unlockable planId."
            ),
            "func": lambda **kwargs: _safe_exec(client.check_tax_impact, **kwargs),
        },
        {
            "name": "taxrail_borrow_vs_sell",
            "description": "Simulate selling appreciated crypto vs borrowing USDC on Aave v3.",
            "func": lambda **kwargs: _safe_exec(client.borrow_vs_sell, **kwargs),
        },
        {
            "name": "taxrail_pre_trade_check",
            "description": "$0.01 x402 pre-trade swap guardrail (HIFO, ST->LT cliff, Aave borrow check).",
            "func": lambda **kwargs: _safe_exec(client.pre_trade_check, **kwargs),
        },
        {
            "name": "taxrail_br_35k_status",
            "description": "$0.005 x402 Brazil R$35k monthly exemption & Lei 14.754 check.",
            "func": lambda **kwargs: _safe_exec(client.br_35k_status, **kwargs),
        },
        {
            "name": "taxrail_prepare_execution",
            "description": "FREE $0-upfront builder returning 0x v2 / Aave v3 calldata with 10% fee paid from operation.",
            "func": lambda **kwargs: _safe_exec(client.prepare_execution, **kwargs),
        },
        {
            "name": "taxrail_claim_dossier",
            "description": "Verify on-chain operation txHash and unlock SpecID lots + Form 8949 / DeCripto CSV.",
            "func": lambda **kwargs: _safe_exec(client.claim_dossier, **kwargs),
        },
    ]


def as_langchain_tools(client: Optional[TaxRailClient] = None) -> List[Any]:
    """Return LangChain `StructuredTool` instances if `langchain-core` is installed, else tool dicts."""
    resolved = client or TaxRailClient()
    specs = _build_callable_specs(resolved)
    try:
        from langchain_core.tools import StructuredTool  # type: ignore

        return [
            StructuredTool.from_function(
                name=spec["name"],
                description=spec["description"],
                func=spec["func"],
            )
            for spec in specs
        ]
    except ImportError:
        return specs


def as_crewai_tools(client: Optional[TaxRailClient] = None) -> List[Any]:
    """Return CrewAI `tool`-decorated callables if `crewai` is installed, else tool dicts."""
    resolved = client or TaxRailClient()
    specs = _build_callable_specs(resolved)
    try:
        from crewai.tools import tool as crewai_tool  # type: ignore

        wrapped: List[Any] = []
        for spec in specs:
            fn = spec["func"]
            fn.__name__ = spec["name"]
            fn.__doc__ = spec["description"]
            wrapped.append(crewai_tool(spec["name"])(fn))
        return wrapped
    except ImportError:
        return specs
