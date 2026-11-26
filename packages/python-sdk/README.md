# taxrail — Autonomous Pre-Trade Crypto Tax SDK for Python AI Agents

Zero-dependency Python client and ready-to-use tool wrappers (**OpenAI Function Calling**, **LangChain**, **CrewAI**) for **TaxRail** (`https://api.taxrail.online`).

Before any autonomous agent executes a DEX swap, sells appreciated crypto, rebalances a treasury, or pays invoices, **TaxRail** computes:
- **US IRS 1099-DA & Form 8949**: Per-wallet SpecID / HIFO lot selection, Short-Term → Long-Term cliff alerts, and year-end Tax-Loss Harvesting (TLH).
- **Brazil Lei 14.754/2023 & R$35k Rule**: Instant domestic monthly R$35,000 exemption headroom vs offshore/DEX 15% flat tax + Lucro Real 34%.
- **DeFi Borrow-vs-Sell**: Aave v3 non-custodial borrow comparison when tax cost exceeds interest cost.
- **20% Affiliate RevShare**: Pass `referrer_wallet="0xYourWallet"` to earn 20% of TaxRail's fees automatically on Base USDC (`eip155:8453`).

## Install

```bash
pip install taxrail
```

Optional framework integrations:

```bash
pip install "taxrail[langchain]"
pip install "taxrail[crewai]"
```

## Quickstart

```python
from taxrail import TaxRailClient, TaxRailPaymentRequiredError

client = TaxRailClient(referrer_wallet="0xYourIntegratorWallet")

# 1. FREE Step-1 pre-trade tax preview
preview = client.check_tax_impact(
    jurisdiction="US",
    regime="INDIVIDUAL",
    chain="base",
    target_asset="ETH",
    sell_quantity=1.0,
    wallet_address="0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
)
print(preview["taxSavedUsd"], preview["planId"])

# 2. $0-upfront 1-click execution (exact 10% fee paid from the swap or Aave borrow itself)
prep = client.prepare_execution(
    plan_id=preview["planId"],
    taker_address="0xYourWallet",
    buy_asset="wstETH",
)
# Sign & broadcast prep["executionPayload"], then claim Form 8949 / DeCripto CSV:
# dossier = client.claim_dossier(plan_id=preview["planId"], tx_hash="0x...", chain="base")

# 3. Paid x402 micro-endpoints ($0.01 pre-trade check, $0.005 BR R$35k check, $0.01 TLH scan)
try:
    status = client.br_35k_status(
        monthly_sales_brl=20000,
        planned_sale_usd=2500,
        custody_location="DOMESTIC",
    )
except TaxRailPaymentRequiredError as exc:
    # Contains parsed x402 v2 payment requirements (amount in USDC atomic units, network=eip155:8453, payTo)
    print("Pay x402 challenge:", exc.payment_required["accepts"][0])
```

## AI Framework Tool Wrappers

```python
from taxrail import TaxRailClient, get_openai_tools, as_langchain_tools, as_crewai_tools

client = TaxRailClient()
openai_tools = get_openai_tools()
lc_tools = as_langchain_tools(client)
crew_tools = as_crewai_tools(client)
```

## Links

- Website: https://taxrail.online
- Agent Skill (`SKILL.md`): https://api.taxrail.online/SKILL.md
- MCP Streamable HTTP: https://api.taxrail.online/mcp
- OpenAPI 3.1 Spec: https://api.taxrail.online/openapi.json
- Verified Reputation: https://api.taxrail.online/api/v1/reputation
