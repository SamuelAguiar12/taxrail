# taxrail-mcp

**The Autonomous Tax-Optimization Rail for AI Agents (US + Brazil).**

Connect any MCP-compatible AI agent (Claude Desktop, Cursor, Windsurf, Antigravity, LangChain, Coinbase AgentKit) to deterministic **US (IRS Form 1099-DA, HIFO/SpecID, Tax-Loss Harvesting, Schedule C)** and **Brazil (Lei 14.754/2023, R$ 35k Domestic Exemption, Lucro Real 34%, PIS/COFINS, IBS/CBS)** tax optimization tools.

## Quickstart (`stdio` MCP)

Run directly with `npx`:

```bash
npx -y taxrail-mcp
```

Add to **Claude Desktop** or **Cursor** (`mcpServers`):

```json
{
  "mcpServers": {
    "taxrail": {
      "command": "npx",
      "args": ["-y", "taxrail-mcp"]
    }
  }
}
```

## Remote Streamable HTTP MCP (Zero Install)

- **Remote MCP Endpoint:** `https://api.taxrail.online/mcp`
- **A2A Agent Card:** `https://api.taxrail.online/.well-known/agent.json`
- **LLM Guide:** `https://api.taxrail.online/llms.txt`
- **OpenAPI 3.1 Spec:** `https://api.taxrail.online/openapi.json`

## Tools Included (9 Tools)

1. **`check_tax_impact` (FREE):** Compares naive FIFO vs. tax-optimized lot selection (SpecID/HIFO + TLH) and proves exact USD tax savings and ROI without exposing private lot IDs or calldata.
2. **`compare_borrow_vs_sell` (FREE):** Compares paying immediate capital gains tax against borrowing USDC on Aave v3 (`0%` realization event + corporate interest tax shield).
3. **`classify_deductible_expense` (FREE):** Classifies cloud/AI/SaaS/contractor expenses for US Schedule C / C-Corp or Brazil Lucro Real / Simples Export.
4. **`prepare_execution` (FREE — $0 Upfront):** Returns ready-to-sign `0x v2` / `Jupiter` swap calldata (up to 1000 bps) or `Aave v3` atomic borrow batch with TaxRail's exact **10% verified-savings fee** embedded inside the operation itself.
5. **`claim_dossier` (On-Chain Receipt Verification):** Verifies the settled swap or Aave borrow `txHash` on-chain and immediately unlocks exact `selectedLots` + `IRS Form 8949` / `BR Lei 14.754 / DeCripto` CSV dossiers.
6. **`unlock_tax_plan` (x402 Fallback on Base USDC):** Dossier-only / corporate expense unlock via x402 Base USDC. Costs **10% of verified tax savings** (`$0` if `$0` saved).
7. **`scan_wallet_tlh` ($0.01 x402):** Scans up to 25 volatile tokens on Base/Ethereum/Arbitrum for year-end TLH & HIFO savings.
8. **`pre_trade_check` ($0.01 x402):** Pre-swap guardrail checking HIFO savings, 366-day ST→LT cliffs, and Aave v3 borrow-vs-sell.
9. **`check_br_35k_status` ($0.005 x402):** Brazil R$35k monthly domestic exemption vs. Lei 14.754 15% flat tax headroom check.

## 20% Developer Affiliate Share

Pass `referrerWallet` (your Base/EVM address) or set `TAXRAIL_REFERRER_WALLET` to earn **20% of TaxRail's fee** on every unlocked plan.

## License & Disclaimer

MIT. TaxRail provides deterministic quantitative tax simulations for software automation and planning only. Outputs do not constitute legal, accounting, or tax advice; consult a licensed CPA or Brazilian Contador before filing.
