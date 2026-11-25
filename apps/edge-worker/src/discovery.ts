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
      },
      llmsTxt: `${baseUrl}/llms.txt`,
    },
    pricing: {
      model: "dynamic-success-fee",
      freePreview: true,
      feeRatePct: 0.1,
      tierRangePct: { min: 0.05, max: 0.15 },
      zeroFeeWhenZeroSavings: true,
      upfrontGuardrailUsd: 50,
      protocol: "x402",
      x402Version: 2,
      network,
      asset,
      currency: "USDC",
      summary:
        "Preview endpoints are 100% FREE. Unlocking full execution calldata and accounting dossiers costs 10% of verified tax savings (upfront x402 USDC capped at $50, remainder embedded in swap calldata bps). $0 fee if $0 saved.",
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
        id: "unlock_tax_plan",
        name: "Unlock Full Tax Optimization Plan",
        description:
          "PAID via dynamic x402 v2 (Base USDC). Unlocks exact lot IDs, 0x/CoW/Jupiter swap intent or Aave v3 0x calldata, and Form 8949 / Lei 14.754 / QuickBooks / Omie-SPED accounting dossier.",
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

## 2-Step Agent Funnel (Free Preview -> Paid Unlock via x402)

1. **Step 1 — FREE Preview (No Payment Required)**
   - Call \`POST ${baseUrl}/api/v1/check-tax-impact\`, \`POST ${baseUrl}/api/v1/borrow-vs-sell\`, or \`POST ${baseUrl}/api/v1/classify-expense\` (or MCP tools \`check_tax_impact\`, \`compare_borrow_vs_sell\`, \`classify_deductible_expense\`).
   - Receive exact \`baselineTaxUsd\`, \`optimizedTaxUsd\`, \`taxSavedUsd\`, dynamic \`pricing\` quote, and a \`planId\` (TTL: 15 minutes).
   - Sensitive execution details (exact \`lotId\`s, swap/Aave calldata, and accounting exports) are redacted until Step 2.

2. **Step 2 — Unlock Full Execution Plan (x402 v2 Dynamic Pricing)**
   - Call \`POST ${baseUrl}/api/v1/unlock-plan\` with \`{ "planId": "..." }\` (or MCP tool \`unlock_tax_plan\`).
   - If \`pricing.upfrontX402Usd == 0\` (e.g., $0 verified tax savings), the plan unlocks immediately for FREE.
   - Otherwise, the worker responds with **HTTP 402 Payment Required** and a \`PAYMENT-REQUIRED\` header for Base USDC (\`${network}\`) equal to **10% of verified tax savings** (capped by the $50 upfront x402 guardrail, with any balance embedded as swap integrator bps).
   - Retry with \`X-PAYMENT\` or \`PAYMENT-SIGNATURE\` header to receive:
     - Exact \`selectedLots\` & tax-loss harvesting opportunities
     - Unsigned \`swapIntent\` (0x v2 / CoW Swap / Jupiter) or \`aaveActions\` (Aave v3 supply + borrow \`0x\` calldata)
     - Audit-ready \`accountingDossier\` (IRS Form 8949, BR Lei 14.754, QuickBooks, or Omie/SPED)

## Example ROI

- Disposal of $50,000 ETH with mixed short-term and long-term lots:
  - Baseline FIFO tax: **$9,600**
  - TaxRail HIFO + Tax-Loss Harvesting tax: **$2,100**
  - Verified Tax Saved: **$7,500**
  - TaxRail Fee (10%): **$750 total** ($10 upfront via x402 USDC + swap integrator fee bps)
  - Client Net Benefit: **$6,750** (**10x ROI**)

## Affiliate RevShare (20%)

Pass \`referrerWallet\` (e.g., \`"0xYourAgentWallet"\`) in any Step 1 request to earn **20% of TaxRail's total fee** automatically.

## Endpoints & Specs

- MCP Streamable HTTP: \`${baseUrl}/mcp\`
- A2A Agent Card: \`${baseUrl}/.well-known/agent.json\`
- OpenAPI 3.1 Spec: \`${baseUrl}/openapi.json\`
- Health Check: \`${baseUrl}/health\`
`;
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
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/health": {
        get: {
          operationId: "getHealth",
          summary: "Service health check",
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
          operationId: "checkTaxImpact",
          summary: "Compare baseline FIFO vs tax-optimized crypto disposal (FREE)",
          "x-payment": "none",
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
          operationId: "compareBorrowVsSell",
          summary: "Compare selling appreciated crypto vs borrowing on Aave v3 (FREE)",
          "x-payment": "none",
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
          operationId: "classifyDeductibleExpense",
          summary: "Classify business expense deductibility and tax shield (FREE)",
          "x-payment": "none",
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
      "/api/v1/unlock-plan": {
        post: {
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
      },
    },
  };
}
