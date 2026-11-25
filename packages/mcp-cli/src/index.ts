#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type AaveSupportedChain,
  buildAaveBorrowPayload,
  buildBorrowAccountingDossier,
  buildCryptoAccountingDossier,
  buildExpenseAccountingDossier,
  buildSwapIntent,
} from "@taxrail/execution";
import {
  type AaveActionPayload,
  type BorrowVsSellInput,
  BorrowVsSellInputSchema,
  type CheckTaxImpactInput,
  CheckTaxImpactInputSchema,
  type DeductibleExpenseInput,
  DeductibleExpenseInputSchema,
  type DynamicPricingQuote,
  type FullTaxOptimizationPlan,
  type SwapIntentPayload,
  UnlockPlanInputSchema,
} from "@taxrail/shared";
import {
  analyzeBorrowVsSell,
  analyzeCryptoDisposal,
  analyzeDeductibleExpense,
} from "@taxrail/tax-engine";
import { z } from "zod";

const PLAN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_PAY_TO = "0x0202e70990d90325A1Dca322C91471Be774E4B6f";
const DEFAULT_X402_NETWORK = "eip155:8453";
const DEFAULT_X402_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface LocalStoredPlan {
  plan: FullTaxOptimizationPlan;
  pricing: DynamicPricingQuote;
  expiresAtMs: number;
}

const localPlanStore = new Map<string, LocalStoredPlan>();

const UnlockTaxPlanToolSchema = UnlockPlanInputSchema.extend({
  paymentSignature: z
    .string()
    .optional()
    .describe(
      "Optional x402 v2 PAYMENT-SIGNATURE / X-PAYMENT payload for unlocking a paid plan"
    ),
});

function getRemoteBaseUrl(): string | undefined {
  const url = process.env.TAXRAIL_REMOTE_URL?.trim();
  return url ? url.replace(/\/$/, "") : undefined;
}

function getTreasuryWallet(): string {
  return process.env.TAXRAIL_PAY_TO_ADDRESS?.trim() || DEFAULT_PAY_TO;
}

