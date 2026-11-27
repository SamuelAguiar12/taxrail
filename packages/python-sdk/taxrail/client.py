"""Zero-dependency HTTP + x402 v2 client for TaxRail Edge API."""

from __future__ import annotations

import base64
import json
from typing import Any, Dict, List, Optional
from urllib import error as urllib_error
from urllib import parse as urllib_parse
from urllib import request as urllib_request

DEFAULT_BASE_URL = "https://api.taxrail.online"


class TaxRailAPIError(Exception):
    """Raised on non-402 HTTP error responses from TaxRail."""

    def __init__(self, status_code: int, message: str, payload: Optional[Any] = None) -> None:
        super().__init__(f"TaxRail API HTTP {status_code}: {message}")
        self.status_code = status_code
        self.message = message
        self.payload = payload


class TaxRailPaymentRequiredError(TaxRailAPIError):
    """Raised when an x402-protected endpoint responds with HTTP 402 Payment Required."""

    def __init__(
        self,
        payment_required: Dict[str, Any],
        raw_header: Optional[str] = None,
    ) -> None:
        msg = str(payment_required.get("error") or "Payment Required (x402 v2)")
        super().__init__(402, msg, payment_required)
        self.payment_required = payment_required
        self.raw_header = raw_header


def _decode_payment_required_header(header_value: Optional[str]) -> Optional[Dict[str, Any]]:
    if not header_value:
        return None
    try:
        padded = header_value.strip()
        missing = len(padded) % 4
        if missing:
            padded += "=" * (4 - missing)
        decoded = base64.b64decode(padded).decode("utf-8")
        parsed = json.loads(decoded)
        if isinstance(parsed, dict):
            return parsed
    except Exception:
        return None
    return None


