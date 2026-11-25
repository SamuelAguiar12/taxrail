import {
  BorrowVsSellInputSchema,
  CheckTaxImpactRequestSchema,
  DeductibleExpenseInputSchema,
  SupportedChainSchema,
  UnlockPlanInputSchema,
} from "@taxrail/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { z } from "zod";
import { buildAgentCard, buildLlmsTxt, buildOpenApiSpec } from "./discovery.js";
import { type Env, resolvePublicBaseUrl } from "./env.js";
import { handleMcpHttpRequest } from "./mcp.js";
import { fetchSpotPriceUsd, fetchWalletLotsFromAlchemy } from "./onchain.js";
import { createPlanStore } from "./plan-store.js";
import {
  executeBorrowVsSell,
  executeCheckTaxImpact,
  executeClassifyExpense,
} from "./service.js";
import { verifyUnlockPayment } from "./x402.js";

async function parseAndValidateBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema
): Promise<
  | { ok: true; data: z.infer<TSchema> }
  | { ok: false; error: string; issues?: unknown }
> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, error: "Invalid JSON request body" };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: "Request validation failed",
      issues: parsed.error.issues,
    };
  }

  return { ok: true, data: parsed.data };
}

/**
 * Builds the TaxRail Hono Edge Worker application.
 */
export function createApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();

  app.use(
    "*",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: [
        "Content-Type",
        "Accept",
        "Authorization",
        "X-PAYMENT",
        "PAYMENT-SIGNATURE",
        "MCP-Protocol-Version",
        "Mcp-Session-Id",
      ],
      exposeHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-RESPONSE",
        "Mcp-Session-Id",
      ],
    })
  );

  app.get("/", (c) => {
    const baseUrl = resolvePublicBaseUrl(c.env, c.req.url);
    return c.json({
      service: "TaxRail Edge",
      version: "0.1.0",
      status: "ok",
      description:
        "Autonomous Tax-Optimization Rail for AI Agents (US + Brazil). Free previews, dynamic x402 unlock.",
      links: {
        health: `${baseUrl}/health`,
        agentCard: `${baseUrl}/.well-known/agent.json`,
        llmsTxt: `${baseUrl}/llms.txt`,
        openapi: `${baseUrl}/openapi.json`,
        mcp: `${baseUrl}/mcp`,
      },
    });
  });

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      service: "taxrail-edge",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  // Discovery endpoints
  app.get("/.well-known/agent.json", (c) => {
    return c.json(buildAgentCard(c.env, c.req.url));
  });

  app.get("/llms.txt", (c) => {
    return c.text(buildLlmsTxt(c.env, c.req.url), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  app.get("/openapi.json", (c) => {
    return c.json(buildOpenApiSpec(c.env, c.req.url));
  });

  // Live on-chain wallet scan + spot price check (Alchemy + Coinbase fallback)
  app.get("/api/v1/wallet-scan", async (c) => {
    const address = c.req.query("address");
    const chainParam = c.req.query("chain") || "base";
    const asset = c.req.query("asset") || "ETH";

    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return c.json({ error: "Query param `address` must be a valid 0x EVM address" }, 400);
    }

    const parsedChain = SupportedChainSchema.safeParse(chainParam);
    if (!parsedChain.success) {
      return c.json({ error: `Unsupported chain "${chainParam}"` }, 400);
    }

    try {
      const spot = await fetchSpotPriceUsd(asset, c.env.ALCHEMY_API_KEY);
      if (!c.env.ALCHEMY_API_KEY) {
        return c.json({
          address,
          chain: parsedChain.data,
          asset: asset.toUpperCase(),
          currentPriceUsd: spot.priceUsd,
          priceSource: spot.source,
          discoveredLotsCount: 0,
          warnings: ["ALCHEMY_API_KEY not configured; returning live spot price only."],
        });
      }

      try {
        const scanned = await fetchWalletLotsFromAlchemy({
          walletAddress: address,
          chain: parsedChain.data,
          targetAsset: asset,
          alchemyApiKey: c.env.ALCHEMY_API_KEY,
        });
        const totalQuantity = scanned.lots.reduce((sum, l) => sum + l.quantity, 0);
        return c.json({
          address,
          chain: parsedChain.data,
          asset: asset.toUpperCase(),
          currentPriceUsd: scanned.currentPriceUsd,
          priceSource: scanned.priceSource,
          discoveredLotsCount: scanned.lots.length,
          totalQuantity: Number(totalQuantity.toFixed(8)),
          warnings: scanned.warnings,
        });
      } catch (scanErr) {
        return c.json({
          address,
          chain: parsedChain.data,
          asset: asset.toUpperCase(),
          currentPriceUsd: spot.priceUsd,
          priceSource: spot.source,
          discoveredLotsCount: 0,
          totalQuantity: 0,
          warnings: [
            scanErr instanceof Error ? scanErr.message : "No incoming transfers found.",
          ],
        });
      }
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Wallet scan failed" },
        400
      );
    }
  });

  // Free Step 1 preview endpoints
  app.post("/api/v1/check-tax-impact", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, CheckTaxImpactRequestSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    try {
      const planStore = createPlanStore(c.env);
      const response = await executeCheckTaxImpact(parsed.data, {
        planStore,
        env: c.env,
      });
      return c.json(response, 200);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to compute tax impact" },
        400
      );
    }
  });

  app.post("/api/v1/borrow-vs-sell", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, BorrowVsSellInputSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    try {
      const planStore = createPlanStore(c.env);
      const response = await executeBorrowVsSell(parsed.data, {
        planStore,
        env: c.env,
      });
      return c.json(response, 200);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to compare borrow vs sell" },
        400
      );
    }
  });

  app.post("/api/v1/classify-expense", async (c) => {
    const parsed = await parseAndValidateBody(
      c.req.raw,
      DeductibleExpenseInputSchema
    );
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    try {
      const planStore = createPlanStore(c.env);
      const response = await executeClassifyExpense(parsed.data, {
        planStore,
        env: c.env,
      });
      return c.json(response, 200);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to classify expense" },
        400
      );
    }
  });

  // Dynamic x402-gated Step 2 unlock endpoint
  app.post("/api/v1/unlock-plan", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, UnlockPlanInputSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    const planStore = createPlanStore(c.env);
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    const result = await verifyUnlockPayment({
      planId: parsed.data.planId,
      paymentHeader,
      planStore,
      env: c.env,
      requestUrl: c.req.url,
    });

    if (result.status === "not_found") {
      return c.json(
        { error: "Plan not found or expired", planId: result.planId },
        404
      );
    }

    if (result.status !== "paid") {
      c.header("PAYMENT-REQUIRED", result.paymentRequiredHeader);
      c.header("Cache-Control", "no-store");
      const body =
        result.status === "payment_required"
          ? result.paymentRequired
          : {
              ...result.paymentRequired,
              error: result.reason,
            };
      return c.json(body, 402);
    }

    if (result.paymentResponseHeader) {
      c.header("PAYMENT-RESPONSE", result.paymentResponseHeader);
    }

    return c.json(result.record.plan, 200);
  });

  // Stateless Streamable HTTP MCP server
  app.on(["GET", "POST", "DELETE"], "/mcp", async (c) => {
    const planStore = createPlanStore(c.env);
    return handleMcpHttpRequest(c.req.raw, {
      planStore,
      env: c.env,
    });
  });

  return app;
}

export const app = createApp();
export default app;