function textSuccess(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function textError(payload: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

async function postRemoteJson(
  remoteBaseUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; data: unknown }> {
  const res = await fetch(`${remoteBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    data = { error: await res.text() };
  }
  return { status: res.status, headers: res.headers, data };
}

function buildLocalPaymentRequired(planId: string, pricing: DynamicPricingQuote) {
  const amountAtomic = String(Math.max(0, Math.round(pricing.upfrontX402Usd * 1_000_000)));
  return {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: "https://api.taxrail.online/api/v1/unlock-plan",
      description: `Unlock TaxRail optimization plan ${planId} (saves $${pricing.taxSavedUsd.toFixed(2)})`,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network: process.env.TAXRAIL_X402_NETWORK || DEFAULT_X402_NETWORK,
        asset: process.env.TAXRAIL_X402_ASSET || DEFAULT_X402_ASSET,
        amount: amountAtomic,
        payTo: getTreasuryWallet(),
        maxTimeoutSeconds: 300,
        extra: {
          name: "USD Coin",
          version: "2",
          planId,
          taxSavedUsd: pricing.taxSavedUsd,
          feeRatePct: pricing.feeRatePct,
        },
      },
    ],
  };
}

function runLocalCheckTaxImpact(input: CheckTaxImpactInput) {
  const analysis = analyzeCryptoDisposal(input);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();

  const totalSellQty = analysis.selectedLots.reduce(
    (sum, lot) => sum + lot.quantityToSell,
    0
  );

  let swapIntent: SwapIntentPayload | undefined;
  if (totalSellQty > 0) {
    swapIntent = buildSwapIntent({
      chain: input.chain ?? "base",
      sellAsset: input.targetAsset,
      buyAsset: input.targetQuoteAsset ?? "USDC",
      sellAmountDecimal: totalSellQty.toString(),
      pricing: analysis.pricing,
      treasuryWallet: getTreasuryWallet(),
      takerAddress: input.walletAddress,
    });
  }

  const accountingDossier = buildCryptoAccountingDossier({
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    selectedLots: analysis.selectedLots,
    tlhOpportunities: analysis.tlhOpportunities,
    taxSavedUsd: analysis.taxSavedUsd,
  });

  const plan: FullTaxOptimizationPlan = {
    planId: analysis.redacted.planId,
    planType: "CRYPTO_DISPOSAL",
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    createdAt,
    expiresAt,
    baselineTaxUsd: analysis.baselineTaxUsd,
    optimizedTaxUsd: analysis.optimizedTaxUsd,
    taxSavedUsd: analysis.taxSavedUsd,
    pricing: analysis.pricing,
    selectedLots: analysis.selectedLots,
    tlhOpportunities: analysis.tlhOpportunities,
    ...(swapIntent ? { swapIntent } : {}),
    accountingDossier,
    executionNotes: [
      `Baseline: ${analysis.redacted.baselineStrategy}`,
      `Optimized: ${analysis.redacted.recommendedStrategy}`,
      ...analysis.warnings,
    ],
    disclaimer: analysis.redacted.disclaimer,
  };

  localPlanStore.set(analysis.redacted.planId, {
    plan,
    pricing: analysis.pricing,
    expiresAtMs: now + PLAN_TTL_MS,
  });

  return analysis.redacted;
}

function runLocalBorrowVsSell(input: BorrowVsSellInput) {
  const { preview, pricing } = analyzeBorrowVsSell(input);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();
  const chain: AaveSupportedChain = input.chain ?? "base";

  let aaveActions: AaveActionPayload | undefined;
  const executionNotes: string[] = [];
  try {
    aaveActions = buildAaveBorrowPayload({
      chain,
      borrowerAddress: input.borrowerAddress,
      collateralAsset: input.collateralAsset,
      collateralAmount: input.collateralAmount,
      borrowAmountUsd: input.liquidityNeededUsd,
    });
  } catch (err) {
    executionNotes.push(
      err instanceof Error ? err.message : "Aave calldata unavailable"
    );
  }
  if (preview.liquidationWarning) {
    executionNotes.push(preview.liquidationWarning);
  }

  const accountingDossier = buildBorrowAccountingDossier({
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    preview,
  });

  const plan: FullTaxOptimizationPlan = {
    planId: preview.planId,
    planType: "BORROW_VS_SELL",
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    createdAt,
    expiresAt,
    baselineTaxUsd: preview.sellTaxCostUsd,
    optimizedTaxUsd: preview.netBorrowCostUsd,
    taxSavedUsd: preview.taxSavedUsd,
    pricing,
    ...(aaveActions ? { aaveActions } : {}),
    accountingDossier,
    executionNotes,
    disclaimer: preview.disclaimer,
  };

  localPlanStore.set(preview.planId, {
    plan,
    pricing,
    expiresAtMs: now + PLAN_TTL_MS,
  });

  return preview;
}

function runLocalClassifyExpense(input: DeductibleExpenseInput) {
  const { preview, pricing } = analyzeDeductibleExpense(input);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + PLAN_TTL_MS).toISOString();

  const accountingDossier = buildExpenseAccountingDossier({ input, preview });

  const plan: FullTaxOptimizationPlan = {
    planId: preview.planId,
    planType: "DEDUCTIBLE_EXPENSE",
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    createdAt,
    expiresAt,
    baselineTaxUsd: preview.taxSavedUsd,
    optimizedTaxUsd: 0,
    taxSavedUsd: preview.taxSavedUsd,
    pricing,
    accountingDossier,
    executionNotes: [...preview.complianceChecklist],
    disclaimer: preview.disclaimer,
  };

  localPlanStore.set(preview.planId, {
    plan,
    pricing,
    expiresAtMs: now + PLAN_TTL_MS,
  });

  return preview;
}

/**
 * Builds and returns the TaxRail stdio MCP server instance.
 */
export function createStdioMcpServer(): McpServer {
  const server = new McpServer({
    name: "taxrail-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "check_tax_impact",
    {
      title: "Check Crypto Disposal Tax Impact (FREE)",
      description:
        "FREE tax optimization preview for US & Brazil crypto disposals. Returns baseline vs optimized tax, verified savings, dynamic x402 pricing, and planId.",
      inputSchema: CheckTaxImpactInputSchema,
    },
    async (args) => {
      try {
        const remote = getRemoteBaseUrl();
        if (remote) {
          const res = await postRemoteJson(remote, "/api/v1/check-tax-impact", args);
          return res.status >= 400 ? textError(res.data) : textSuccess(res.data);
        }
        return textSuccess(runLocalCheckTaxImpact(args));
      } catch (err) {
        return textError({
          error: err instanceof Error ? err.message : "Failed to check tax impact",
        });
      }
    }
  );

  server.registerTool(
    "compare_borrow_vs_sell",
    {
      title: "Compare DeFi Borrow vs Sell (FREE)",
      description:
        "FREE preview comparing selling appreciated crypto vs borrowing USDC on Aave v3. Returns after-tax cost comparison, LTV, and planId.",
      inputSchema: BorrowVsSellInputSchema,
    },
    async (args) => {
      try {
        const remote = getRemoteBaseUrl();
        if (remote) {
          const res = await postRemoteJson(remote, "/api/v1/borrow-vs-sell", args);
          return res.status >= 400 ? textError(res.data) : textSuccess(res.data);
        }
        return textSuccess(runLocalBorrowVsSell(args));
      } catch (err) {
        return textError({
          error: err instanceof Error ? err.message : "Failed to compare borrow vs sell",
        });
      }
    }
  );

  server.registerTool(
    "classify_deductible_expense",
    {
      title: "Classify Deductible Business Expense (FREE)",
      description:
        "FREE preview classifying business expenses (AI/cloud/SaaS/contractors) for US C-Corp/LLC or Brazil Lucro Real.",
      inputSchema: DeductibleExpenseInputSchema,
    },
    async (args) => {
      try {
        const remote = getRemoteBaseUrl();
        if (remote) {
          const res = await postRemoteJson(remote, "/api/v1/classify-expense", args);
          return res.status >= 400 ? textError(res.data) : textSuccess(res.data);
        }
        return textSuccess(runLocalClassifyExpense(args));
      } catch (err) {
        return textError({
          error: err instanceof Error ? err.message : "Failed to classify expense",
        });
      }
    }
  );

  server.registerTool(
    "unlock_tax_plan",
    {
      title: "Unlock Full Tax Optimization Plan (x402)",
      description:
        "Unlocks full execution calldata and accounting dossier for a planId. Uses TAXRAIL_REMOTE_URL with X-PAYMENT / TAXRAIL_DEV_BYPASS if configured, or returns x402 payment instructions.",
      inputSchema: UnlockTaxPlanToolSchema,
    },
    async (args) => {
      const paymentHeader =
        args.paymentSignature?.trim() ||
        (process.env.TAXRAIL_DEV_BYPASS
          ? `dev-bypass:${process.env.TAXRAIL_DEV_BYPASS}`
          : undefined);

      const remote = getRemoteBaseUrl();
      if (remote) {
        try {
          const res = await postRemoteJson(
            remote,
            "/api/v1/unlock-plan",
            { planId: args.planId },
            paymentHeader ? { "X-PAYMENT": paymentHeader } : {}
          );
          if (res.status === 402) {
            return textError({
              status: 402,
              error: "Payment Required (x402)",
              planId: args.planId,
              paymentRequired: res.data,
              paymentRequiredHeader: res.headers.get("PAYMENT-REQUIRED"),
            });
          }
          if (res.status >= 400) {
            return textError({ status: res.status, ...(res.data as object) });
          }
          return textSuccess(res.data);
        } catch (err) {
          return textError({
            error: err instanceof Error ? err.message : "Remote unlock request failed",
          });
        }
      }

      const stored = localPlanStore.get(args.planId);
      if (!stored || Date.now() > stored.expiresAtMs) {
        localPlanStore.delete(args.planId);
        return textError({
          status: 404,
          error: "Plan not found or expired in local stdio session",
          planId: args.planId,
        });
      }

      if (stored.pricing.upfrontX402Usd <= 0) {
        return textSuccess(stored.plan);
      }

      if (
        process.env.TAXRAIL_DEV_BYPASS &&
        paymentHeader === `dev-bypass:${process.env.TAXRAIL_DEV_BYPASS}`
      ) {
        return textSuccess(stored.plan);
      }

      const paymentRequired = buildLocalPaymentRequired(args.planId, stored.pricing);
      return textError({
        status: 402,
        error: "Payment Required (x402). Set TAXRAIL_REMOTE_URL + paymentSignature to settle on-chain via Base USDC.",
        planId: args.planId,
        paymentRequired,
      });
    }
  );

  return server;
}

async function main() {
  const server = createStdioMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("TaxRail MCP stdio server fatal error:", err);
  process.exit(1);
});
