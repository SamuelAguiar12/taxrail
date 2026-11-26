import {
  BorrowVsSellInputSchema,
  CheckTaxImpactRequestSchema,
  ClaimDossierInputSchema,
  DeductibleExpenseInputSchema,
  PrepareExecutionInputSchema,
  SupportedChainSchema,
  UnlockPlanInputSchema,
} from "@taxrail/shared";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { z } from "zod";
import { createCdpFacilitatorAuthHeaders } from "./cdp-auth.js";
import {
  buildAgentCard,
  buildAiCatalog,
  buildLlmsTxt,
  buildMcpServerCard,
  buildOpenApiSpec,
  buildSkillMd,
  buildWellKnownX402,
} from "./discovery.js";
import { COINBASE_CDP_FACILITATOR_URL, type Env, resolvePublicBaseUrl } from "./env.js";
import {
  FeedbackInputSchema,
  getPublicReputation,
  recordPaidReceipt,
  submitFeedback,
} from "./feedback.js";
import { handleMcpHttpRequest } from "./mcp.js";
import { fetchSpotPriceUsd, fetchWalletLotsFromAlchemy } from "./onchain.js";
import { createPlanStore } from "./plan-store.js";
import {
  executeBorrowVsSell,
  executeBr35kStatus,
  executeCheckTaxImpact,
  executeClaimDossier,
  executeClassifyExpense,
  executePrepareExecution,
  executePreTradeCheck,
  executeQuickOptimize,
  executeWalletTlhScan,
} from "./service.js";
import {
  buildQuickOptimizeProbePaymentRequired,
  buildUnlockProbePaymentRequired,
  verifyBr35kStatusPayment,
  verifyPreTradeCheckPayment,
  verifyQuickOptimizePayment,
  verifyTlhScanPayment,
  verifyUnlockPayment,
} from "./x402.js";

const EXAMPLE_CHECK_TAX_IMPACT_PAYLOAD = {
  jurisdiction: "US",
  regime: "INDIVIDUAL",
  chain: "base",
  targetAsset: "ETH",
  sellQuantity: 1,
  walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
};

const EXAMPLE_BORROW_VS_SELL_PAYLOAD = {
  jurisdiction: "US",
  regime: "INDIVIDUAL",
  chain: "base",
  collateralAsset: "ETH",
  collateralAmount: 2,
  collateralPriceUsd: 3000,
  collateralCostBasisUsd: 800,
  holdingDays: 365,
  liquidityNeededUsd: 2500,
};

const EXAMPLE_CLASSIFY_EXPENSE_PAYLOAD = {
  jurisdiction: "US",
  regime: "C_CORP",
  vendorName: "OpenAI",
  description: "API compute usage",
  amountUsd: 500,
};

function normalizeCheckTaxImpactPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rawJur =
    typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim().toUpperCase() : "US";
  obj.jurisdiction = rawJur === "BR" ? "BR" : "US";

  if (typeof obj.regime !== "string" || !obj.regime.trim()) {
    obj.regime = obj.jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL";
  }

  if (!obj.walletAddress) {
    if (typeof obj.address === "string") obj.walletAddress = obj.address;
    else if (typeof obj.wallet === "string") obj.walletAddress = obj.wallet;
  }

  if (typeof obj.walletAddress === "string") {
    obj.walletAddress = obj.walletAddress.trim();
  }

  if (!obj.targetAsset) {
    const aliasAsset = obj.asset ?? obj.token ?? obj.sellAsset;
    if (typeof aliasAsset === "string" && aliasAsset.trim()) {
      obj.targetAsset = aliasAsset.trim().toUpperCase();
    } else if (typeof obj.walletAddress === "string" && /^0x[a-fA-F0-9]{40}$/.test(obj.walletAddress)) {
      obj.targetAsset = "ETH";
    }
  }

  if (obj.sellQuantity === undefined) {
    const aliasQty = obj.sellAmount ?? obj.amount ?? obj.quantity;
    if (typeof aliasQty === "number") {
      obj.sellQuantity = aliasQty;
    } else if (typeof aliasQty === "string" && aliasQty.trim() && Number.isFinite(Number(aliasQty))) {
      obj.sellQuantity = Number(aliasQty);
    } else if (
      obj.targetProceedsUsd === undefined &&
      typeof obj.walletAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(obj.walletAddress)
    ) {
      obj.sellQuantity = 1;
    }
  }

  if (typeof obj.currentPriceUsd === "string" && Number.isFinite(Number(obj.currentPriceUsd))) {
    obj.currentPriceUsd = Number(obj.currentPriceUsd);
  }

  return obj;
}

function normalizeBorrowVsSellPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rawJur =
    typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim().toUpperCase() : "US";
  obj.jurisdiction = rawJur === "BR" ? "BR" : "US";

  if (typeof obj.regime !== "string" || !obj.regime.trim()) {
    obj.regime = obj.jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL";
  }

  if (obj.holdingDays === undefined) {
    obj.holdingDays = 365;
  }
  if (!obj.collateralAsset && typeof obj.collateral === "string") {
    obj.collateralAsset = obj.collateral;
  }
  if (obj.collateralAmount === undefined && typeof obj.amount === "number") {
    obj.collateralAmount = obj.amount;
  }
  if (obj.liquidityNeededUsd === undefined && typeof obj.liquidityUsd === "number") {
    obj.liquidityNeededUsd = obj.liquidityUsd;
  }

  return obj;
}

async function parseAndValidateBody<TSchema extends z.ZodType>(
  request: Request,
  schema: TSchema,
  normalize?: (raw: unknown) => unknown
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

  const normalized = normalize ? normalize(raw) : raw;
  const parsed = schema.safeParse(normalized);
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
        "MCP-Method",
        "Mcp-Session-Id",
      ],
      exposeHeaders: [
        "PAYMENT-REQUIRED",
        "PAYMENT-RESPONSE",
        "Mcp-Session-Id",
      ],
    })
  );

  // Clean trailing markdown backticks (` or %60) appended by naive link extractors
  app.use("*", async (c, next) => {
    if (c.req.method === "GET" || c.req.method === "HEAD") {
      const url = new URL(c.req.url);
      if (/(%60|`)+$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/(%60|`)+$/gi, "") || "/";
        return c.redirect(url.toString(), 301);
      }
    }
    return next();
  });

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
        x402Manifest: `${baseUrl}/.well-known/x402`,
        llmsTxt: `${baseUrl}/llms.txt`,
        skillMd: `${baseUrl}/SKILL.md`,
        openapi: `${baseUrl}/openapi.json`,
        preTradeCheck: `${baseUrl}/api/v1/x402/pre-trade-check`,
        br35kStatus: `${baseUrl}/api/v1/x402/br-35k-status`,
        prepareExecution: `${baseUrl}/api/v1/prepare-execution`,
        claimDossier: `${baseUrl}/api/v1/claim-dossier`,
        feedback: `${baseUrl}/api/v1/feedback`,
        reputation: `${baseUrl}/api/v1/reputation`,
        mcp: `${baseUrl}/mcp`,
      },
    });
  });

  app.get("/health", async (c) => {
    if (c.req.query("check") === "cdp") {
      const keyId = c.env.CDP_API_KEY_ID?.trim();
      const keySecret = c.env.CDP_API_KEY_SECRET?.trim();
      const cdpConfigured = Boolean(keyId && keySecret);
      if (!cdpConfigured || !keyId || !keySecret) {
        return c.json({
          status: "ok",
          cdpConfigured: false,
          jwtMintOk: false,
          supportedHttpStatus: null,
          errorMessage: "CDP_API_KEY_ID or CDP_API_KEY_SECRET not set",
        });
      }

      let jwtMintOk = false;
      try {
        const headers = await createCdpFacilitatorAuthHeaders(keyId, keySecret)();
        jwtMintOk = Boolean(headers.supported?.Authorization);
        const res = await fetch(`${COINBASE_CDP_FACILITATOR_URL}/supported`, {
          method: "GET",
          headers: {
            Accept: "application/json",
            ...headers.supported,
          },
        });
        const errorMessage = res.ok ? null : (await res.text()).slice(0, 300);
        return c.json({
          status: "ok",
          cdpConfigured: true,
          jwtMintOk,
          supportedHttpStatus: res.status,
          errorMessage,
        });
      } catch (err) {
        return c.json({
          status: "ok",
          cdpConfigured: true,
          jwtMintOk,
          supportedHttpStatus: null,
          errorMessage: err instanceof Error ? err.message : "Unknown CDP check error",
        });
      }
    }

    return c.json({
      status: "ok",
      service: "taxrail-edge",
      version: "0.1.0",
      timestamp: new Date().toISOString(),
    });
  });

  app.get("/robots.txt", (c) => {
    const baseUrl = resolvePublicBaseUrl(c.env, c.req.url);
    const body = [
      "User-agent: *",
      "Allow: /",
      "",
      "User-agent: GPTBot",
      "Allow: /",
      "",
      "User-agent: ChatGPT-User",
      "Allow: /",
      "",
      "User-agent: ClaudeBot",
      "Allow: /",
      "",
      "User-agent: PerplexityBot",
      "Allow: /",
      "",
      "User-agent: Google-Extended",
      "Allow: /",
      "",
      `Sitemap: https://taxrail.online/sitemap.xml`,
      `Sitemap: ${baseUrl}/llms.txt`,
      "",
    ].join("\n");
    return c.text(body, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    });
  });

  app.get("/favicon.ico", (c) => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#062c22"/><rect x="2" y="2" width="60" height="60" rx="12" fill="none" stroke="#10b981" stroke-width="3"/><text x="32" y="42" text-anchor="middle" font-family="ui-sans-serif,system-ui,-apple-system,sans-serif" font-size="28" font-weight="800" fill="#34d399">TR</text></svg>`;
    return c.body(svg, 200, {
      "Content-Type": "image/svg+xml",
      "Cache-Control": "public, max-age=86400",
    });
  });

  // Discovery endpoints
  app.get("/.well-known/agent.json", (c) => {
    return c.json(buildAgentCard(c.env, c.req.url));
  });

  app.get("/.well-known/agent-card.json", (c) => {
    return c.json(buildAgentCard(c.env, c.req.url));
  });

  app.get("/.well-known/mcp/server-card.json", (c) => {
    return c.json(buildMcpServerCard(c.env, c.req.url), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  app.get("/.well-known/mcp.json", (c) => {
    return c.json(buildMcpServerCard(c.env, c.req.url), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  app.get("/mcp/server-card", (c) => {
    return c.json(buildMcpServerCard(c.env, c.req.url), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  app.get("/.well-known/ai-catalog.json", (c) => {
    return c.json(buildAiCatalog(c.env, c.req.url), 200, {
      "Cache-Control": "public, max-age=300",
    });
  });

  app.get("/llms.txt", (c) => {
    return c.text(buildLlmsTxt(c.env, c.req.url), 200, {
      "Content-Type": "text/plain; charset=utf-8",
    });
  });

  app.get("/openapi.json", (c) => {
    return c.json(buildOpenApiSpec(c.env, c.req.url));
  });

  app.get("/api/openapi.json", (c) => {
    return c.json(buildOpenApiSpec(c.env, c.req.url));
  });

  app.get("/SKILL.md", (c) => {
    return c.text(buildSkillMd(c.env, c.req.url), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  });

  app.get("/.well-known/x402", (c) => {
    return c.json(buildWellKnownX402(c.env, c.req.url));
  });

  const glamaClaimPayload = {
    $schema: "https://glama.ai/mcp/schemas/connector.json",
    claim: "glama_claim_Wgag6uWRQ0FnQZtLErg7eKXDH-7Pw6ex",
  };
  app.get("/mcp/.well-known/glama.json", (c) => c.json(glamaClaimPayload));
  app.get("/.well-known/glama.json", (c) => c.json(glamaClaimPayload));

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
    const parsed = await parseAndValidateBody(
      c.req.raw,
      CheckTaxImpactRequestSchema,
      normalizeCheckTaxImpactPayload
    );
    if (!parsed.ok) {
      return c.json(
        {
          error: parsed.error,
          issues: parsed.issues,
          examplePayload: EXAMPLE_CHECK_TAX_IMPACT_PAYLOAD,
        },
        400
      );
    }

    try {
      const planStore = createPlanStore(c.env);
      const response = await executeCheckTaxImpact(parsed.data, {
        planStore,
        env: c.env,
      });
      console.log(
        JSON.stringify({
          event: "preview_check_tax_impact",
          chain: parsed.data.chain ?? "base",
          asset: parsed.data.targetAsset,
          jurisdiction: parsed.data.jurisdiction,
          hasWallet: Boolean(parsed.data.walletAddress),
          taxSavedUsd: response.taxSavedUsd,
          planId: response.planId,
        })
      );
      return c.json(response, 200);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to compute tax impact" },
        400
      );
    }
  });

  app.post("/api/v1/borrow-vs-sell", async (c) => {
    const parsed = await parseAndValidateBody(
      c.req.raw,
      BorrowVsSellInputSchema,
      normalizeBorrowVsSellPayload
    );
    if (!parsed.ok) {
      return c.json(
        {
          error: parsed.error,
          issues: parsed.issues,
          examplePayload: EXAMPLE_BORROW_VS_SELL_PAYLOAD,
        },
        400
      );
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
      return c.json(
        {
          error: parsed.error,
          issues: parsed.issues,
          examplePayload: EXAMPLE_CLASSIFY_EXPENSE_PAYLOAD,
        },
        400
      );
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

  function send402Probe(
    c: {
      env: Env;
      req: { url: string };
      header: (name: string, value: string) => void;
      json: (data: unknown, status: 402) => Response;
    },
    probe: { paymentRequired: unknown; paymentRequiredHeader: string }
  ): Response {
    c.header("PAYMENT-REQUIRED", probe.paymentRequiredHeader);
    c.header("Cache-Control", "no-store");
    return c.json(probe.paymentRequired, 402);
  }

  // Dynamic x402-gated Step 2 unlock endpoint (GET probe + POST unlock)
  app.get("/api/v1/unlock-plan", (c) => {
    return send402Probe(c, buildUnlockProbePaymentRequired(c.env, c.req.url));
  });

  app.post("/api/v1/unlock-plan", async (c) => {
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    let rawJson: unknown;
    try {
      const text = await c.req.text();
      rawJson = text.trim() ? JSON.parse(text) : {};
    } catch {
      return c.json({ error: "Invalid JSON request body" }, 400);
    }

    const parsed = UnlockPlanInputSchema.safeParse(rawJson);
    if (!parsed.success) {
      // Allow empty POST probes without payment header to receive a valid x402 402 challenge
      const isEmptyObject =
        rawJson !== null &&
        typeof rawJson === "object" &&
        !Array.isArray(rawJson) &&
        Object.keys(rawJson as Record<string, unknown>).length === 0;
      if (!paymentHeader && isEmptyObject) {
        return send402Probe(c, buildUnlockProbePaymentRequired(c.env, c.req.url));
      }
      return c.json(
        { error: "Validation error", issues: parsed.error.flatten() },
        400
      );
    }

    if (!paymentHeader && parsed.data.planId === "string") {
      return send402Probe(c, buildUnlockProbePaymentRequired(c.env, c.req.url));
    }

    const planStore = createPlanStore(c.env);
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

    await recordPaidReceipt(c.env, {
      settlementTx: result.settlementTx,
      tier: "10PCT_UNLOCK",
      amountUsd: result.record.pricing.upfrontX402Usd,
      taxSavedUsd: result.record.pricing.taxSavedUsd,
      planId: result.record.plan.planId,
    });

    console.log(
      JSON.stringify({
        event: "x402_unlock_plan_paid",
        planId: result.record.plan.planId,
        planType: result.record.plan.planType,
        jurisdiction: result.record.plan.jurisdiction,
        amountUsd: result.record.pricing.upfrontX402Usd,
        taxSavedUsd: result.record.pricing.taxSavedUsd,
        settlementTx: result.settlementTx ?? null,
      })
    );

    if (result.paymentResponseHeader) {
      c.header("PAYMENT-RESPONSE", result.paymentResponseHeader);
    }

    return c.json(result.record.plan, 200);
  });

  // $0-Upfront 1-Click Execution preparation (10% fee paid directly from operation)
  app.post("/api/v1/prepare-execution", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, PrepareExecutionInputSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    const planStore = createPlanStore(c.env);
    const result = await executePrepareExecution(parsed.data, {
      planStore,
      env: c.env,
    });

    if (!result.ok) {
      return c.json({ error: result.error, planId: parsed.data.planId }, result.status);
    }

    console.log(
      JSON.stringify({
        event: "prepare_execution",
        planId: result.data.planId,
        planType: result.data.planType,
        chain: result.data.chain,
        feePaidFromOperationUsd: result.data.feePaidFromOperationUsd,
      })
    );

    return c.json(result.data, 200);
  });

  // Verify on-chain operation fee receipt and unlock SpecID lots + accounting CSV dossier
  app.post("/api/v1/claim-dossier", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, ClaimDossierInputSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? "";
    const devBypass = Boolean(
      c.env.X402_DEV_BYPASS_TOKEN &&
        paymentHeader.trim() === `dev-bypass:${c.env.X402_DEV_BYPASS_TOKEN}`
    );

    const planStore = createPlanStore(c.env);
    const result = await executeClaimDossier(
      parsed.data,
      { planStore, env: c.env },
      { devBypass }
    );

    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          planId: parsed.data.planId,
          ...(result.explorerUrl ? { explorerUrl: result.explorerUrl } : {}),
        },
        result.status
      );
    }

    console.log(
      JSON.stringify({
        event: "claim_dossier_verified",
        planId: result.data.planId,
        settlementTx: result.data.settlementTx,
        feePaidUsd: result.data.feePaidUsd,
      })
    );

    return c.json(result.data, 200);
  });

  // 1-step x402-gated optimization endpoint (GET probe + POST pay-then-execute)
  app.get("/api/v1/x402/optimize", (c) => {
    return send402Probe(c, buildQuickOptimizeProbePaymentRequired(c.env, c.req.url));
  });

  app.post("/api/v1/x402/optimize", async (c) => {
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    const paymentResult = await verifyQuickOptimizePayment({
      paymentHeader,
      env: c.env,
      requestUrl: c.req.url,
    });

    if (paymentResult.status !== "paid") {
      c.header("PAYMENT-REQUIRED", paymentResult.paymentRequiredHeader);
      c.header("Cache-Control", "no-store");
      const body =
        paymentResult.status === "payment_required"
          ? paymentResult.paymentRequired
          : {
              ...paymentResult.paymentRequired,
              error: paymentResult.reason,
            };
      return c.json(body, 402);
    }

    const parsed = await parseAndValidateBody(
      c.req.raw,
      CheckTaxImpactRequestSchema,
      normalizeCheckTaxImpactPayload
    );
    if (!parsed.ok) {
      return c.json(
        {
          error: parsed.error,
          issues: parsed.issues,
          examplePayload: EXAMPLE_CHECK_TAX_IMPACT_PAYLOAD,
        },
        400
      );
    }

    try {
      const planStore = createPlanStore(c.env);
      const plan = await executeQuickOptimize(parsed.data, {
        planStore,
        env: c.env,
      });
      await recordPaidReceipt(c.env, {
        settlementTx: paymentResult.settlementTx,
        tier: "QUICK_OPTIMIZE",
        amountUsd: 0.1,
        taxSavedUsd: plan.taxSavedUsd,
        planId: plan.planId,
      });
      if (paymentResult.paymentResponseHeader) {
        c.header("PAYMENT-RESPONSE", paymentResult.paymentResponseHeader);
      }
      return c.json(plan, 200);
    } catch (err) {
      return c.json(
        { error: err instanceof Error ? err.message : "Failed to optimize tax plan" },
        400
      );
    }
  });

  // 1-parameter $0.01 USDC TLH & Tax-Risk Scanner (Paywall runs BEFORE query/body validation)
  app.on(["GET", "POST"], "/api/v1/x402/tlh-scan", async (c) => {
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    const paymentResult = await verifyTlhScanPayment({
      paymentHeader,
      env: c.env,
      requestUrl: c.req.url,
    });

    if (paymentResult.status !== "paid") {
      c.header("PAYMENT-REQUIRED", paymentResult.paymentRequiredHeader);
      c.header("Cache-Control", "no-store");
      const body =
        paymentResult.status === "payment_required"
          ? paymentResult.paymentRequired
          : {
              ...paymentResult.paymentRequired,
              error: paymentResult.reason,
            };
      return c.json(body, 402);
    }

    let bodyParams: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const text = await c.req.text();
        if (text.trim()) {
          bodyParams = JSON.parse(text) as Record<string, unknown>;
        }
      } catch {
        return c.json({ error: "Invalid JSON request body" }, 400);
      }
    }

    const walletAddress = (
      c.req.query("walletAddress") ||
      c.req.query("address") ||
      (typeof bodyParams.walletAddress === "string" ? bodyParams.walletAddress : "") ||
      ""
    ).trim();

    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return c.json(
        {
          error:
            "Missing or invalid `walletAddress`. Provide a valid 0x EVM address via `?walletAddress=0x...`.",
        },
        400
      );
    }

    const rawChain =
      c.req.query("chain") ||
      (typeof bodyParams.chain === "string" ? bodyParams.chain : "base");
    const chain =
      rawChain === "ethereum" || rawChain === "arbitrum" || rawChain === "base"
        ? rawChain
        : "base";
    const asset =
      c.req.query("asset") ||
      (typeof bodyParams.asset === "string" ? bodyParams.asset : "ALL");
    const rawJurisdiction =
      c.req.query("jurisdiction") ||
      (typeof bodyParams.jurisdiction === "string" ? bodyParams.jurisdiction : "US");
    const jurisdiction = rawJurisdiction.toUpperCase() === "BR" ? "BR" : "US";
    const regimeParam =
      c.req.query("regime") ||
      (typeof bodyParams.regime === "string" ? bodyParams.regime : undefined);
    const referrerWallet =
      c.req.query("referrerWallet") ||
      (typeof bodyParams.referrerWallet === "string" ? bodyParams.referrerWallet : undefined);

    const planStore = createPlanStore(c.env);
    const scanResult = await executeWalletTlhScan(
      {
        walletAddress,
        chain,
        asset,
        jurisdiction,
        ...(regimeParam ? { regime: regimeParam as Parameters<typeof executeWalletTlhScan>[0]["regime"] } : {}),
        ...(referrerWallet ? { referrerWallet } : {}),
      },
      { planStore, env: c.env }
    );

    console.log(
      JSON.stringify({
        event: "x402_tlh_scan_paid",
        walletAddress,
        chain,
        requestedAsset: asset,
        scannedAssets: scanResult.scannedAssets,
        lotsScanned: scanResult.lotsScanned,
        estimatedTaxSavingsUsd: scanResult.estimatedTaxSavingsUsd,
        planId: scanResult.planId ?? null,
        settlementTx: paymentResult.settlementTx ?? null,
      })
    );

    await recordPaidReceipt(c.env, {
      settlementTx: paymentResult.settlementTx,
      tier: "TLH_SCAN",
      amountUsd: 0.01,
      taxSavedUsd: scanResult.estimatedTaxSavingsUsd,
      planId: scanResult.planId,
    });

    if (paymentResult.paymentResponseHeader) {
      c.header("PAYMENT-RESPONSE", paymentResult.paymentResponseHeader);
    }
    return c.json(scanResult, 200);
  });

  // x402 $0.01 pre-trade swap/sell tax guardrail check
  app.on(["GET", "POST"], "/api/v1/x402/pre-trade-check", async (c) => {
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    // 1. x402 paywall FIRST so unpaid Bazaar crawlers always get HTTP 402 + schema
    const paymentResult = await verifyPreTradeCheckPayment({
      paymentHeader,
      env: c.env,
      requestUrl: c.req.url,
    });

    if (paymentResult.status === "settlement_failed") {
      return c.json(
        {
          error: paymentResult.reason ?? "x402 facilitator settlement failed",
        },
        502
      );
    }

    if (paymentResult.status !== "paid") {
      c.header("PAYMENT-REQUIRED", paymentResult.paymentRequiredHeader);
      return c.json(
        paymentResult.status === "payment_required"
          ? paymentResult.paymentRequired
          : {
              error: paymentResult.reason ?? "Invalid x402 payment payload",
              paymentRequired: paymentResult.paymentRequired,
            },
        402
      );
    }

    // 2. Paid request validated -> resolve query params / optional JSON body
    let bodyParams: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const parsed = await c.req.json();
        if (parsed && typeof parsed === "object") {
          bodyParams = parsed as Record<string, unknown>;
        }
      } catch {
        // Optional POST body
      }
    }

    const rawWallet =
      c.req.query("walletAddress") ||
      (typeof bodyParams.walletAddress === "string" ? bodyParams.walletAddress : "");
    const walletAddress = rawWallet.trim();
    if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
      return c.json(
        {
          error:
            "Missing or invalid walletAddress (must be a 0x EVM address, e.g. ?walletAddress=0x...&sellAsset=ETH&sellAmount=1)",
        },
        400
      );
    }

    const sellAsset = (
      c.req.query("sellAsset") ||
      (typeof bodyParams.sellAsset === "string" ? bodyParams.sellAsset : "ETH")
    )
      .trim()
      .toUpperCase();
    const rawAmount =
      c.req.query("sellAmount") ??
      (typeof bodyParams.sellAmount === "number" || typeof bodyParams.sellAmount === "string"
        ? String(bodyParams.sellAmount)
        : "1");
    const sellAmount = Number(rawAmount);
    if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
      return c.json(
        { error: "Invalid sellAmount (must be a positive number)" },
        400
      );
    }

    const rawChain =
      c.req.query("chain") ||
      (typeof bodyParams.chain === "string" ? bodyParams.chain : "base");
    const chain =
      rawChain === "ethereum" || rawChain === "arbitrum" || rawChain === "base"
        ? rawChain
        : "base";
    const rawJurisdiction =
      c.req.query("jurisdiction") ||
      (typeof bodyParams.jurisdiction === "string" ? bodyParams.jurisdiction : "US");
    const jurisdiction = rawJurisdiction.toUpperCase() === "BR" ? "BR" : "US";
    const regimeParam =
      c.req.query("regime") ||
      (typeof bodyParams.regime === "string" ? bodyParams.regime : undefined);
    const referrerWallet =
      c.req.query("referrerWallet") ||
      (typeof bodyParams.referrerWallet === "string" ? bodyParams.referrerWallet : undefined);
    const rawPrice =
      c.req.query("currentPriceUsd") ??
      (typeof bodyParams.currentPriceUsd === "number" ? String(bodyParams.currentPriceUsd) : undefined);
    const currentPriceUsd =
      rawPrice && Number.isFinite(Number(rawPrice)) && Number(rawPrice) > 0
        ? Number(rawPrice)
        : undefined;
    const lots = Array.isArray(bodyParams.lots)
      ? (bodyParams.lots as Parameters<typeof executePreTradeCheck>[0]["lots"])
      : undefined;

    const planStore = createPlanStore(c.env);
    const result = await executePreTradeCheck(
      {
        walletAddress,
        sellAsset,
        sellAmount,
        chain,
        jurisdiction,
        ...(regimeParam ? { regime: regimeParam as Parameters<typeof executePreTradeCheck>[0]["regime"] } : {}),
        ...(referrerWallet ? { referrerWallet } : {}),
        ...(currentPriceUsd !== undefined ? { currentPriceUsd } : {}),
        ...(lots ? { lots } : {}),
      },
      { planStore, env: c.env }
    );

    console.log(
      JSON.stringify({
        event: "x402_pre_trade_check_paid",
        walletAddress,
        sellAsset,
        sellAmount,
        chain,
        recommendation: result.recommendation,
        taxSavedUsd: result.taxSavedUsd,
        planId: result.planId ?? null,
        settlementTx: paymentResult.settlementTx ?? null,
      })
    );

    await recordPaidReceipt(c.env, {
      settlementTx: paymentResult.settlementTx,
      tier: "PRE_TRADE_CHECK",
      amountUsd: 0.01,
      taxSavedUsd: result.taxSavedUsd,
      planId: result.planId,
    });

    if (paymentResult.paymentResponseHeader) {
      c.header("PAYMENT-RESPONSE", paymentResult.paymentResponseHeader);
    }
    return c.json(result, 200);
  });

  // x402 $0.005 Brazil R$35k monthly exemption & Lei 14.754 check
  app.on(["GET", "POST"], "/api/v1/x402/br-35k-status", async (c) => {
    const paymentHeader =
      c.req.header("PAYMENT-SIGNATURE") ?? c.req.header("X-PAYMENT") ?? null;

    // 1. x402 paywall FIRST so unpaid Bazaar crawlers always get HTTP 402 + schema
    const paymentResult = await verifyBr35kStatusPayment({
      paymentHeader,
      env: c.env,
      requestUrl: c.req.url,
    });

    if (paymentResult.status === "settlement_failed") {
      return c.json(
        {
          error: paymentResult.reason ?? "x402 facilitator settlement failed",
        },
        502
      );
    }

    if (paymentResult.status !== "paid") {
      c.header("PAYMENT-REQUIRED", paymentResult.paymentRequiredHeader);
      return c.json(
        paymentResult.status === "payment_required"
          ? paymentResult.paymentRequired
          : {
              error: paymentResult.reason ?? "Invalid x402 payment payload",
              paymentRequired: paymentResult.paymentRequired,
            },
        402
      );
    }

    let bodyParams: Record<string, unknown> = {};
    if (c.req.method === "POST") {
      try {
        const parsed = await c.req.json();
        if (parsed && typeof parsed === "object") {
          bodyParams = parsed as Record<string, unknown>;
        }
      } catch {
        // Optional POST body
      }
    }

    const monthlySalesBrl = Number(
      c.req.query("monthlySalesBrl") ??
        (bodyParams.monthlySalesBrl !== undefined ? String(bodyParams.monthlySalesBrl) : "0")
    );
    const plannedSaleUsd = Number(
      c.req.query("plannedSaleUsd") ??
        (bodyParams.plannedSaleUsd !== undefined ? String(bodyParams.plannedSaleUsd) : "1000")
    );
    if (
      !Number.isFinite(monthlySalesBrl) ||
      monthlySalesBrl < 0 ||
      !Number.isFinite(plannedSaleUsd) ||
      plannedSaleUsd < 0
    ) {
      return c.json(
        { error: "monthlySalesBrl and plannedSaleUsd must be non-negative finite numbers" },
        400
      );
    }

    const rawCustody = (
      c.req.query("custodyLocation") ||
      (typeof bodyParams.custodyLocation === "string" ? bodyParams.custodyLocation : "DOMESTIC")
    )
      .trim()
      .toUpperCase();
    const custodyLocation = rawCustody === "OFFSHORE" ? "OFFSHORE" : "DOMESTIC";

    const rawFx =
      c.req.query("usdBrlRate") ??
      (bodyParams.usdBrlRate !== undefined ? String(bodyParams.usdBrlRate) : undefined);
    const usdBrlRate =
      rawFx && Number.isFinite(Number(rawFx)) && Number(rawFx) > 0 ? Number(rawFx) : undefined;

    const rawMargin =
      c.req.query("estimatedGainMarginPct") ??
      (bodyParams.estimatedGainMarginPct !== undefined
        ? String(bodyParams.estimatedGainMarginPct)
        : undefined);
    const estimatedGainMarginPct =
      rawMargin && Number.isFinite(Number(rawMargin)) && Number(rawMargin) > 0
        ? Number(rawMargin)
        : undefined;

    const statusResult = executeBr35kStatus({
      monthlySalesBrl,
      plannedSaleUsd,
      custodyLocation,
      ...(usdBrlRate !== undefined ? { usdBrlRate } : {}),
      ...(estimatedGainMarginPct !== undefined ? { estimatedGainMarginPct } : {}),
    });

    console.log(
      JSON.stringify({
        event: "x402_br_35k_status_paid",
        custodyLocation,
        monthlySalesBrl,
        plannedSaleUsd,
        status: statusResult.status,
        wouldBreach35kThreshold: statusResult.wouldBreach35kThreshold,
        settlementTx: paymentResult.settlementTx ?? null,
      })
    );

    await recordPaidReceipt(c.env, {
      settlementTx: paymentResult.settlementTx,
      tier: "BR_35K_STATUS",
      amountUsd: 0.005,
    });

    if (paymentResult.paymentResponseHeader) {
      c.header("PAYMENT-RESPONSE", paymentResult.paymentResponseHeader);
    }
    return c.json(statusResult, 200);
  });

  // Free Verified Agent Feedback & Public Reputation Loop
  app.post("/api/v1/feedback", async (c) => {
    const parsed = await parseAndValidateBody(c.req.raw, FeedbackInputSchema);
    if (!parsed.ok) {
      return c.json({ error: parsed.error, issues: parsed.issues }, 400);
    }

    const planStore = createPlanStore(c.env);
    const result = await submitFeedback({
      input: parsed.data,
      env: c.env,
      planStore,
    });

    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result, 201);
  });

  app.get("/api/v1/reputation", async (c) => {
    const reputation = await getPublicReputation(c.env);
    c.header("Cache-Control", "public, max-age=60");
    return c.json(reputation, 200);
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
