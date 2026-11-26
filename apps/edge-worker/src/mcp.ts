import {
  createMcpHandler,
  isLegacyRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import {
  BorrowVsSellInputSchema,
  CheckTaxImpactRequestSchema,
  ClaimDossierInputSchema,
  DeductibleExpenseInputSchema,
  PrepareExecutionInputSchema,
  UnlockPlanInputSchema,
} from "@taxrail/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import { recordPaidReceipt } from "./feedback.js";
import type { PlanStore } from "./plan-store.js";
import {
  executeBorrowVsSell,
  executeBr35kStatus,
  executeCheckTaxImpact,
  executeClaimDossier,
  executeClassifyExpense,
  executePrepareExecution,
  executePreTradeCheck,
  executeWalletTlhScan,
} from "./service.js";
import {
  verifyBr35kStatusPayment,
  verifyPreTradeCheckPayment,
  verifyTlhScanPayment,
  verifyUnlockPayment,
} from "./x402.js";

const UnlockTaxPlanToolSchema = UnlockPlanInputSchema.extend({
  paymentSignature: z
    .string()
    .optional()
    .describe(
      "Optional x402 v2 PAYMENT-SIGNATURE / X-PAYMENT base64 payload to settle dynamic fee"
    ),
});

const ScanWalletTlhToolSchema = z.object({
  walletAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/)
    .describe("EVM wallet address (0x...) to scan for year-end TLH and HIFO tax savings"),
  chain: z.enum(["base", "ethereum", "arbitrum"]).optional(),
  asset: z.string().optional().describe("Token symbol or ALL (default ALL, scans up to 25 tokens)"),
  jurisdiction: z.enum(["US", "BR"]).optional(),
  referrerWallet: z.string().optional(),
  paymentSignature: z
    .string()
    .optional()
    .describe("x402 v2 PAYMENT-SIGNATURE payload ($0.01 USDC on Base)"),
});

const PreTradeCheckToolSchema = z.object({
  walletAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  sellAsset: z.string().min(1).describe("Token symbol to sell or swap (e.g. ETH, AERO, WBTC)"),
  sellAmount: z.number().positive(),
  chain: z.enum(["base", "ethereum", "arbitrum"]).optional(),
  jurisdiction: z.enum(["US", "BR"]).optional(),
  referrerWallet: z.string().optional(),
  paymentSignature: z
    .string()
    .optional()
    .describe("x402 v2 PAYMENT-SIGNATURE payload ($0.01 USDC on Base)"),
});

const CheckBr35kStatusToolSchema = z.object({
  monthlySalesBrl: z.number().nonnegative().default(0),
  plannedSaleUsd: z.number().nonnegative().default(1000),
  custodyLocation: z.enum(["DOMESTIC", "OFFSHORE"]).default("DOMESTIC"),
  usdBrlRate: z.number().positive().optional(),
  paymentSignature: z
    .string()
    .optional()
    .describe("x402 v2 PAYMENT-SIGNATURE payload ($0.005 USDC on Base)"),
});

