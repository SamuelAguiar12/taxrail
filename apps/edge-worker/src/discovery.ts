import {
  DEFAULT_X402_ASSET,
  DEFAULT_X402_NETWORK,
  type Env,
  resolvePublicBaseUrl,
} from "./env.js";

/**
 * Builds the A2A Agent Card (`/.well-known/agent.json`) advertising TaxRail's capabilities,
 * dynamic x402 pricing, affiliate program, and MCP/REST interfaces.
 */
export function buildAgentCard(env: Env, requestUrl?: string): Record<string, unknown> {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  const network = env.X402_NETWORK || DEFAULT_X402_NETWORK;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;

  return {
    name: "TaxRail",
    description:
      "Autonomous Tax-Optimization Rail for AI Agents (US + Brazil). Optimizes crypto tax-lot selection, tax-loss harvesting, DeFi Aave v3 borrow-vs-sell liquidity strategies, and deductible expense classification.",
    url: baseUrl,
    version: "0.1.0",
    provider: {
      organization: "TaxRail",
      url: baseUrl,
    },
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    jurisdictions: ["US", "BR"],
    supportedRegimes: {
      US: ["INDIVIDUAL", "LLC_PASS_THROUGH", "C_CORP"],
      BR: ["PF_LEI_14754", "PF_DOMESTIC", "PJ_LUCRO_REAL", "PJ_SIMPLES_EXPORT"],
    },
    endpoints: {
      mcp: {
        url: `${baseUrl}/mcp`,
        transport: "streamable-http",
      },
      rest: {
        baseUrl: `${baseUrl}/api/v1`,
        openapi: `${baseUrl}/openapi.json`,
        x402Manifest: `${baseUrl}/.well-known/x402`,
      },
      llmsTxt: `${baseUrl}/llms.txt`,
      skillMd: `${baseUrl}/SKILL.md`,
    },
    pricing: {
      model: "zero-upfront-pay-from-operation",
      freePreview: true,
      feeRatePct: 0.1,
      tierRangePct: { min: 0.1, max: 0.1 },
      zeroFeeWhenZeroSavings: true,
      zeroUpfrontOperationFeeAvailable: true,
      maxEmbeddedSwapFeeBps: 1000,
      protocol: "x402",
      x402Version: 2,
      network,
      asset,
      currency: "USDC",
      summary:
        "Preview & prepare-execution endpoints are 100% FREE ($0 upfront). For swaps (0x v2 / Jupiter) and Aave v3 borrow-vs-sell, TaxRail collects its exact 10% verified-savings fee directly out of the operation proceeds and unlocks the SpecID / Form 8949 / DeCripto dossier via /api/v1/claim-dossier. x402 Base USDC (/api/v1/unlock-plan) remains available for corporate expenses and dossier-only unlocks. $0 fee if $0 saved.",
    },
    affiliateProgram: {
      enabled: true,
      revsharePct: 0.2,
      parameter: "referrerWallet",
      description:
        "Integrators and AI agents passing `referrerWallet` earn 20% of TaxRail's total fee on every unlocked plan.",
    },
    skills: [
      {
        id: "check_tax_impact",
        name: "Check Crypto Disposal Tax Impact",
        description:
          "FREE preview comparing naive FIFO disposal vs tax-optimized lot selection and TLH across US & Brazil regimes. Returns verified tax savings, dynamic x402 quote, and a redacted planId.",
        tags: ["tax", "crypto", "fifo", "specid", "tlh", "us", "brazil", "free"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "compare_borrow_vs_sell",
        name: "Compare DeFi Borrow vs Sell",
        description:
          "FREE preview comparing selling appreciated crypto vs borrowing USDC against collateral on Aave v3. Returns after-tax cost comparison, LTV projection, and planId.",
        tags: ["defi", "aave-v3", "borrow", "liquidity", "tax-shield", "free"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "classify_deductible_expense",
        name: "Classify Deductible Business Expense",
        description:
          "FREE preview classifying AI/cloud/SaaS/contractor expenses for US C-Corp/LLC or Brazil Lucro Real (IRPJ/CSLL, PIS/COFINS, IBS/CBS, IOF savings).",
        tags: ["expense", "deductible", "quickbooks", "sped", "lucro-real", "free"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "wallet_tlh_scan",
        name: "Instant Wallet TLH & Tax-Risk Scan ($0.01 USDC)",
        description:
          "1-parameter x402 endpoint (`GET /api/v1/x402/tlh-scan?walletAddress=0x...`) for $0.01 Base USDC. Scans on-chain cost-basis lots, year-end Tax-Loss Harvesting opportunities, US 1099-DA & Brazil Lei 14.754 exposure, and creates an unlockable optimization plan.",
        tags: ["x402", "tlh", "wallet-scanner", "tax-loss-harvesting", "irs-1099-da", "lei-14754", "base"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "prepare_execution",
        name: "Prepare 1-Click $0-Upfront Execution & Claim Dossier",
        description:
          "FREE pre-execution endpoint (`POST /api/v1/prepare-execution`) returning ready-to-sign 0x v2 / Jupiter swap calldata or Aave v3 atomic borrow batch with TaxRail's exact 10% fee embedded inside the operation ($0 upfront). After broadcasting, call `POST /api/v1/claim-dossier` with the txHash to unlock SpecID lots and Form 8949 / DeCripto CSV.",
        tags: ["zero-upfront", "1-click", "0x-v2", "aave-v3", "claim-dossier", "free"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
      {
        id: "unlock_tax_plan",
        name: "Unlock Full Tax Optimization Plan",
        description:
          "PAID via dynamic x402 v2 (Base USDC) fallback for dossier-only or corporate expense unlocks. Unlocks exact lot IDs, 0x/Jupiter swap intent or Aave v3 calldata, and Form 8949 / Lei 14.754 / QuickBooks / Omie-SPED accounting dossier.",
        tags: ["x402", "calldata", "aave-v3", "0x", "form-8949", "lei-14754", "paid"],
        inputModes: ["application/json"],
        outputModes: ["application/json"],
      },
    ],
  };
}

/**
 * Builds the machine-readable `/llms.txt` guide for AI agents and crawlers.
 */
export function buildLlmsTxt(env: Env, requestUrl?: string): string {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  const network = env.X402_NETWORK || DEFAULT_X402_NETWORK;

  return `# TaxRail — Autonomous Tax-Optimization Rail for AI Agents (US + Brazil)

> TaxRail calculates verified tax savings for crypto disposals, DeFi Aave v3 borrow-vs-sell liquidity, and business expenses across US (IRS Individual, LLC, C-Corp) and Brazil (Lei 14.754/2023, PF Domestic R$35k, PJ Lucro Real, Simples Export).

## $0-Upfront 1-Click Flow (Pay 10% From Operation Proceeds)

1. **Step 1 — FREE Preview (No Payment Required)**
   - Call POST ${baseUrl}/api/v1/check-tax-impact, POST ${baseUrl}/api/v1/borrow-vs-sell, or POST ${baseUrl}/api/v1/classify-expense (or MCP tools \`check_tax_impact\`, \`compare_borrow_vs_sell\`, \`classify_deductible_expense\`).
   - Receive exact \`baselineTaxUsd\`, \`optimizedTaxUsd\`, \`taxSavedUsd\`, dynamic \`pricing\` quote, and a \`planId\` (TTL: 15 minutes).
   - Sensitive execution details (exact \`lotId\`s and accounting exports) are redacted until fee verification.

2. **Step 2A — $0-Upfront 1-Click Execution (Recommended for Swaps & Aave v3 Borrow)**
   - Call POST ${baseUrl}/api/v1/prepare-execution (or MCP tool \`prepare_execution\`) with \`{ "planId": "...", "takerAddress": "0x..." }\` for **$0 upfront**.
   - Returns ready-to-sign \`0x v2\` / \`Jupiter\` swap calldata (up to 1000 bps / 10%) or \`Aave v3\` \`atomicBatchCalls\` (borrowing \`liquidityNeeded + 10% fee\` and transferring the fee from the borrowed USDC).
   - Broadcast the transaction, then call POST ${baseUrl}/api/v1/claim-dossier (or MCP tool \`claim_dossier\`) with \`{ "planId": "...", "txHash": "0x...", "chain": "base" }\` to verify the on-chain fee transfer and unlock \`selectedLots\` + \`accountingDossier\`.

3. **Step 2B — Dossier-Only Fallback via x402 v2 (Base USDC)**
   - Call POST ${baseUrl}/api/v1/unlock-plan with \`{ "planId": "..." }\` (or MCP tool \`unlock_tax_plan\`).
   - If \`pricing.upfrontX402Usd == 0\` (e.g., $0 verified tax savings), the plan unlocks immediately for FREE.
   - Otherwise, the worker responds with **HTTP 402 Payment Required** and a \`PAYMENT-REQUIRED\` header for Base USDC (\`${network}\`) equal to **10% of verified tax savings** (upfront guardrail for dossier-only / corporate expense unlocks).
   - Retry with \`X-PAYMENT\` or \`PAYMENT-SIGNATURE\` header to receive \`selectedLots\`, calldata, and \`accountingDossier\`.

## Example ROI

- Disposal of $50,000 ETH with mixed short-term and long-term lots:
  - Baseline FIFO tax: **$9,600**
  - TaxRail HIFO + Tax-Loss Harvesting tax: **$2,100**
  - Verified Tax Saved: **$7,500**
  - TaxRail Fee (10%): **$750 total** (**$0 upfront** — 150 bps embedded inside the swap output)
  - Client Net Benefit: **$6,750** (**10x ROI**)

## Affiliate RevShare (20%)

Pass \`referrerWallet\` (e.g., \`"0xYourAgentWallet"\`) in any Step 1 request to earn **20% of TaxRail's total fee** automatically.

## Endpoints & Specs

- **Portable Agent Skill (\`SKILL.md\`):** ${baseUrl}/SKILL.md
- **MCP Streamable HTTP:** ${baseUrl}/mcp (\`npx -y taxrail-mcp\`)
- **TypeScript Agent SDK:** \`npm install taxrail-agent-tools\`
- **Python Agent SDK (Zero-Deps + LangChain/CrewAI):** \`pip install taxrail\`
- **A2A Agent Card:** ${baseUrl}/.well-known/agent.json
- **x402 Discovery Manifest:** ${baseUrl}/.well-known/x402
- **OpenAPI 3.1 Spec:** ${baseUrl}/openapi.json
- **$0.01 Wallet TLH Scanner (1-param GET):** ${baseUrl}/api/v1/x402/tlh-scan?walletAddress=0x...&chain=base
- **Pre-Trade Swap / Sell Guardrail ($0.01 USDC):** ${baseUrl}/api/v1/x402/pre-trade-check?walletAddress=0x...&sellAsset=ETH&sellAmount=1
- **Prepare $0-Upfront 1-Click Execution (FREE):** ${baseUrl}/api/v1/prepare-execution
- **Claim Dossier After On-Chain Execution:** ${baseUrl}/api/v1/claim-dossier
- **$0.005 Brazil R$35k & Lei 14.754 Check:** ${baseUrl}/api/v1/x402/br-35k-status?monthlySalesBrl=20000&plannedSaleUsd=2500&custodyLocation=DOMESTIC
- **1-Step Paid Optimize ($0.10 USDC):** ${baseUrl}/api/v1/x402/optimize
- **Agent Feedback (FREE):** ${baseUrl}/api/v1/feedback
- **Verified Reputation (FREE):** ${baseUrl}/api/v1/reputation
- **Health Check:** ${baseUrl}/health

## Copy-Paste Agent Quickstart

\`\`\`bash
# $0.01 instant multi-asset wallet TLH & tax-risk scan (x402 Base USDC)
curl -i "${baseUrl}/api/v1/x402/tlh-scan?walletAddress=0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1&chain=base&asset=ALL"

# $0.01 pre-trade swap/sell guardrail check (HIFO vs FIFO, ST->LT cliff, Aave borrow-vs-sell)
curl -i "${baseUrl}/api/v1/x402/pre-trade-check?walletAddress=0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1&sellAsset=ETH&sellAmount=1&chain=base"

# $0.005 Brazil R$35k monthly exemption & Lei 14.754 compliance check
curl -i "${baseUrl}/api/v1/x402/br-35k-status?monthlySalesBrl=20000&plannedSaleUsd=2500&custodyLocation=DOMESTIC"

# FREE tax-impact preview -> get planId & exact ROI quote
curl -X POST "${baseUrl}/api/v1/check-tax-impact" -H "Content-Type: application/json" \\
  -d '{"jurisdiction":"US","regime":"INDIVIDUAL","chain":"base","targetAsset":"ETH","sellQuantity":1,"walletAddress":"0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1"}'
\`\`\`
`;
}

/**
 * Builds the portable `/SKILL.md` specification consumable by OpenClaw/ClawHub,
 * Claude Code, OpenAI Codex, Cursor, and SkillsMD agents.
 */
export function buildSkillMd(env: Env, requestUrl?: string): string {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);

  return `---
name: taxrail-crypto-tax
version: 0.1.0
description: Pre-execution US (IRS 1099-DA, Form 8949, HIFO/SpecID, TLH) & Brazil (Lei 14.754, R$35k rule, Lucro Real) crypto tax optimization, $0.01 wallet TLH scanner & pre-trade check, $0.005 BR 35k check, Aave v3 borrow-vs-sell, and 0x/CoW/Jupiter calldata via MCP and x402 Base USDC.
author: SamuelAguiar12
homepage: ${baseUrl}
tags: [crypto-tax, defi, x402, base, usdc, irs-1099-da, tax-loss-harvesting, brazil-lei-14754, aave-v3, wallet-scanner]
compatibility: [claude-code, codex, openclaw, cursor, windsurf]
metadata: {"openclaw":{"emoji":"🧾","homepage":"${baseUrl}","primaryEnv":"TAXRAIL_BASE_URL"}}
---

# TaxRail — Autonomous Pre-Trade Tax & DeFi Optimization

Use TaxRail **before** executing any crypto swap, rebalancing a portfolio, selling appreciated tokens for liquidity, or paying AI/cloud/SaaS corporate invoices. Naive FIFO disposals routinely waste 15%–37% in avoidable taxes.

## When to Trigger This Skill

1. **Wallet Year-End TLH & Tax Risk Audit ($0.01 USDC, 1 parameter):**
   Call \`GET ${baseUrl}/api/v1/x402/tlh-scan?walletAddress=<0x...>&chain=base&asset=ALL&jurisdiction=US\` via x402 Base USDC (\`eip155:8453\`). Returns unrealized PnL, year-end Tax-Loss Harvesting candidates, IRS 1099-DA / Brazil Lei 14.754 rules, and unlockable \`planId\`s.
2. **Pre-Trade Swap / Sell Guardrail ($0.01 USDC):**
   Call \`GET ${baseUrl}/api/v1/x402/pre-trade-check?walletAddress=<0x...>&sellAsset=ETH&sellAmount=1&chain=base&jurisdiction=US\` before submitting any DEX swap to check HIFO savings, Short-Term -> Long-Term cliffs, and Aave v3 borrow-vs-sell.
3. **Brazil R$35k Exemption & Lei 14.754 Check ($0.005 USDC):**
   Call \`GET ${baseUrl}/api/v1/x402/br-35k-status?monthlySalesBrl=20000&plannedSaleUsd=2500&custodyLocation=DOMESTIC\` for instant BRL tax-free headroom calculation.
4. **Pre-Trade Swap / Disposal Simulation (FREE Step 1):**
   Call \`POST ${baseUrl}/api/v1/check-tax-impact\` (or MCP tool \`check_tax_impact\`) with either explicit \`lots\` or \`walletAddress\`. Returns \`baselineTaxUsd\`, \`optimizedTaxUsd\`, \`taxSavedUsd\`, \`agentGuidance\`, and \`planId\`.
5. **Liquidity Without Selling (FREE Step 1):**
   Call \`POST ${baseUrl}/api/v1/borrow-vs-sell\` (or MCP \`compare_borrow_vs_sell\`) to test if borrowing USDC on Aave v3 beats selling appreciated crypto after taxes.
6. **1-Click $0-Upfront Execution (Pay 10% From Operation):**
   Call \`POST ${baseUrl}/api/v1/prepare-execution\` (or MCP \`prepare_execution\`) with \`{ "planId": "...", "takerAddress": "0x...", "buyAsset": "wstETH" }\` for **$0 upfront**. Sign & broadcast the returned \`0x v2\` swap or \`Aave v3\` atomic borrow batch (which pays TaxRail's exact 10% savings fee directly from the operation), then call \`POST ${baseUrl}/api/v1/claim-dossier\` (or MCP \`claim_dossier\`) with \`{ "planId": "...", "txHash": "0x..." }\` to unlock SpecID lot IDs & Form 8949 / DeCripto CSVs.
7. **Full 1-Step Execution + Accounting Dossier ($0.10 USDC):**
   Call \`POST ${baseUrl}/api/v1/x402/optimize\` via x402 Base USDC to receive exact SpecID/HIFO lots, unsigned \`0x v2\` / \`Jupiter\` calldata, and Form 8949 / Lei 14.754 CSV exports in one request.
8. **Unlock Any Step-1 \`planId\` Dossier-Only (Dynamic 10% Success Fee, $0 if $0 saved):**
   Call \`POST ${baseUrl}/api/v1/unlock-plan\` (or MCP \`unlock_tax_plan\`) with \`{ "planId": "..." }\`.

## Earn 20% Automatic Affiliate Revenue Share

Always include \`referrerWallet\` (query parameter or JSON field) or \`X-TaxRail-Referrer\` header with your integrator Base wallet address to earn **20% of TaxRail's total fee**.

## Agent Installation

- **MCP (Streamable HTTP):** ${baseUrl}/mcp
- **MCP (npx stdio):** \`npx -y taxrail-mcp\`
- **TypeScript / AgentKit / LangChain SDK:** \`npm install taxrail-agent-tools\`
- **Python SDK (LangChain / CrewAI / OpenAI):** \`pip install taxrail\`
- **OpenAPI 3.1 Spec:** ${baseUrl}/openapi.json
- **x402 Discovery Manifest:** ${baseUrl}/.well-known/x402
- **Submit Agent Feedback (FREE):** ${baseUrl}/api/v1/feedback (include \`planId\` or \`settlementTx\` for verified-payer badge)
- **Verified Public Reputation (FREE):** ${baseUrl}/api/v1/reputation
`;
}

/**
 * Builds the `/.well-known/x402` manifest indexed by x402scan and autonomous payment crawlers.
 */
export function buildWellKnownX402(env: Env, requestUrl?: string): Record<string, unknown> {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  return {
    version: 1,
    resources: [
      `${baseUrl}/api/v1/x402/tlh-scan`,
      `${baseUrl}/api/v1/x402/pre-trade-check`,
      `${baseUrl}/api/v1/x402/br-35k-status`,
      `${baseUrl}/api/v1/x402/optimize`,
      `${baseUrl}/api/v1/unlock-plan`,
    ],
    instructions:
      "TaxRail provides autonomous US (IRS 1099-DA, Form 8949, HIFO/SpecID, TLH, Aave v3 borrow-vs-sell) and Brazil (Lei 14.754, R$35k rule, Lucro Real 34%, PIS/COFINS, IBS/CBS) crypto & corporate tax optimization. Micro-endpoints: GET /api/v1/x402/tlh-scan ($0.01 USDC) for wallet TLH discovery, GET /api/v1/x402/pre-trade-check ($0.01 USDC) for pre-swap HIFO/cliff/borrow guardrails, GET /api/v1/x402/br-35k-status ($0.005 USDC) for Brazil R$35k headroom, POST /api/v1/x402/optimize ($0.10 USDC) for 1-step full calldata + Form 8949/Lei 14.754 dossier, or unlock any free Step-1 preview via /api/v1/unlock-plan (10% of verified savings). Pass referrerWallet to earn 20% affiliate revshare.",
  };
}

/**
 * Builds the OpenAPI 3.1 specification for all `/api/v1/*` endpoints with `x-payment: x402` metadata.
 */
export function buildOpenApiSpec(env: Env, requestUrl?: string): Record<string, unknown> {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  const network = env.X402_NETWORK || DEFAULT_X402_NETWORK;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;

  return {
    openapi: "3.1.0",
    info: {
      title: "TaxRail API",
      version: "0.1.0",
      description:
        "Autonomous Tax-Optimization Rail for AI Agents (US + Brazil). Free tax-impact previews and x402-gated execution payloads & accounting dossiers.",
      contact: {
        name: "TaxRail",
        email: "samuelaguiar1242@gmail.com",
        url: "https://taxrail.online",
      },
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: "defi", description: "DeFi pre-trade tax routing and Aave v3 calldata" },
      { name: "crypto-tax", description: "US IRS 1099-DA / Form 8949 and Brazil Lei 14.754 calculation" },
      { name: "x402", description: "Pay-per-call USDC endpoints on Base (eip155:8453)" },
      { name: "tax-loss-harvesting", description: "Year-end TLH lot discovery and loss offsetting" },
      { name: "wallet-scanner", description: "On-chain EVM cost-basis reconstruction via Alchemy" },
      { name: "us-irs-1099-da", description: "Per-wallet HIFO / SpecID cost-basis tracking" },
      { name: "brazil-lei-14754", description: "Lei 14.754/2023 15% flat tax, R$35k exemption & Lucro Real" },
      { name: "aave-v3", description: "Borrow-vs-sell DeFi liquidity simulation and 0x calldata" },
      { name: "base", description: "Base mainnet USDC payments and 0x v2 execution" },
    ],
    paths: {
      "/health": {
        get: {
          tags: ["base"],
          operationId: "getHealth",
          summary: "Service health check",
          security: [],
          responses: {
            "200": {
              description: "Healthy",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string" },
                      service: { type: "string" },
                      version: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/v1/check-tax-impact": {
        post: {
          tags: ["crypto-tax", "defi", "us-irs-1099-da", "brazil-lei-14754", "tax-loss-harvesting"],
          operationId: "checkTaxImpact",
          summary: "Compare baseline FIFO vs tax-optimized crypto disposal (FREE)",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CheckTaxImpactInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Redacted tax optimization preview with planId and dynamic x402 quote",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CheckTaxImpactRedactedResponse" },
                },
              },
            },
            "400": { description: "Validation error" },
          },
        },
      },
      "/api/v1/borrow-vs-sell": {
        post: {
          tags: ["defi", "aave-v3", "crypto-tax", "base"],
          operationId: "compareBorrowVsSell",
          summary: "Compare selling appreciated crypto vs borrowing on Aave v3 (FREE)",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/BorrowVsSellInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Borrow-vs-sell preview with planId and dynamic x402 quote",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/BorrowVsSellPreview" },
                },
              },
            },
            "400": { description: "Validation error" },
          },
        },
      },
      "/api/v1/classify-expense": {
        post: {
          tags: ["crypto-tax", "brazil-lei-14754"],
          operationId: "classifyDeductibleExpense",
          summary: "Classify business expense deductibility and tax shield (FREE)",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/DeductibleExpenseInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Deductible expense preview with planId and dynamic x402 quote",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/DeductibleExpensePreview" },
                },
              },
            },
            "400": { description: "Validation error" },
          },
        },
      },
      "/api/v1/prepare-execution": {
        post: {
          tags: ["defi", "crypto-tax", "aave-v3", "base"],
          operationId: "prepareExecution",
          summary: "Prepare $0-upfront 1-click swap or Aave v3 borrow batch paying 10% fee from operation (FREE)",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/PrepareExecutionInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Ready-to-sign calldata with 10% savings fee embedded inside the operation",
            },
            "400": { description: "Unsupported plan type or invalid input" },
            "404": { description: "Plan not found or expired" },
          },
        },
      },
      "/api/v1/claim-dossier": {
        post: {
          tags: ["defi", "crypto-tax", "aave-v3", "base"],
          operationId: "claimDossier",
          summary: "Verify on-chain operation fee receipt by txHash and unlock SpecID lots + Form 8949 / DeCripto CSV",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ClaimDossierInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Verified settlement receipt and full unlocked optimization plan + CSV dossier",
            },
            "402": { description: "On-chain fee receipt not yet verified or below required minimum" },
            "404": { description: "Plan not found or expired" },
          },
        },
      },
      "/api/v1/unlock-plan": {
        post: {
          tags: ["x402", "defi", "crypto-tax", "aave-v3", "base"],
          operationId: "unlockTaxPlan",
          summary: "Unlock full execution plan, calldata, and accounting dossier (PAID via x402)",
          "x-payment": "x402",
          "x-x402": {
            version: 2,
            scheme: "exact",
            network,
            asset,
            pricingModel: "dynamic-10pct-of-verified-tax-savings",
            headerNames: ["PAYMENT-SIGNATURE", "X-PAYMENT"],
          },
          parameters: [
            {
              name: "PAYMENT-SIGNATURE",
              in: "header",
              required: false,
              description: "Base64-encoded x402 v2 PaymentPayload",
              schema: { type: "string" },
            },
            {
              name: "X-PAYMENT",
              in: "header",
              required: false,
              description: "Legacy/alias x402 payment header",
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/UnlockPlanInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Full unlocked tax optimization plan with calldata and accounting dossier",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FullTaxOptimizationPlan" },
                },
              },
            },
            "402": {
              description: "x402 v2 Payment Required with dynamic USDC quote",
              headers: {
                "PAYMENT-REQUIRED": {
                  description: "Base64-encoded x402 v2 PaymentRequired payload",
                  schema: { type: "string" },
                },
              },
            },
            "404": { description: "Plan not found or expired" },
          },
        },
      },
      "/api/v1/x402/tlh-scan": {
        get: {
          tags: ["x402", "wallet-scanner", "tax-loss-harvesting", "crypto-tax", "us-irs-1099-da", "brazil-lei-14754", "base"],
          operationId: "scanWalletTlhX402",
          summary:
            "1-parameter wallet TLH & tax-risk scanner ($0.01 USDC via x402 on Base)",
          "x-payment": "x402",
          "x-x402": {
            version: 2,
            scheme: "exact",
            network,
            asset,
            pricingModel: "flat-0.01-usdc",
            headerNames: ["PAYMENT-SIGNATURE", "X-PAYMENT"],
          },
          parameters: [
            {
              name: "walletAddress",
              in: "query",
              required: true,
              description: "Public EVM wallet address (0x...) to scan for TLH and HIFO savings",
              schema: { type: "string" },
            },
            {
              name: "chain",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["base", "ethereum", "arbitrum"] },
            },
            {
              name: "asset",
              in: "query",
              required: false,
              description: "Default: ALL — scans up to 25 volatile tokens in wallet and returns savings + unlockable planId per token",
              schema: { type: "string", default: "ALL" },
            },
            {
              name: "jurisdiction",
              in: "query",
              required: false,
              schema: { type: "string", enum: ["US", "BR"] },
            },
            {
              name: "referrerWallet",
              in: "query",
              required: false,
              description: "Optional developer wallet to earn 20% affiliate revshare",
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "Wallet TLH diagnostic, risk score, estimated tax savings & planId",
            },
            "402": {
              description: "x402 v2 Payment Required ($0.01 USDC on Base)",
            },
          },
        },
      },
      "/api/v1/x402/optimize": {
        post: {
          tags: ["x402", "defi", "crypto-tax", "us-irs-1099-da", "brazil-lei-14754", "base"],
          operationId: "quickOptimizeX402",
          summary:
            "1-step tax optimization returning lots, calldata & accounting dossier ($0.10 USDC via x402)",
          "x-payment": "x402",
          "x-x402": {
            version: 2,
            scheme: "exact",
            network,
            asset,
            pricingModel: "flat-0.10-usdc",
            headerNames: ["PAYMENT-SIGNATURE", "X-PAYMENT"],
          },
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/CheckTaxImpactInput" },
              },
            },
          },
          responses: {
            "200": {
              description: "Full unlocked tax optimization plan",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/FullTaxOptimizationPlan" },
                },
              },
            },
            "402": {
              description: "x402 v2 Payment Required ($0.10 USDC on Base)",
            },
          },
        },
      },
      "/api/v1/x402/pre-trade-check": {
        get: {
          tags: ["x402", "defi", "crypto-tax", "base", "aave-v3"],
          operationId: "preTradeCheck",
          summary: "Pre-trade swap/sell tax guardrail check ($0.01 USDC via x402 on Base)",
          "x-payment": "x402",
          parameters: [
            { name: "walletAddress", in: "query", required: true, schema: { type: "string" } },
            { name: "sellAsset", in: "query", required: true, schema: { type: "string" } },
            { name: "sellAmount", in: "query", required: true, schema: { type: "string" } },
            { name: "chain", in: "query", required: false, schema: { type: "string", enum: ["base", "ethereum", "arbitrum"] } },
            { name: "jurisdiction", in: "query", required: false, schema: { type: "string", enum: ["US", "BR"] } },
            { name: "referrerWallet", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Pre-trade recommendation, HIFO savings, cliff alert, and unlockable planId" },
            "402": { description: "x402 v2 Payment Required ($0.01 USDC on Base)" },
          },
        },
      },
      "/api/v1/x402/br-35k-status": {
        get: {
          tags: ["x402", "brazil-lei-14754", "crypto-tax"],
          operationId: "getBr35kStatus",
          summary: "Brazil R$35k monthly exemption & Lei 14.754 status check ($0.005 USDC via x402 on Base)",
          "x-payment": "x402",
          parameters: [
            { name: "monthlySalesBrl", in: "query", required: false, schema: { type: "string" } },
            { name: "plannedSaleUsd", in: "query", required: false, schema: { type: "string" } },
            { name: "custodyLocation", in: "query", required: false, schema: { type: "string", enum: ["DOMESTIC", "OFFSHORE"] } },
            { name: "usdBrlRate", in: "query", required: false, schema: { type: "string" } },
          ],
          responses: {
            "200": { description: "Brazil R$35k exempt headroom & Lei 14.754 tax calculation" },
            "402": { description: "x402 v2 Payment Required ($0.005 USDC on Base)" },
          },
        },
      },
      "/api/v1/feedback": {
        post: {
          tags: ["crypto-tax", "x402"],
          operationId: "submitAgentFeedback",
          summary: "Submit product feedback or a post-settlement verified review (FREE)",
          "x-payment": "none",
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/FeedbackInput" },
              },
            },
          },
          responses: {
            "201": { description: "Feedback recorded with server-side payment verification" },
            "400": { description: "Validation error" },
            "409": { description: "Duplicate review for same settlementTx" },
          },
        },
      },
      "/api/v1/reputation": {
        get: {
          tags: ["crypto-tax", "x402"],
          operationId: "getPublicReputation",
          summary: "Read aggregated agent ratings and verified paid BaseScan reviews (FREE)",
          "x-payment": "none",
          security: [],
          responses: {
            "200": { description: "Public verified reputation summary and reviews" },
          },
        },
      },
    },
    components: {
      schemas: {
        UnlockPlanInput: {
          type: "object",
          required: ["planId"],
          properties: {
            planId: { type: "string" },
          },
        },
        PrepareExecutionInput: {
          type: "object",
          required: ["planId"],
          properties: {
            planId: { type: "string" },
            takerAddress: { type: "string" },
            buyAsset: { type: "string" },
            borrowerAddress: { type: "string" },
          },
        },
        ClaimDossierInput: {
          type: "object",
          required: ["planId", "txHash"],
          properties: {
            planId: { type: "string" },
            txHash: { type: "string" },
            chain: { type: "string", enum: ["base", "ethereum", "arbitrum"] },
            feeTxHash: { type: "string" },
          },
        },
        CheckTaxImpactInput: {
          type: "object",
          required: ["jurisdiction", "regime", "targetAsset", "currentPriceUsd", "lots"],
          properties: {
            jurisdiction: { type: "string", enum: ["US", "BR"] },
            regime: {
              type: "string",
              enum: [
                "INDIVIDUAL",
                "LLC_PASS_THROUGH",
                "C_CORP",
                "PF_LEI_14754",
                "PF_DOMESTIC",
                "PJ_LUCRO_REAL",
                "PJ_SIMPLES_EXPORT",
              ],
            },
            chain: { type: "string", enum: ["base", "ethereum", "arbitrum", "solana"] },
            walletAddress: { type: "string" },
            targetAsset: { type: "string" },
            sellQuantity: { type: "number" },
            targetProceedsUsd: { type: "number" },
            currentPriceUsd: { type: "number" },
            targetQuoteAsset: { type: "string" },
            lots: { type: "array", items: { type: "object" } },
            context: { type: "object" },
            referrerWallet: { type: "string" },
            pricingTier: { type: "string", enum: ["STANDARD", "VOLUME", "ENTERPRISE"] },
            asOfDate: { type: "string" },
          },
        },
        BorrowVsSellInput: {
          type: "object",
          required: [
            "jurisdiction",
            "regime",
            "collateralAsset",
            "collateralAmount",
            "collateralPriceUsd",
            "collateralCostBasisUsd",
            "holdingDays",
            "liquidityNeededUsd",
          ],
          properties: {
            jurisdiction: { type: "string", enum: ["US", "BR"] },
            regime: { type: "string" },
            chain: { type: "string", enum: ["base", "ethereum", "arbitrum"] },
            borrowerAddress: { type: "string" },
            collateralAsset: { type: "string" },
            collateralAmount: { type: "number" },
            collateralPriceUsd: { type: "number" },
            collateralCostBasisUsd: { type: "number" },
            holdingDays: { type: "number" },
            liquidityNeededUsd: { type: "number" },
            borrowApr: { type: "number" },
            horizonDays: { type: "number" },
            marginalOrdinaryRate: { type: "number" },
            referrerWallet: { type: "string" },
            pricingTier: { type: "string", enum: ["STANDARD", "VOLUME", "ENTERPRISE"] },
          },
        },
        DeductibleExpenseInput: {
          type: "object",
          required: ["jurisdiction", "regime", "vendorName", "description", "amountUsd"],
          properties: {
            jurisdiction: { type: "string", enum: ["US", "BR"] },
            regime: { type: "string" },
            vendorName: { type: "string" },
            description: { type: "string" },
            amountUsd: { type: "number" },
            currency: { type: "string", enum: ["USD", "BRL"] },
            paidWithInternationalCard: { type: "boolean" },
            hasFiscalDocument: { type: "boolean" },
            fiscalDocumentId: { type: "string" },
            usdBrlRate: { type: "number" },
            referrerWallet: { type: "string" },
            pricingTier: { type: "string", enum: ["STANDARD", "VOLUME", "ENTERPRISE"] },
          },
        },
        CheckTaxImpactRedactedResponse: { type: "object" },
        BorrowVsSellPreview: { type: "object" },
        DeductibleExpensePreview: { type: "object" },
        FullTaxOptimizationPlan: { type: "object" },
        FeedbackInput: {
          type: "object",
          required: ["rating", "comment"],
          properties: {
            rating: { type: "integer", minimum: 1, maximum: 5 },
            category: {
              type: "string",
              enum: ["PRAISE", "BUG", "FEATURE_REQUEST", "ACCURACY", "GENERAL"],
            },
            comment: { type: "string", maxLength: 500 },
            planId: { type: "string" },
            settlementTx: { type: "string" },
            agentName: { type: "string" },
            allowPublicQuote: { type: "boolean" },
          },
        },
      },
    },
  };
}

