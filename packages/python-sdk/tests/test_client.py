import base64
import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, Tuple

from taxrail import (
    TaxRailClient,
    TaxRailPaymentRequiredError,
    as_crewai_tools,
    as_langchain_tools,
    get_openai_tools,
)


class _MockTaxRailHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _send_json(self, code: int, payload: Dict[str, Any], headers: Dict[str, str] | None = None) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/health"):
            self._send_json(200, {"status": "ok", "service": "taxrail-edge"})
            return

        if self.path.startswith("/api/v1/x402/br-35k-status"):
            sig = self.headers.get("PAYMENT-SIGNATURE")
            if not sig:
                challenge = {
                    "x402Version": 2,
                    "error": "Payment required: $0.005 USDC",
                    "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "5000"}],
                }
                b64 = base64.b64encode(json.dumps(challenge).encode("utf-8")).decode("utf-8")
                self._send_json(402, challenge, {"PAYMENT-REQUIRED": b64})
                return
            self._send_json(200, {"status": "EXEMPT_UNDER_35K", "estimatedTaxRatePct": 0})
            return

        if self.path.startswith("/api/v1/x402/pre-trade-check"):
            sig = self.headers.get("PAYMENT-SIGNATURE")
            if not sig:
                challenge = {
                    "x402Version": 2,
                    "error": "Payment required: $0.01 USDC",
                    "accepts": [{"scheme": "exact", "network": "eip155:8453", "amount": "10000"}],
                }
                self._send_json(402, challenge)
                return
            self._send_json(
                200,
                {
                    "status": "PRE_TRADE_OPTIMIZED",
                    "recommendation": "SELL_OPTIMIZED_HIFO",
                    "taxSavedUsd": 420.0,
                    "referrerSeen": self.headers.get("X-TaxRail-Referrer"),
                },
            )
            return

        self._send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        if self.path == "/api/v1/check-tax-impact":
            self._send_json(
                200,
                {
                    "planId": "plan_py_test_123",
                    "taxSavedUsd": 310.0,
                    "referrerWallet": body.get("referrerWallet"),
                },
            )
            return
        self._send_json(404, {"error": "Not found"})


class TaxRailPythonSdkTest(unittest.TestCase):
    server: ThreadingHTTPServer
    thread: threading.Thread
    base_url: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), _MockTaxRailHandler)
        port: Tuple[str, int] = cls.server.server_address  # type: ignore[assignment]
        cls.base_url = f"http://127.0.0.1:{port[1]}"
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def test_health_and_free_preview_with_referrer(self) -> None:
        client = TaxRailClient(
            base_url=self.base_url,
            referrer_wallet="0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
        )
        self.assertEqual(client.health()["status"], "ok")

        preview = client.check_tax_impact(
            wallet_address="0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
            target_asset="ETH",
            sell_quantity=1.0,
        )
        self.assertEqual(preview["planId"], "plan_py_test_123")
        self.assertEqual(preview["referrerWallet"], "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1")

    def test_x402_challenge_and_paid_signature(self) -> None:
        client = TaxRailClient(base_url=self.base_url, referrer_wallet="0xRef123")
        with self.assertRaises(TaxRailPaymentRequiredError) as ctx:
            client.br_35k_status(monthly_sales_brl=20000, planned_sale_usd=2500)
        self.assertEqual(ctx.exception.status_code, 402)
        self.assertEqual(ctx.exception.payment_required["accepts"][0]["amount"], "5000")
        self.assertIsNotNone(ctx.exception.raw_header)

        paid_br = client.br_35k_status(
            monthly_sales_brl=20000,
            planned_sale_usd=2500,
            payment_signature="signed-x402-payload",
        )
        self.assertEqual(paid_br["status"], "EXEMPT_UNDER_35K")

        paid_pre_trade = client.pre_trade_check(
            wallet_address="0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
            sell_asset="ETH",
            sell_amount=1.0,
            payment_signature="signed-x402-payload",
        )
        self.assertEqual(paid_pre_trade["recommendation"], "SELL_OPTIMIZED_HIFO")
        self.assertEqual(paid_pre_trade["referrerSeen"], "0xRef123")

    def test_framework_tool_wrappers(self) -> None:
        openai_tools = get_openai_tools()
        self.assertEqual(len(openai_tools), 4)
        client = TaxRailClient(base_url=self.base_url)
        lc_tools = as_langchain_tools(client)
        crew_tools = as_crewai_tools(client)
        self.assertEqual(len(lc_tools), 4)
        self.assertEqual(len(crew_tools), 4)

        # Calling a fallback tool dict on 402 returns JSON string with status=402
        br_tool = [t for t in lc_tools if (t["name"] if isinstance(t, dict) else t.name) == "taxrail_br_35k_status"][0]
        raw = br_tool["func"](monthly_sales_brl=1000, planned_sale_usd=500, custody_location="DOMESTIC")
        parsed = json.loads(raw)
        self.assertEqual(parsed["status"], 402)


if __name__ == "__main__":
    unittest.main()
