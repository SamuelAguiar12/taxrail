import { decodePaymentRequiredHeader } from "@x402/core/http";
import { describe, expect, it } from "vitest";
import app from "../src/index.js";
import type { Env } from "../src/env.js";

const TEST_BYPASS_TOKEN = "test-secret-bypass-token";

const testEnv: Env = {
  PAY_TO_ADDRESS: "0x0000000000000000000000000000000000000001",
  X402_NETWORK: "eip155:8453",
  X402_ASSET: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  FACILITATOR_URL: "https://x402.org/facilitator",
  PUBLIC_BASE_URL: "https://api.taxrail.online",
  X402_DEV_BYPASS_TOKEN: TEST_BYPASS_TOKEN,
};

function jsonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...extra,
  };
}

describe("TaxRail Edge Worker", () => {
  describe("Health & Discovery", () => {
    it("serves GET /health", async () => {
      const res = await app.request("/health", undefined, testEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expect(body.service).toBe("taxrail-edge");
    });

    it("serves GET /.well-known/agent.json with A2A card, dynamic x402, and affiliate program", async () => {
      const res = await app.request("/.well-known/agent.json", undefined, testEnv);
      expect(res.status).toBe(200);
      const card = (await res.json()) as Record<string, unknown>;
      expect(card.name).toBe("TaxRail");
      expect(card.jurisdictions).toEqual(["US", "BR"]);
      expect((card.pricing as Record<string, unknown>).protocol).toBe("x402");
      expect((card.affiliateProgram as Record<string, unknown>).revsharePct).toBe(0.2);
      expect(Array.isArray(card.skills)).toBe(true);
      expect((card.skills as unknown[]).length).toBe(4);
    });

    it("serves GET /llms.txt with 2-step funnel documentation", async () => {
      const res = await app.request("/llms.txt", undefined, testEnv);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("check_tax_impact");
      expect(text).toContain("unlock_tax_plan");
      expect(text).toContain("x402");
      expect(text).toContain("referrerWallet");
    });

    it("serves GET /openapi.json with OpenAPI 3.1 paths and x-payment metadata", async () => {
      const res = await app.request("/openapi.json", undefined, testEnv);
      expect(res.status).toBe(200);
      const spec = (await res.json()) as {
        openapi: string;
        paths: Record<string, Record<string, Record<string, unknown>>>;
      };
      expect(spec.openapi).toBe("3.1.0");
      expect(spec.paths["/api/v1/check-tax-impact"]?.post).toBeDefined();
      expect(spec.paths["/api/v1/borrow-vs-sell"]?.post).toBeDefined();
      expect(spec.paths["/api/v1/classify-expense"]?.post).toBeDefined();
      expect(spec.paths["/api/v1/unlock-plan"]?.post?.["x-payment"]).toBe("x402");
    });
  });

  describe("Crypto Disposal Funnel + Dynamic x402 Gate", () => {
    it("previews tax impact without leaking lotIds, enforces HTTP 402 with exact dynamic USDC amount, and unlocks via dev-bypass", async () => {
      const previewRes = await app.request(
        "/api/v1/check-tax-impact",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            jurisdiction: "US",
            regime: "INDIVIDUAL",
            chain: "base",
            walletAddress: "0x1111111111111111111111111111111111111111",
            targetAsset: "ETH",
            sellQuantity: 1,
            currentPriceUsd: 3000,
            targetQuoteAsset: "USDC",
            asOfDate: "2026-06-01T00:00:00Z",
            referrerWallet: "0x2222222222222222222222222222222222222222",
            lots: [
              // Oldest lot with very low basis $500 -> naive FIFO sells this first ($2500 gain)
              {
                lotId: "lot-secret-fifo-low-basis",
                asset: "ETH",
                quantity: 1,
                costBasisUsd: 500,
                acquiredAt: "2024-01-01T00:00:00Z",
                custodyLocation: "SELF_CUSTODY",
              },
              // Newer long-term lot (>365d) with high basis $2800 -> SpecID/HIFO sells this ($200 gain)
              {
                lotId: "lot-secret-hifo-high-basis",
                asset: "ETH",
                quantity: 1,
                costBasisUsd: 2800,
                acquiredAt: "2025-01-01T00:00:00Z",
                custodyLocation: "SELF_CUSTODY",
              },
            ],
          }),
        },
        testEnv
      );

      expect(previewRes.status).toBe(200);
      const previewText = await previewRes.text();
      // Strict anti-leakage assertion: neither lotId nor calldata appears in free preview
      expect(previewText).not.toContain("lot-secret-fifo-low-basis");
      expect(previewText).not.toContain("lot-secret-hifo-high-basis");
      expect(previewText).not.toContain("selectedLots");
      expect(previewText).not.toContain("swapIntent");

      const preview = JSON.parse(previewText) as {
        planId: string;
        taxSavedUsd: number;
        pricing: { upfrontX402Usd: number; affiliateShareUsd: number };
      };
      expect(preview.planId).toMatch(/^plan_/);
      expect(preview.taxSavedUsd).toBeGreaterThan(0);
      expect(preview.pricing.upfrontX402Usd).toBeGreaterThan(0);
      expect(preview.pricing.affiliateShareUsd).toBeGreaterThan(0);

      // Step 2a: Unlock without payment -> must return HTTP 402 with exact dynamic USDC amount
      const unpaidRes = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ planId: preview.planId }),
        },
        testEnv
      );

      expect(unpaidRes.status).toBe(402);
      const paymentRequiredHeader = unpaidRes.headers.get("PAYMENT-REQUIRED");
      expect(paymentRequiredHeader).toBeTruthy();

      const expectedAtomic = String(Math.round(preview.pricing.upfrontX402Usd * 1_000_000));
      const unpaidBody = (await unpaidRes.json()) as {
        x402Version: number;
        accepts: Array<{
          scheme: string;
          network: string;
          asset: string;
          amount: string;
          payTo: string;
          extra: Record<string, unknown>;
        }>;
        extensions?: {
          bazaar?: {
            info?: { input?: { method?: string } };
            schema?: Record<string, unknown>;
          };
        };
      };
      expect(unpaidBody.x402Version).toBe(2);
      expect(unpaidBody.accepts[0]?.scheme).toBe("exact");
      expect(unpaidBody.accepts[0]?.network).toBe("eip155:8453");
      expect(unpaidBody.accepts[0]?.asset).toBe(testEnv.X402_ASSET);
      expect(unpaidBody.accepts[0]?.amount).toBe(expectedAtomic);
      expect(unpaidBody.accepts[0]?.extra?.planId).toBe(preview.planId);
      expect(unpaidBody.extensions?.bazaar?.info?.input?.method).toBe("POST");
      expect(unpaidBody.extensions?.bazaar?.schema).toBeDefined();

      const decodedHeader = decodePaymentRequiredHeader(paymentRequiredHeader!);
      expect(decodedHeader.accepts[0]?.amount).toBe(expectedAtomic);

      // Step 2b: Unlock with X-PAYMENT dev-bypass -> HTTP 200 with full plan
      const paidRes = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders({
            "X-PAYMENT": `dev-bypass:${TEST_BYPASS_TOKEN}`,
          }),
          body: JSON.stringify({ planId: preview.planId }),
        },
        testEnv
      );

      expect(paidRes.status).toBe(200);
      const fullPlan = (await paidRes.json()) as {
        planId: string;
        selectedLots?: Array<{ lotId: string }>;
        swapIntent?: { venue: string; chain: string; requestTemplate: Record<string, unknown> };
        accountingDossier: { format: string; csvExport?: string };
      };
      expect(fullPlan.planId).toBe(preview.planId);
      expect(fullPlan.selectedLots?.length).toBeGreaterThan(0);
      expect(fullPlan.selectedLots?.[0]?.lotId).toBe("lot-secret-hifo-high-basis");
      expect(fullPlan.swapIntent?.venue).toBe("0x_v2");
      expect(fullPlan.swapIntent?.chain).toBe("base");
      expect(fullPlan.accountingDossier.format).toBe("IRS_FORM_8949");
      expect(fullPlan.accountingDossier.csvExport).toContain("Description of Property");
    });

    it("returns HTTP 404 when unlocking an unknown planId", async () => {
      const res = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ planId: "plan_does_not_exist" }),
        },
        testEnv
      );
      expect(res.status).toBe(404);
    });

    it("unlocks immediately without payment when taxSavedUsd is 0 (zero fee)", async () => {
      const previewRes = await app.request(
        "/api/v1/check-tax-impact",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            jurisdiction: "US",
            regime: "INDIVIDUAL",
            targetAsset: "ETH",
            sellQuantity: 1,
            currentPriceUsd: 2000,
            asOfDate: "2026-06-01T00:00:00Z",
            lots: [
              {
                lotId: "single-lot",
                asset: "ETH",
                quantity: 1,
                costBasisUsd: 2000,
                acquiredAt: "2024-01-01T00:00:00Z",
                custodyLocation: "DOMESTIC",
              },
            ],
          }),
        },
        testEnv
      );
      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as {
        planId: string;
        taxSavedUsd: number;
        pricing: { upfrontX402Usd: number };
      };
      expect(preview.taxSavedUsd).toBe(0);
      expect(preview.pricing.upfrontX402Usd).toBe(0);

      const unlockRes = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({ planId: preview.planId }),
        },
        testEnv
      );
      expect(unlockRes.status).toBe(200);
      const unlocked = (await unlockRes.json()) as { planId: string };
      expect(unlocked.planId).toBe(preview.planId);
    });

    it("accepts walletAddress-only requests and reports ALCHEMY_API_KEY requirement when unconfigured, plus validates /api/v1/wallet-scan", async () => {
      const scanRes = await app.request(
        "/api/v1/wallet-scan?address=not-an-address",
        undefined,
        testEnv
      );
      expect(scanRes.status).toBe(400);

      const walletOnlyRes = await app.request(
        "/api/v1/check-tax-impact",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            jurisdiction: "US",
            regime: "INDIVIDUAL",
            chain: "base",
            walletAddress: "0x0202e70990d90325A1Dca322C91471Be774E4B6f",
            targetAsset: "ETH",
            sellQuantity: 1,
          }),
        },
        testEnv
      );
      expect(walletOnlyRes.status).toBe(400);
      const errBody = (await walletOnlyRes.json()) as { error: string };
      expect(errBody.error).toContain("ALCHEMY_API_KEY");
    });
  });

  describe("Borrow vs Sell & Deductible Expense", () => {
    it("compares borrow vs sell and unlocks real Aave v3 0x calldata", async () => {
      const previewRes = await app.request(
        "/api/v1/borrow-vs-sell",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            jurisdiction: "US",
            regime: "INDIVIDUAL",
            chain: "base",
            borrowerAddress: "0x3333333333333333333333333333333333333333",
            collateralAsset: "WETH",
            collateralAmount: 10,
            collateralPriceUsd: 3000,
            collateralCostBasisUsd: 500,
            holdingDays: 180,
            liquidityNeededUsd: 10000,
            borrowApr: 0.05,
            horizonDays: 180,
          }),
        },
        testEnv
      );

      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as {
        planId: string;
        recommendation: string;
        taxSavedUsd: number;
      };
      expect(preview.recommendation).toBe("BORROW_AAVE_V3");
      expect(preview.taxSavedUsd).toBeGreaterThan(0);

      const unlockRes = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders({
            "PAYMENT-SIGNATURE": `dev-bypass:${TEST_BYPASS_TOKEN}`,
          }),
          body: JSON.stringify({ planId: preview.planId }),
        },
        testEnv
      );
      expect(unlockRes.status).toBe(200);
      const plan = (await unlockRes.json()) as {
        aaveActions?: {
          protocol: string;
          chain: string;
          supplyTransaction?: { to: string; data: string };
          borrowTransaction: { to: string; data: string };
        };
        accountingDossier: { format: string };
      };

      expect(plan.aaveActions?.protocol).toBe("aave_v3");
      expect(plan.aaveActions?.chain).toBe("base");
      expect(plan.aaveActions?.supplyTransaction?.data).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(plan.aaveActions?.borrowTransaction.data).toMatch(/^0x[0-9a-fA-F]+$/);
      expect(plan.accountingDossier.format).toBe("IRS_FORM_8949");
    });

    it("classifies a Brazil Lucro Real deductible expense and unlocks Omie/SPED dossier", async () => {
      const previewRes = await app.request(
        "/api/v1/classify-expense",
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            jurisdiction: "BR",
            regime: "PJ_LUCRO_REAL",
            vendorName: "Anthropic",
            description: "Claude API compute infrastructure for production agent fleet",
            amountUsd: 5000,
            currency: "USD",
            hasFiscalDocument: true,
            fiscalDocumentId: "INV-2026-001",
          }),
        },
        testEnv
      );

      expect(previewRes.status).toBe(200);
      const preview = (await previewRes.json()) as {
        planId: string;
        deductible: boolean;
        taxSavedUsd: number;
      };
      expect(preview.deductible).toBe(true);
      expect(preview.taxSavedUsd).toBeGreaterThan(0);

      const unlockRes = await app.request(
        "/api/v1/unlock-plan",
        {
          method: "POST",
          headers: jsonHeaders({
            "X-PAYMENT": `dev-bypass:${TEST_BYPASS_TOKEN}`,
          }),
          body: JSON.stringify({ planId: preview.planId }),
        },
        testEnv
      );
      expect(unlockRes.status).toBe(200);
      const plan = (await unlockRes.json()) as {
        accountingDossier: { format: string };
      };
      expect(plan.accountingDossier.format).toBe("BR_LUCRO_REAL_OMIE_SPED");
    });
  });

  describe("Stateless Streamable HTTP MCP (/mcp)", () => {
    const mcpHeaders = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };

    it("handles JSON-RPC initialize and tools/list returning all 4 TaxRail tools", async () => {
      const initRes = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-03-26",
              capabilities: {},
              clientInfo: { name: "vitest-mcp-client", version: "1.0.0" },
            },
          }),
        },
        testEnv
      );

      expect(initRes.status).toBe(200);
      const initJson = (await initRes.json()) as {
        result?: { serverInfo?: { name: string }; capabilities?: Record<string, unknown> };
      };
      expect(initJson.result?.serverInfo?.name).toBe("taxrail");

      const listRes = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: {},
          }),
        },
        testEnv
      );

      expect(listRes.status).toBe(200);
      const listJson = (await listRes.json()) as {
        result?: { tools: Array<{ name: string }> };
      };
      const toolNames = listJson.result?.tools.map((t) => t.name) ?? [];
      expect(toolNames).toEqual(
        expect.arrayContaining([
          "check_tax_impact",
          "compare_borrow_vs_sell",
          "classify_deductible_expense",
          "unlock_tax_plan",
        ])
      );
      expect(toolNames).toHaveLength(4);
    });

    it("executes check_tax_impact and unlock_tax_plan over MCP tools/call", async () => {
      const callPreviewRes = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 3,
            method: "tools/call",
            params: {
              name: "check_tax_impact",
              arguments: {
                jurisdiction: "US",
                regime: "INDIVIDUAL",
                targetAsset: "ETH",
                sellQuantity: 1,
                currentPriceUsd: 3000,
                asOfDate: "2026-06-01T00:00:00Z",
                lots: [
                  {
                    lotId: "mcp-lot-fifo-low",
                    asset: "ETH",
                    quantity: 1,
                    costBasisUsd: 500,
                    acquiredAt: "2024-01-01T00:00:00Z",
                    custodyLocation: "SELF_CUSTODY",
                  },
                  {
                    lotId: "mcp-lot-hifo-high",
                    asset: "ETH",
                    quantity: 1,
                    costBasisUsd: 2800,
                    acquiredAt: "2025-01-01T00:00:00Z",
                    custodyLocation: "SELF_CUSTODY",
                  },
                ],
              },
            },
          }),
        },
        testEnv
      );

      expect(callPreviewRes.status).toBe(200);
      const previewRpc = (await callPreviewRes.json()) as {
        result?: { content: Array<{ text: string }> };
      };
      const previewData = JSON.parse(previewRpc.result!.content[0]!.text) as {
        planId: string;
        taxSavedUsd: number;
      };
      expect(previewData.planId).toMatch(/^plan_/);
      expect(previewData.taxSavedUsd).toBeGreaterThan(0);

      // Unpaid unlock_tax_plan returns structured 402 error payload
      const unpaidMcpRes = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 4,
            method: "tools/call",
            params: {
              name: "unlock_tax_plan",
              arguments: { planId: previewData.planId },
            },
          }),
        },
        testEnv
      );
      expect(unpaidMcpRes.status).toBe(200);
      const unpaidRpc = (await unpaidMcpRes.json()) as {
        result?: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(unpaidRpc.result?.isError).toBe(true);
      const unpaidPayload = JSON.parse(unpaidRpc.result!.content[0]!.text) as {
        status: number;
        paymentRequired: { x402Version: number };
      };
      expect(unpaidPayload.status).toBe(402);
      expect(unpaidPayload.paymentRequired.x402Version).toBe(2);

      // Paid unlock_tax_plan with dev-bypass returns full plan
      const paidMcpRes = await app.request(
        "/mcp",
        {
          method: "POST",
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 5,
            method: "tools/call",
            params: {
              name: "unlock_tax_plan",
              arguments: {
                planId: previewData.planId,
                paymentSignature: `dev-bypass:${TEST_BYPASS_TOKEN}`,
              },
            },
          }),
        },
        testEnv
      );
      expect(paidMcpRes.status).toBe(200);
      const paidRpc = (await paidMcpRes.json()) as {
        result?: { isError?: boolean; content: Array<{ text: string }> };
      };
      expect(paidRpc.result?.isError).toBeFalsy();
      const unlockedPlan = JSON.parse(paidRpc.result!.content[0]!.text) as {
        planId: string;
        selectedLots?: Array<{ lotId: string }>;
      };
      expect(unlockedPlan.planId).toBe(previewData.planId);
      expect(unlockedPlan.selectedLots?.[0]?.lotId).toBe("mcp-lot-hifo-high");
    });
  });
});