class TaxRailClient:
    """Lightweight synchronous Python client for TaxRail's free preview and x402 endpoints."""

    def __init__(
        self,
        base_url: str = DEFAULT_BASE_URL,
        referrer_wallet: Optional[str] = None,
        timeout_seconds: float = 20.0,
        user_agent: str = "taxrail-python-sdk/0.2.0",
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.referrer_wallet = referrer_wallet
        self.timeout_seconds = timeout_seconds
        self.user_agent = user_agent

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Optional[Dict[str, Any]] = None,
        json_body: Optional[Dict[str, Any]] = None,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        url = f"{self.base_url}{path}"
        if params:
            filtered = {k: str(v) for k, v in params.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib_parse.urlencode(filtered)}"

        headers: Dict[str, str] = {
            "Accept": "application/json",
            "User-Agent": self.user_agent,
        }
        if self.referrer_wallet:
            headers["X-TaxRail-Referrer"] = self.referrer_wallet
        if payment_signature:
            headers["PAYMENT-SIGNATURE"] = payment_signature

        data_bytes: Optional[bytes] = None
        if json_body is not None:
            payload = dict(json_body)
            if self.referrer_wallet and "referrerWallet" not in payload:
                payload["referrerWallet"] = self.referrer_wallet
            data_bytes = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = urllib_request.Request(url=url, data=data_bytes, headers=headers, method=method)

        try:
            with urllib_request.urlopen(req, timeout=self.timeout_seconds) as resp:
                raw_text = resp.read().decode("utf-8")
                return json.loads(raw_text) if raw_text else {}
        except urllib_error.HTTPError as err:
            raw_err = err.read().decode("utf-8", errors="replace")
            parsed_err: Any
            try:
                parsed_err = json.loads(raw_err)
            except Exception:
                parsed_err = {"error": raw_err}

            if err.code == 402:
                raw_pr_header = err.headers.get("PAYMENT-REQUIRED")
                payment_required: Dict[str, Any]
                if isinstance(parsed_err, dict) and "accepts" in parsed_err:
                    payment_required = parsed_err
                else:
                    payment_required = _decode_payment_required_header(raw_pr_header) or {
                        "x402Version": 2,
                        "error": raw_err or "Payment required",
                        "accepts": [],
                    }
                raise TaxRailPaymentRequiredError(payment_required, raw_pr_header) from err

            message = (
                parsed_err.get("error")
                if isinstance(parsed_err, dict)
                else str(parsed_err)
            ) or f"HTTP {err.code}"
            raise TaxRailAPIError(err.code, str(message), parsed_err) from err

    def health(self) -> Dict[str, Any]:
        """Return API health status."""
        return self._request("GET", "/health")

    def reputation(self) -> Dict[str, Any]:
        """Return verified public payer reviews and BaseScan settlement statistics."""
        return self._request("GET", "/api/v1/reputation")

    def check_tax_impact(
        self,
        *,
        jurisdiction: str = "US",
        regime: Optional[str] = None,
        chain: str = "base",
        target_asset: str = "ETH",
        sell_quantity: float = 1.0,
        wallet_address: Optional[str] = None,
        current_price_usd: Optional[float] = None,
        target_quote_asset: str = "USDC",
        lots: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Free Step-1 tax optimization simulation returning redacted savings and an unlockable planId."""
        resolved_regime = regime or ("PF_LEI_14754" if jurisdiction.upper() == "BR" else "INDIVIDUAL")
        body: Dict[str, Any] = {
            "jurisdiction": jurisdiction.upper(),
            "regime": resolved_regime,
            "chain": chain,
            "targetAsset": target_asset,
            "sellQuantity": sell_quantity,
            "targetQuoteAsset": target_quote_asset,
        }
        if wallet_address:
            body["walletAddress"] = wallet_address
        if current_price_usd is not None:
            body["currentPriceUsd"] = current_price_usd
        if lots is not None:
            body["lots"] = lots
        return self._request("POST", "/api/v1/check-tax-impact", json_body=body)

    def borrow_vs_sell(
        self,
        *,
        jurisdiction: str = "US",
        regime: Optional[str] = None,
        chain: str = "base",
        collateral_asset: str = "ETH",
        collateral_quantity: float = 2.0,
        collateral_price_usd: float = 3000.0,
        collateral_cost_basis_usd: float = 800.0,
        liquidity_needed_usd: float = 2500.0,
        holding_days: int = 120,
        holding_horizon_days: int = 90,
    ) -> Dict[str, Any]:
        """Free Step-1 simulation comparing selling appreciated crypto vs borrowing USDC on Aave v3."""
        resolved_regime = regime or ("PF_LEI_14754" if jurisdiction.upper() == "BR" else "INDIVIDUAL")
        body: Dict[str, Any] = {
            "jurisdiction": jurisdiction.upper(),
            "regime": resolved_regime,
            "chain": chain,
            "collateralAsset": collateral_asset,
            "collateralAmount": collateral_quantity,
            "collateralPriceUsd": collateral_price_usd,
            "collateralCostBasisUsd": collateral_cost_basis_usd,
            "liquidityNeededUsd": liquidity_needed_usd,
            "holdingDays": holding_days,
            "horizonDays": holding_horizon_days,
        }
        return self._request("POST", "/api/v1/borrow-vs-sell", json_body=body)

    def classify_expense(
        self,
        *,
        jurisdiction: str = "US",
        regime: Optional[str] = None,
        amount_usd: float,
        vendor: str,
        category: str,
        description: Optional[str] = None,
        payment_asset: str = "USDC",
    ) -> Dict[str, Any]:
        """Free Step-1 corporate crypto expense tax deductibility simulator (C-Corp / Brazil Lucro Real)."""
        resolved_regime = regime or ("PJ_LUCRO_REAL" if jurisdiction.upper() == "BR" else "C_CORP")
        body: Dict[str, Any] = {
            "jurisdiction": jurisdiction.upper(),
            "regime": resolved_regime,
            "amountUsd": amount_usd,
            "vendorName": vendor,
            "category": category,
            "description": description or f"{category} expense ({vendor})",
            "paymentAsset": payment_asset,
        }
        return self._request("POST", "/api/v1/classify-expense", json_body=body)

    def unlock_plan(
        self,
        *,
        plan_id: str,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Step-2 x402 fallback unlock returning exact SpecID lot IDs, calldata, and CSV/JSON dossiers."""
        return self._request(
            "POST",
            "/api/v1/unlock-plan",
            json_body={"planId": plan_id},
            payment_signature=payment_signature,
        )

    def prepare_execution(
        self,
        *,
        plan_id: str,
        taker_address: Optional[str] = None,
        buy_asset: Optional[str] = None,
        borrower_address: Optional[str] = None,
    ) -> Dict[str, Any]:
        """FREE $0-upfront pre-execution builder returning 0x v2 / Jupiter / Aave v3 calldata with 10% fee embedded inside the operation."""
        body: Dict[str, Any] = {"planId": plan_id}
        if taker_address:
            body["takerAddress"] = taker_address
        if buy_asset:
            body["buyAsset"] = buy_asset
        if borrower_address:
            body["borrowerAddress"] = borrower_address
        return self._request("POST", "/api/v1/prepare-execution", json_body=body)

    def claim_dossier(
        self,
        *,
        plan_id: str,
        tx_hash: str,
        chain: Optional[str] = None,
        fee_tx_hash: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Verify on-chain operation fee receipt by txHash and unlock SpecID lots + Form 8949 / DeCripto CSV dossier."""
        body: Dict[str, Any] = {"planId": plan_id, "txHash": tx_hash}
        if chain:
            body["chain"] = chain
        if fee_tx_hash:
            body["feeTxHash"] = fee_tx_hash
        return self._request("POST", "/api/v1/claim-dossier", json_body=body)

    def tlh_scan(
        self,
        *,
        wallet_address: str,
        chain: str = "base",
        asset: str = "ALL",
        jurisdiction: str = "US",
        regime: Optional[str] = None,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        """$0.01 USDC x402 multi-asset wallet Tax-Loss Harvesting & IRS 1099-DA / Lei 14.754 scan."""
        return self._request(
            "GET",
            "/api/v1/x402/tlh-scan",
            params={
                "walletAddress": wallet_address,
                "chain": chain,
                "asset": asset,
                "jurisdiction": jurisdiction,
                "regime": regime,
                "referrerWallet": self.referrer_wallet,
            },
            payment_signature=payment_signature,
        )

    def pre_trade_check(
        self,
        *,
        wallet_address: str,
        sell_asset: str,
        sell_amount: float,
        chain: str = "base",
        jurisdiction: str = "US",
        regime: Optional[str] = None,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        """$0.01 USDC x402 pre-trade swap guardrail (HIFO savings, ST->LT cliff alert, Aave borrow check)."""
        return self._request(
            "GET",
            "/api/v1/x402/pre-trade-check",
            params={
                "walletAddress": wallet_address,
                "sellAsset": sell_asset,
                "sellAmount": sell_amount,
                "chain": chain,
                "jurisdiction": jurisdiction,
                "regime": regime,
                "referrerWallet": self.referrer_wallet,
            },
            payment_signature=payment_signature,
        )

    def br_35k_status(
        self,
        *,
        monthly_sales_brl: float = 0.0,
        planned_sale_usd: float = 1000.0,
        custody_location: str = "DOMESTIC",
        usd_brl_rate: float = 5.8,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        """$0.005 USDC x402 Brazil R$35k monthly exemption & Lei 14.754 flat 15% tax check."""
        return self._request(
            "GET",
            "/api/v1/x402/br-35k-status",
            params={
                "monthlySalesBrl": monthly_sales_brl,
                "plannedSaleUsd": planned_sale_usd,
                "custodyLocation": custody_location,
                "usdBrlRate": usd_brl_rate,
            },
            payment_signature=payment_signature,
        )

    def quick_optimize(
        self,
        payload: Dict[str, Any],
        *,
        payment_signature: Optional[str] = None,
    ) -> Dict[str, Any]:
        """1-step $0.10 USDC x402 optimize endpoint returning calldata + tax dossier in a single call."""
        return self._request(
            "POST",
            "/api/v1/x402/optimize",
            json_body=payload,
            payment_signature=payment_signature,
        )

    def submit_feedback(
        self,
        *,
        rating: int,
        category: str,
        comment: str,
        plan_id: Optional[str] = None,
        settlement_tx: Optional[str] = None,
        allow_public_quote: bool = False,
        agent_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Submit product feedback or a post-settlement verified review (`POST /api/v1/feedback`)."""
        body: Dict[str, Any] = {
            "rating": rating,
            "category": category,
            "comment": comment,
            "allowPublicQuote": allow_public_quote,
        }
        if plan_id:
            body["planId"] = plan_id
        if settlement_tx:
            body["settlementTx"] = settlement_tx
        if agent_name:
            body["agentName"] = agent_name
        return self._request("POST", "/api/v1/feedback", json_body=body)
