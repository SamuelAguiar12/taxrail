import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import {
  BorrowVsSellInputSchema,
  CheckTaxImpactRequestSchema,
  DeductibleExpenseInputSchema,
  UnlockPlanInputSchema,
} from "@taxrail/shared";
import { z } from "zod";
import type { Env } from "./env.js";
import type { PlanStore } from "./plan-store.js";
import {
  executeBorrowVsSell,
  executeCheckTaxImpact,
  executeClassifyExpense,
} from "./service.js";
import { verifyUnlockPayment } from "./x402.js";

const UnlockTaxPlanToolSchema = UnlockPlanInputSchema.extend({
  paymentSignature: z
    .string()
    .optional()
    .describe(
      "Optional x402 v2 PAYMENT-SIGNATURE / X-PAYMENT base64 payload to settle dynamic fee"
    ),
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
 * Creates a stateless per-request McpServer instance wired with all 4 TaxRail tools.
 */
export function createTaxRailMcpServer(deps: {
  planStore: PlanStore;
  env: Env;
  requestUrl?: string;
}): McpServer {
  const server = new McpServer(
    {
      name: "taxrail",
      version: "0.1.0",
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

      return jsonToolSuccess(paymentResult.record.plan);
    }
  );

  return server;
}

/**
 * Handles a stateless Streamable HTTP MCP request (`GET`/`POST`/`DELETE /mcp`)
 * on Cloudflare Workers using WebStandardStreamableHTTPServerTransport.
 */
export async function handleMcpHttpRequest(
  request: Request,
  deps: { planStore: PlanStore; env: Env }
): Promise<Response> {
  const server = createTaxRailMcpServer({
    planStore: deps.planStore,
    env: deps.env,
    requestUrl: request.url,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  return transport.handleRequest(request);
}