function jsonToolSuccess(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function jsonToolError(payload: unknown) {
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

/**
 * Creates a stateless per-request McpServer instance wired with all 9 TaxRail tools.
 */
export function createTaxRailMcpServer(deps: {
  planStore: PlanStore;
  env: Env;
  requestUrl?: string;
}): McpServer {
  const server = new McpServer(
    {
      name: "taxrail",
      version: "0.3.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.registerTool(
    "check_tax_impact",
    {
      title: "Check Crypto Disposal Tax Impact (FREE)",
      description:
        "CALL BEFORE ANY CRYPTO SWAP OR SALE (FREE). Prevents 15%-37% avoidable capital gains drag across US (IRS 1099-DA, Form 8949, HIFO/SpecID, TLH) & Brazil (Lei 14.754, R$35k rule, Lucro Real). Accepts explicit `lots` OR automatic EVM `walletAddress` scan. Returns verified taxSavedUsd, 10x ROI unlock quote, and planId. Pass `referrerWallet` to earn 20% of TaxRail's fee.",
      inputSchema: CheckTaxImpactRequestSchema,
    },
    async (args) => {
      try {
        const result = await executeCheckTaxImpact(args, deps);
        return jsonToolSuccess(result);
      } catch (err) {
        return jsonToolError({
          error: err instanceof Error ? err.message : "Failed to analyze crypto disposal",
        });
      }
    }
  );

  server.registerTool(
    "compare_borrow_vs_sell",
    {
      title: "Compare DeFi Borrow vs Sell (FREE)",
      description:
        "CALL BEFORE SELLING APPRECIATED CRYPTO FOR LIQUIDITY (FREE). Compares capital gains tax from selling vs borrowing USDC on Aave v3 (Base/Ethereum/Arbitrum), including LTV liquidation safety, net APR, corporate tax shield, and planId for instant Aave 0x calldata. Supports 20% `referrerWallet` revshare.",
      inputSchema: BorrowVsSellInputSchema,
    },
    async (args) => {
      try {
        const result = await executeBorrowVsSell(args, deps);
        return jsonToolSuccess(result);
      } catch (err) {
        return jsonToolError({
          error: err instanceof Error ? err.message : "Failed to evaluate borrow vs sell",
        });
      }
    }
  );

  server.registerTool(
    "classify_deductible_expense",
    {
      title: "Classify Deductible Business Expense (FREE)",
      description:
        "CALL BEFORE PAYING AI, CLOUD, SAAS OR CONTRACTOR INVOICES (FREE). Quantifies tax deductions for US LLC/C-Corp & Brazil Lucro Real (34% IRPJ/CSLL, PIS/COFINS, IBS/CBS credits, IOF savings) and returns QuickBooks or Omie/SPED compliance checklist + planId.",
      inputSchema: DeductibleExpenseInputSchema,
    },
    async (args) => {
      try {
        const result = await executeClassifyExpense(args, deps);
        return jsonToolSuccess(result);
      } catch (err) {
        return jsonToolError({
          error: err instanceof Error ? err.message : "Failed to classify deductible expense",
        });
      }
    }
  );

  server.registerTool(
    "unlock_tax_plan",
    {
      title: "Unlock Full Tax Optimization Plan (x402)",
      description:
        "Unlocks exact SpecID/HIFO selectedLots, unsigned 0x/CoW/Jupiter swapIntent or Aave v3 0x calldata, and IRS Form 8949 / BR Lei 14.754 / QuickBooks / Omie-SPED accounting dossier. Unlocks for FREE if taxSavedUsd == 0; otherwise settles 10% of verified tax savings via x402 Base USDC (up to 10x net ROI).",
      inputSchema: UnlockTaxPlanToolSchema,
    },
    async (args) => {
      const paymentResult = await verifyUnlockPayment({
        planId: args.planId,
        paymentHeader: args.paymentSignature,
        planStore: deps.planStore,
        env: deps.env,
        requestUrl: deps.requestUrl,
      });

      if (paymentResult.status === "not_found") {
        return jsonToolError({
          status: 404,
          error: "Plan not found or expired",
          planId: args.planId,
        });
      }

      if (paymentResult.status !== "paid") {
        return jsonToolError({
          status: 402,
          error:
            paymentResult.status === "payment_required"
              ? "Payment Required (x402)"
              : paymentResult.reason,
          planId: args.planId,
          paymentRequired: paymentResult.paymentRequired,
          paymentRequiredHeader: paymentResult.paymentRequiredHeader,
        });
      }

      if (paymentResult.record.pricing.upfrontX402Usd > 0) {
        await recordPaidReceipt(deps.env, {
          settlementTx: paymentResult.settlementTx,
          tier: "10PCT_UNLOCK",
          amountUsd: paymentResult.record.pricing.upfrontX402Usd,
          taxSavedUsd: paymentResult.record.pricing.taxSavedUsd,
          planId: paymentResult.record.plan.planId,
        });
      }

      return jsonToolSuccess(paymentResult.record.plan);
    }
  );

  server.registerTool(
    "scan_wallet_tlh",
    {
      title: "Scan Wallet for Year-End TLH & Tax Savings ($0.01 x402)",
      description:
        "Scans up to 25 volatile tokens in an EVM wallet (Base/Ethereum/Arbitrum) for year-end Tax-Loss Harvesting candidates and HIFO/SpecID tax savings. Requires $0.01 USDC x402 `paymentSignature` on Base.",
      inputSchema: ScanWalletTlhToolSchema,
    },
    async (args) => {
      const paymentResult = await verifyTlhScanPayment({
        paymentHeader: args.paymentSignature,
        env: deps.env,
        requestUrl: deps.requestUrl,
      });

      if (paymentResult.status !== "paid") {
        return jsonToolError({
          status: 402,
          error:
            paymentResult.status === "payment_required"
              ? "Payment Required ($0.01 USDC via x402)"
              : paymentResult.reason,
          paymentRequired: paymentResult.paymentRequired,
          paymentRequiredHeader: paymentResult.paymentRequiredHeader,
        });
      }

      const scan = await executeWalletTlhScan(
        {
          walletAddress: args.walletAddress,
          chain: args.chain ?? "base",
          asset: args.asset ?? "ALL",
          jurisdiction: args.jurisdiction ?? "US",
          ...(args.referrerWallet ? { referrerWallet: args.referrerWallet } : {}),
        },
        deps
      );

      await recordPaidReceipt(deps.env, {
        settlementTx: paymentResult.settlementTx,
        tier: "TLH_SCAN",
        amountUsd: 0.01,
        taxSavedUsd: scan.estimatedTaxSavingsUsd,
        planId: scan.planId,
      });

      return jsonToolSuccess(scan);
    }
  );

  server.registerTool(
    "pre_trade_check",
    {
      title: "Pre-Trade Swap/Sell Tax Guardrail ($0.01 x402)",
      description:
        "Run right before executing a DEX swap or sell: checks HIFO vs FIFO savings, 366-day US ST->LT tax cliffs, and Aave v3 borrow-vs-sell comparison. Requires $0.01 USDC x402 `paymentSignature` on Base.",
      inputSchema: PreTradeCheckToolSchema,
    },
    async (args) => {
      const paymentResult = await verifyPreTradeCheckPayment({
        paymentHeader: args.paymentSignature,
        env: deps.env,
        requestUrl: deps.requestUrl,
      });

      if (paymentResult.status !== "paid") {
        return jsonToolError({
          status: 402,
          error:
            paymentResult.status === "payment_required"
              ? "Payment Required ($0.01 USDC via x402)"
              : paymentResult.reason,
          paymentRequired: paymentResult.paymentRequired,
          paymentRequiredHeader: paymentResult.paymentRequiredHeader,
        });
      }

      const check = await executePreTradeCheck(
        {
          walletAddress: args.walletAddress,
          sellAsset: args.sellAsset,
          sellAmount: args.sellAmount,
          chain: args.chain ?? "base",
          jurisdiction: args.jurisdiction ?? "US",
          ...(args.referrerWallet ? { referrerWallet: args.referrerWallet } : {}),
        },
        deps
      );

      await recordPaidReceipt(deps.env, {
        settlementTx: paymentResult.settlementTx,
        tier: "PRE_TRADE_CHECK",
        amountUsd: 0.01,
        taxSavedUsd: check.taxSavedUsd,
        planId: check.planId,
      });

      return jsonToolSuccess(check);
    }
  );

  server.registerTool(
    "check_br_35k_status",
    {
      title: "Brazil R$35k Exemption & Lei 14.754 Check ($0.005 x402)",
      description:
        "Calculates remaining R$35,000 monthly domestic crypto exemption vs Lei 14.754 15% flat offshore/DEX tax and max safe USD sale size for Brazil taxpayers. Requires $0.005 USDC x402 `paymentSignature` on Base.",
      inputSchema: CheckBr35kStatusToolSchema,
    },
    async (args) => {
      const paymentResult = await verifyBr35kStatusPayment({
        paymentHeader: args.paymentSignature,
        env: deps.env,
        requestUrl: deps.requestUrl,
      });

      if (paymentResult.status !== "paid") {
        return jsonToolError({
          status: 402,
          error:
            paymentResult.status === "payment_required"
              ? "Payment Required ($0.005 USDC via x402)"
              : paymentResult.reason,
          paymentRequired: paymentResult.paymentRequired,
          paymentRequiredHeader: paymentResult.paymentRequiredHeader,
        });
      }

      const status = executeBr35kStatus({
        monthlySalesBrl: args.monthlySalesBrl,
        plannedSaleUsd: args.plannedSaleUsd,
        custodyLocation: args.custodyLocation,
        ...(args.usdBrlRate !== undefined ? { usdBrlRate: args.usdBrlRate } : {}),
      });

      await recordPaidReceipt(deps.env, {
        settlementTx: paymentResult.settlementTx,
        tier: "BR_35K_STATUS",
        amountUsd: 0.005,
      });

      return jsonToolSuccess(status);
    }
  );

  server.registerTool(
    "prepare_execution",
    {
      title: "Prepare $0-Upfront 1-Click Execution (Pay 10% From Operation)",
      description:
        "FREE step before signing: builds ready-to-sign 0x v2 / Jupiter swap calldata or Aave v3 atomic borrow batch with TaxRail's exact 10% verified-savings fee embedded inside the operation ($0 upfront cost). After broadcasting the tx, call `claim_dossier` with the txHash to unlock SpecID lots & IRS Form 8949 / DeCripto CSV.",
      inputSchema: PrepareExecutionInputSchema,
    },
    async (args) => {
      const result = await executePrepareExecution(args, deps);
      if (!result.ok) {
        return jsonToolError({ status: result.status, error: result.error, planId: args.planId });
      }
      return jsonToolSuccess(result.data);
    }
  );

  const ClaimDossierToolSchema = ClaimDossierInputSchema.extend({
    paymentSignature: z
      .string()
      .optional()
      .describe("Optional dev-bypass token for automated testing"),
  });

  server.registerTool(
    "claim_dossier",
    {
      title: "Claim Tax Dossier After On-Chain Execution",
      description:
        "Verifies the settled swap or Aave borrow txHash on-chain (confirming TaxRail's 10% fee transfer from the operation) and immediately returns SpecID selectedLots + Form 8949 / Brazil DeCripto accounting dossier.",
      inputSchema: ClaimDossierToolSchema,
    },
    async (args) => {
      const devBypass = Boolean(
        deps.env.X402_DEV_BYPASS_TOKEN &&
          args.paymentSignature?.trim() === `dev-bypass:${deps.env.X402_DEV_BYPASS_TOKEN}`
      );
      const result = await executeClaimDossier(args, deps, { devBypass });
      if (!result.ok) {
        return jsonToolError({
          status: result.status,
          error: result.error,
          planId: args.planId,
          ...(result.explorerUrl ? { explorerUrl: result.explorerUrl } : {}),
        });
      }
      return jsonToolSuccess(result.data);
    }
  );

  return server;
}

/**
 * Handles stateless Streamable HTTP MCP requests (`GET`/`POST`/`DELETE /mcp`)
 * across both MCP 2026-07-28 (`server/discover` per-request envelope) and 2025-era (`initialize`)
 * on Cloudflare Workers.
 */
export async function handleMcpHttpRequest(
  request: Request,
  deps: { planStore: PlanStore; env: Env }
): Promise<Response> {
  const factory = () =>
    createTaxRailMcpServer({
      planStore: deps.planStore,
      env: deps.env,
      requestUrl: request.url,
    });

  if (await isLegacyRequest(request)) {
    const server = factory();
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    await server.connect(transport);
    return transport.handleRequest(request);
  }

  const modernHandler = createMcpHandler(factory, {
    legacy: "reject",
    responseMode: "json",
  });
  return modernHandler.fetch(request);
}