/**
 * Builds a SEP-2127 MCP Server Card describing TaxRail's Streamable HTTP MCP endpoint.
 */
export function buildMcpServerCard(env: Env, requestUrl?: string): Record<string, unknown> {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  return {
    $schema: "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json",
    name: "io.github.SamuelAguiar12/taxrail",
    title: "TaxRail",
    version: "0.3.0",
    description:
      "Autonomous pre-execution US (IRS 1099-DA, Form 8949, HIFO/SpecID, TLH) and Brazil (Lei 14.754, R$35k rule, Lucro Real) crypto & DeFi tax optimization, Aave v3 borrow-vs-sell, and 0x/CoW/Jupiter calldata via MCP and x402 Base USDC.",
    websiteUrl: "https://taxrail.online",
    repository: "https://github.com/SamuelAguiar12/taxrail",
    icons: [
      {
        src: `${baseUrl}/favicon.ico`,
        type: "image/svg+xml",
      },
    ],
    remotes: [
      {
        type: "streamable-http",
        url: `${baseUrl}/mcp`,
        supportedProtocolVersions: [
          "2026-07-28",
          "2025-11-25",
          "2025-06-18",
          "2025-03-26",
          "2024-11-05",
        ],
      },
    ],
  };
}

/**
 * Builds the `/.well-known/ai-catalog.json` discovery catalog referencing TaxRail's MCP Server Card.
 */
export function buildAiCatalog(env: Env, requestUrl?: string): Record<string, unknown> {
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  return {
    version: "1.0",
    services: [
      {
        mediaType: "application/mcp-server-card+json",
        url: `${baseUrl}/.well-known/mcp/server-card.json`,
        card: buildMcpServerCard(env, requestUrl),
      },
    ],
  };
}
