# taxrail-agent-tools

Autonomous US & Brazil pre-trade crypto/DeFi/corporate tax-optimization tools for **Coinbase AgentKit**, **LangChain**, and custom AI agent runtimes — backed by **MCP × x402** on Base (`eip155:8453` USDC).

## Install

```bash
npm install taxrail-agent-tools
```

## Quickstart

### 1. Direct Client + `$0.01 USDC` Wallet TLH Scanner (`referrerWallet` = 20% RevShare)

```ts
import { createTaxRailClient } from "taxrail-agent-tools";

const taxRail = createTaxRailClient({
  baseUrl: "https://api.taxrail.online",
  referrerWallet: "0xYourDeveloperWalletOnBase", // earns 20% of TaxRail fees
});

// Free pre-trade check
const preview = await taxRail.checkTaxImpact({
  jurisdiction: "US",
  regime: "INDIVIDUAL",
  chain: "base",
  targetAsset: "ETH",
  sellQuantity: 1,
  walletAddress: "0x0202e70990d90325A1Dca322C91471Be774E4B6f",
});

// Or $0.01 USDC instant wallet TLH risk scan (returns x402 402 challenge until paid)
const scan = await taxRail.scanWalletTlh({
  walletAddress: "0x0202e70990d90325A1Dca322C91471Be774E4B6f",
  chain: "base",
  asset: "ETH",
});
```

### 2. Coinbase AgentKit

```ts
import { TaxRailActionProvider } from "taxrail-agent-tools";

const taxRail = new TaxRailActionProvider({
  baseUrl: "https://api.taxrail.online",
  referrerWallet: "0xYourDeveloperWalletOnBase",
});

const actions = taxRail.getActions();
```

### 3. LangChain

```ts
import { DynamicStructuredTool } from "@langchain/core/tools";
import { createTaxRailLangChainTools } from "taxrail-agent-tools";

const tools = createTaxRailLangChainTools({
  referrerWallet: "0xYourDeveloperWalletOnBase",
}).map((spec) => new DynamicStructuredTool(spec));
```

## Links

- Live API & Discovery: https://api.taxrail.online
- OpenAPI 3.1: https://api.taxrail.online/openapi.json
- Portable Agent Skill: https://api.taxrail.online/SKILL.md
- Source: https://github.com/SamuelAguiar12/taxrail
