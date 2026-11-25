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
        "FREE tax optimization preview for US & Brazil crypto disposals. Supports explicit `lots` OR automatic on-chain scanning via EVM `walletAddress` (using Alchemy). Compares naive FIFO vs tax-optimized lot selection and TLH, returning verified tax savings, dynamic x402 pricing, and a planId.",
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
        "FREE preview comparing immediate tax cost of selling appreciated crypto vs borrowing USDC on Aave v3. Returns after-tax cost comparison, projected LTV, liquidation warning, dynamic x402 quote, and a planId.",
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
        "FREE preview classifying business expenses (AI/cloud/SaaS/contractors) for US C-Corp/LLC or Brazil Lucro Real (IRPJ/CSLL, PIS/COFINS, IBS/CBS, IOF savings) and returning a compliance checklist and planId.",
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
        "Unlocks the full TaxRail execution plan (exact selectedLots, 0x/CoW/Jupiter swapIntent or Aave v3 0x calldata, and IRS Form 8949 / BR Lei 14.754 / QuickBooks / Omie-SPED accounting dossier). Unlocks immediately if fee is $0; otherwise requires x402 paymentSignature or returns exact HTTP 402 payment requirements.",
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
