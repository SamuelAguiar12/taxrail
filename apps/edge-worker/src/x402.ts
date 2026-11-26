import {
  HTTPFacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import {
  COINBASE_CDP_FACILITATOR_URL,
  DEFAULT_FACILITATOR_URL,
  DEFAULT_PAY_TO_ADDRESS,
  DEFAULT_X402_ASSET,
  DEFAULT_X402_NETWORK,
  type Env,
  resolvePublicBaseUrl,
} from "./env.js";
import { createCdpFacilitatorAuthHeaders } from "./cdp-auth.js";
import type { PlanStore, StoredPlanRecord } from "./plan-store.js";

/**
 * Result returned by `verifyUnlockPayment` for both HTTP `/api/v1/unlock-plan` and MCP `unlock_tax_plan`.
 */
export type UnlockPaymentResult =
  | {
      status: "not_found";
      planId: string;
    }
  | {
      status: "paid";
      record: StoredPlanRecord;
      settlementTx?: string;
      paymentResponseHeader?: string;
    }
  | {
      status: "payment_required";
      record: StoredPlanRecord;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    }
  | {
      status: "invalid_payment";
      record: StoredPlanRecord;
      reason: string;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    }
  | {
      status: "settlement_failed";
      record: StoredPlanRecord;
      reason: string;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    };

/**
 * Converts a USD dollar amount to 6-decimal USDC atomic units as a base-10 string.
 */
export function usdToUsdcAtomic(usdAmount: number): string {
  const atomic = Math.max(0, Math.round(usdAmount * 1_000_000));
  return String(atomic);
}

/**
 * Builds the x402 v2 PaymentRequired payload for a stored plan's dynamic pricing quote.
 */
export function buildPlanPaymentRequired(
  record: StoredPlanRecord,
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; requirements: PaymentRequirements } {
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount: usdToUsdcAtomic(record.pricing.upfrontX402Usd),
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      planId: record.plan.planId,
      taxSavedUsd: record.pricing.taxSavedUsd,
      feeRatePct: record.pricing.feeRatePct,
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: `${baseUrl}/api/v1/unlock-plan`,
      description: `TaxRail: Autonomous US (IRS 1099-DA, Form 8949, HIFO/SpecID, tax-loss harvesting, Aave v3 borrow-vs-sell) & Brazil (Lei 14.754, Lucro Real 34%, PIS/COFINS, IBS/CBS) crypto & corporate tax optimization — unlocks calldata & accounting dossiers (plan ${record.plan.planId}, saves $${record.pricing.taxSavedUsd.toFixed(2)}).`,
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              planId: record.plan.planId,
            },
          },
          output: {
            type: "json",
            example: {
              planId: record.plan.planId,
              planType: record.plan.planType,
              jurisdiction: record.plan.jurisdiction,
              regime: record.plan.regime,
              taxSavedUsd: record.pricing.taxSavedUsd,
              accountingDossier: { format: "IRS_FORM_8949" },
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  required: ["planId"],
                  properties: {
                    planId: {
                      type: "string",
                      description:
                        "Plan ID returned by free /api/v1/check-tax-impact, /api/v1/borrow-vs-sell, or /api/v1/classify-expense",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { paymentRequired, requirements };
}

/**
 * Builds a representative HTTP 402 probe response for GET / unpaid crawler probes on `/api/v1/unlock-plan`.
 */
export function buildUnlockProbePaymentRequired(
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; paymentRequiredHeader: string } {
  const now = new Date();
  const expires = new Date(now.getTime() + 900_000);
  const sampleRecord: StoredPlanRecord = {
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    unlocked: false,
    pricing: {
      taxSavedUsd: 345,
      feeRatePct: 0.1,
      totalFeeUsd: 34.5,
      settlementMode: "UPFRONT_X402",
      zeroUpfrontAvailable: true,
      operationFeeUsd: 34.5,
      upfrontX402Usd: 34.5,
      embeddedSwapFeeBps: 0,
      embeddedSwapFeePpm: 0,
      embeddedSwapFeeUsd: 0,
      enterpriseBalanceUsd: 0,
      affiliateShareUsd: 6.9,
      clientNetBenefitUsd: 310.5,
      roiMultiple: 10,
    },
    plan: {
      planId: "plan_sample_preview",
      planType: "CRYPTO_DISPOSAL",
      jurisdiction: "US",
      regime: "INDIVIDUAL",
    } as unknown as StoredPlanRecord["plan"],
  };

  const { paymentRequired } = buildPlanPaymentRequired(sampleRecord, env, requestUrl);
  return {
    paymentRequired,
    paymentRequiredHeader: encodePaymentRequiredHeader(paymentRequired),
  };
}

/**
 * Builds the 402 header + payload for GET probes on `/api/v1/x402/optimize`.
 */
export function buildQuickOptimizeProbePaymentRequired(
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; paymentRequiredHeader: string } {
  const { paymentRequired } = buildQuickOptimizePaymentRequired(env, requestUrl);
  return {
    paymentRequired,
    paymentRequiredHeader: encodePaymentRequiredHeader(paymentRequired),
  };
}

function parsePaymentPayload(rawHeader: string): PaymentPayload | null {
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;

  try {
    return decodePaymentSignatureHeader(trimmed);
  } catch {
    try {
      const parsed = JSON.parse(trimmed) as PaymentPayload;
      if (parsed && typeof parsed === "object" && "payload" in parsed) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Verifies and settles dynamic x402 payment for unlocking a TaxRail plan.
 * Shared across the Hono `/api/v1/unlock-plan` route and the MCP `unlock_tax_plan` tool.
 */
export async function verifyUnlockPayment(params: {
  planId: string;
  paymentHeader?: string | null;
  planStore: PlanStore;
  env: Env;
  requestUrl?: string;
}): Promise<UnlockPaymentResult> {
  const { planId, paymentHeader, planStore, env, requestUrl } = params;
  const record = await planStore.get(planId);
  if (!record) {
    return { status: "not_found", planId };
  }

  // Zero-fee plans ($0 verified savings) and already-unlocked plans unlock immediately.
  if (record.unlocked || record.pricing.upfrontX402Usd <= 0) {
    const unlocked = record.unlocked
      ? record
      : (await planStore.markUnlocked(planId, "zero-fee")) ?? { ...record, unlocked: true };
    return {
      status: "paid",
      record: unlocked,
      settlementTx: unlocked.settlementTx,
    };
  }

  const { paymentRequired, requirements } = buildPlanPaymentRequired(record, env, requestUrl);
  const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired);

  const trimmedHeader = paymentHeader?.trim();
  if (!trimmedHeader) {
    return {
      status: "payment_required",
      record,
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  // Non-production dev/test bypass when X402_DEV_BYPASS_TOKEN is explicitly configured.
  if (
    env.X402_DEV_BYPASS_TOKEN &&
    trimmedHeader === `dev-bypass:${env.X402_DEV_BYPASS_TOKEN}`
  ) {
    const unlocked = (await planStore.markUnlocked(planId, "dev-bypass")) ?? {
      ...record,
      unlocked: true,
      settlementTx: "dev-bypass",
    };
    return {
      status: "paid",
      record: unlocked,
      settlementTx: "dev-bypass",
    };
  }

  const paymentPayload = parsePaymentPayload(trimmedHeader);
  if (!paymentPayload) {
    return {
      status: "invalid_payment",
      record,
      reason: "Malformed x402 payment signature header",
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  const outcome = await verifyAndSettleWithFacilitators({
    paymentPayload,
    requirements,
    env,
  });

  if (!outcome.ok) {
    return {
      status: outcome.kind,
      record,
      reason: outcome.reason,
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  const unlocked = (await planStore.markUnlocked(planId, outcome.settleResult.transaction)) ?? {
    ...record,
    unlocked: true,
    settlementTx: outcome.settleResult.transaction,
  };

  return {
    status: "paid",
    record: unlocked,
    settlementTx: outcome.settleResult.transaction,
    paymentResponseHeader: encodePaymentResponseHeader(outcome.settleResult),
  };
}

function buildFacilitatorClients(env: Env): HTTPFacilitatorClient[] {
  const clients: HTTPFacilitatorClient[] = [];
  const cdpKeyId = env.CDP_API_KEY_ID?.trim();
  const cdpKeySecret = env.CDP_API_KEY_SECRET?.trim();

  if (cdpKeyId && cdpKeySecret) {
    clients.push(
      new HTTPFacilitatorClient({
        url: COINBASE_CDP_FACILITATOR_URL,
        createAuthHeaders: createCdpFacilitatorAuthHeaders(cdpKeyId, cdpKeySecret),
      })
    );
  }

  const configuredFallback = (env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL).trim();
  if (configuredFallback && configuredFallback !== COINBASE_CDP_FACILITATOR_URL) {
    clients.push(new HTTPFacilitatorClient({ url: configuredFallback }));
  } else if (clients.length === 0) {
    clients.push(new HTTPFacilitatorClient({ url: DEFAULT_FACILITATOR_URL }));
  }

  return clients;
}

function isRetryableFacilitatorFailure(reason?: string): boolean {
  if (!reason) return false;
  const lower = reason.toLowerCase();
  return (
    lower.includes("unexpected_error") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden") ||
    lower.includes("401") ||
    lower.includes("403")
  );
}

async function verifyAndSettleWithFacilitators(params: {
  paymentPayload: PaymentPayload;
  requirements: PaymentRequirements;
  env: Env;
}): Promise<
  | { ok: true; settleResult: Awaited<ReturnType<HTTPFacilitatorClient["settle"]>> }
  | { ok: false; kind: "invalid_payment" | "settlement_failed"; reason: string }
> {
  const { paymentPayload, requirements, env } = params;
  const clients = buildFacilitatorClients(env);
  let lastError: { ok: false; kind: "invalid_payment" | "settlement_failed"; reason: string } = {
    ok: false,
    kind: "settlement_failed",
    reason: "No x402 facilitator configured",
  };

  for (let i = 0; i < clients.length; i++) {
    const facilitator = clients[i]!;
    const hasFallback = i < clients.length - 1;

    try {
      const verifyResult = await facilitator.verify(paymentPayload, requirements);
      if (!verifyResult.isValid) {
        const reason =
          verifyResult.invalidMessage ||
          verifyResult.invalidReason ||
          "Facilitator rejected payment verification";
        lastError = { ok: false, kind: "invalid_payment", reason };
        if (hasFallback && isRetryableFacilitatorFailure(reason)) {
          continue;
        }
        return lastError;
      }

      const settleResult = await facilitator.settle(paymentPayload, requirements);
      if (!settleResult.success) {
        const reason =
          settleResult.errorMessage ||
          settleResult.errorReason ||
          "Facilitator settlement failed";
        lastError = { ok: false, kind: "settlement_failed", reason };
        if (hasFallback) {
          continue;
        }
        return lastError;
      }

      return { ok: true, settleResult };
    } catch (err) {
      lastError = {
        ok: false,
        kind: "settlement_failed",
        reason: err instanceof Error ? err.message : "x402 facilitator communication error",
      };
      if (hasFallback) {
        continue;
      }
    }
  }

  return lastError;
}

export type QuickOptimizePaymentResult =
  | {
      status: "paid";
      settlementTx?: string;
      paymentResponseHeader?: string;
    }
  | {
      status: "payment_required" | "invalid_payment" | "settlement_failed";
      reason?: string;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    };

/**
 * Builds the 1-step $0.10 USDC x402 v2 PaymentRequired challenge for `/api/v1/x402/optimize`,
 * ensuring x402 crawlers (x402scan, Bazaar) and 1-call agents get rich discovery metadata.
 */
export function buildQuickOptimizePaymentRequired(
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; requirements: PaymentRequirements } {
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount: usdToUsdcAtomic(0.1),
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      pricingModel: "flat-quick-optimize",
      affiliateRevsharePct: 0.2,
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: `${baseUrl}/api/v1/x402/optimize`,
      description:
        "TaxRail 1-Step Tax Optimization: Autonomous US (IRS 1099-DA, Form 8949, HIFO/SpecID, tax-loss harvesting) & Brazil (Lei 14.754, R$35k rule, Lucro Real) crypto tax calculation, wallet auto-scan, 0x/CoW/Jupiter swap calldata, and 20% affiliate revshare.",
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              jurisdiction: "US",
              regime: "INDIVIDUAL",
              chain: "base",
              targetAsset: "ETH",
              sellQuantity: 1,
              currentPriceUsd: 3000,
              lots: [
                {
                  lotId: "example-lot-1",
                  asset: "ETH",
                  quantity: 1,
                  costBasisUsd: 1800,
                  acquiredAt: "2024-06-01T00:00:00Z",
                  custodyLocation: "SELF_CUSTODY",
                },
              ],
            },
          },
          output: {
            type: "json",
            example: {
              planId: "plan_example",
              taxSavedUsd: 240,
              selectedLots: [{ lotId: "example-lot-1", gainOrLossUsd: 1200 }],
              accountingDossier: { format: "IRS_FORM_8949" },
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                body: {
                  type: "object",
                  required: ["jurisdiction", "regime", "targetAsset"],
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
                    currentPriceUsd: { type: "number" },
                    referrerWallet: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { paymentRequired, requirements };
}

/**
 * Builds the 1-parameter $0.01 USDC x402 v2 PaymentRequired challenge for `/api/v1/x402/tlh-scan`,
 * giving autonomous agents a $0.01 instant wallet TLH & tax-risk scanner entrypoint.
 */
export function buildTlhScanPaymentRequired(
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; requirements: PaymentRequirements } {
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount: usdToUsdcAtomic(0.01),
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      pricingModel: "flat-tlh-scan-0.01",
      affiliateRevsharePct: 0.2,
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: `${baseUrl}/api/v1/x402/tlh-scan`,
      description:
        "TaxRail $0.01 Multi-Asset Wallet Tax-Loss Harvesting (TLH) & IRS 1099-DA / Brazil Lei 14.754 Risk Scanner. Pass just a walletAddress (Base/Ethereum/Arbitrum) to scan all volatile tokens in the wallet, unrealized gains/losses, HIFO/SpecID savings, and unlockable planIds.",
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "GET",
            queryParams: {
              walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
              chain: "base",
              asset: "ALL",
              jurisdiction: "US",
            },
          },
          output: {
            type: "json",
            example: {
              status: "TLH_OPPORTUNITIES_FOUND",
              walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
              chain: "base",
              asset: "ALL",
              scannedAssets: ["ETH", "AERO"],
              assetBreakdown: [
                {
                  asset: "ETH",
                  lotsScanned: 12,
                  estimatedTaxSavingsUsd: 420,
                  planId: "plan_example_eth",
                },
              ],
              jurisdiction: "US",
              lotsScanned: 12,
              estimatedTaxSavingsUsd: 420,
              taxRiskScore: "MEDIUM",
              yearEndTlhDeadline: "2026-12-31",
              planId: "plan_example_eth",
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                queryParams: {
                  type: "object",
                  required: ["walletAddress"],
                  properties: {
                    walletAddress: {
                      type: "string",
                      description:
                        "EVM wallet address (0x...) to scan for year-end TLH opportunities and HIFO/SpecID tax savings",
                    },
                    chain: {
                      type: "string",
                      enum: ["base", "ethereum", "arbitrum"],
                    },
                    asset: { type: "string" },
                    jurisdiction: { type: "string", enum: ["US", "BR"] },
                    regime: { type: "string" },
                    referrerWallet: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { paymentRequired, requirements };
}

/**
 * Builds the 402 header + payload for GET probes on `/api/v1/x402/tlh-scan`.
 */
export function buildTlhScanProbePaymentRequired(
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; paymentRequiredHeader: string } {
  const { paymentRequired } = buildTlhScanPaymentRequired(env, requestUrl);
  return {
    paymentRequired,
    paymentRequiredHeader: encodePaymentRequiredHeader(paymentRequired),
  };
}

/**
 * Builds an x402 v2 PaymentRequired payload for the $0.01 pre-trade swap/sell tax check.
 * Designed for per-trade AI agent guardrails (HIFO vs FIFO, ST->LT cliff alert, Borrow-vs-Sell check).
 */
export function buildPreTradeCheckPaymentRequired(
  env: Env,
  requestUrl?: string
): {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
} {
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  const resourceUrl = `${baseUrl}/api/v1/x402/pre-trade-check`;
  const atomicAmount = usdToUsdcAtomic(0.01);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    amount: atomicAmount,
    asset,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      pricingModel: "FLAT_PRE_TRADE_CHECK_0_01_USD",
      service: "taxrail-pre-trade-check",
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "Payment required: $0.01 USDC on Base Mainnet for instant pre-trade tax guardrail check",
    resource: {
      url: resourceUrl,
      description:
        "Instant $0.01 USDC pre-trade tax check before executing any swap or sell: computes FIFO vs HIFO savings, warns on imminent Short-Term -> Long-Term tax cliffs, compares Aave v3 borrow-vs-sell, and returns an unlockable SpecID/calldata planId.",
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "GET",
            queryParams: {
              walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
              sellAsset: "ETH",
              sellAmount: "1",
              chain: "base",
              jurisdiction: "US",
            },
          },
          output: {
            type: "json",
            example: {
              status: "PRE_TRADE_OPTIMIZED",
              recommendation: "SELL_OPTIMIZED_HIFO",
              walletAddress: "0x849151d7D0bF1F34b70d5caD5149D28CC2308bf1",
              chain: "base",
              sellAsset: "ETH",
              sellAmount: 1,
              baselineTaxUsd: 680,
              optimizedTaxUsd: 140,
              taxSavedUsd: 540,
              longTermCliffWarning: null,
              planId: "plan_pretrade_example",
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                queryParams: {
                  type: "object",
                  required: ["walletAddress", "sellAsset", "sellAmount"],
                  properties: {
                    walletAddress: {
                      type: "string",
                      description: "EVM wallet address (0x...) holding the token to sell",
                    },
                    sellAsset: {
                      type: "string",
                      description: "Token symbol being sold or swapped (e.g. ETH, AERO, WBTC)",
                    },
                    sellAmount: {
                      type: "string",
                      description: "Positive token quantity to sell or swap",
                    },
                    chain: { type: "string", enum: ["base", "ethereum", "arbitrum"] },
                    jurisdiction: { type: "string", enum: ["US", "BR"] },
                    regime: { type: "string" },
                    referrerWallet: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { paymentRequired, requirements };
}

/**
 * Builds an x402 v2 PaymentRequired payload for the $0.005 Brazil R$35k / Lei 14.754 check.
 */
export function buildBr35kStatusPaymentRequired(
  env: Env,
  requestUrl?: string
): {
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
} {
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);
  const resourceUrl = `${baseUrl}/api/v1/x402/br-35k-status`;
  const atomicAmount = usdToUsdcAtomic(0.005);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    amount: atomicAmount,
    asset,
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      pricingModel: "FLAT_BR_35K_STATUS_0_005_USD",
      service: "taxrail-br-35k-status",
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error:
      "Payment required: $0.005 USDC on Base Mainnet for Brazil R$35k monthly exemption & Lei 14.754 check",
    resource: {
      url: resourceUrl,
      description:
        "Instant $0.005 USDC Brazil crypto tax compliance check: calculates remaining R$35,000 monthly domestic exemption room vs Lei 14.754 flat 15% offshore/DeFi tax and returns maximum tax-free sale size in USD.",
      mimeType: "application/json",
    },
    accepts: [requirements],
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "GET",
            queryParams: {
              monthlySalesBrl: "20000",
              plannedSaleUsd: "2500",
              custodyLocation: "DOMESTIC",
              usdBrlRate: "5.8",
            },
          },
          output: {
            type: "json",
            example: {
              status: "EXEMPT_UNDER_35K",
              custodyLocation: "DOMESTIC",
              monthlySalesBrl: 20000,
              plannedSaleBrl: 14500,
              projectedTotalBrl: 34500,
              thresholdBrl: 35000,
              remainingExemptBrl: 500,
              remainingExemptUsd: 86.21,
              wouldBreach35kThreshold: false,
              lei14754Applies: false,
              estimatedTaxRatePct: 0,
            },
          },
        },
        schema: {
          $schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: {
            input: {
              type: "object",
              properties: {
                queryParams: {
                  type: "object",
                  properties: {
                    monthlySalesBrl: {
                      type: "string",
                      description: "Total crypto sales already executed this calendar month in BRL",
                    },
                    plannedSaleUsd: {
                      type: "string",
                      description: "Planned next crypto sale or swap value in USD",
                    },
                    custodyLocation: {
                      type: "string",
                      enum: ["DOMESTIC", "OFFSHORE"],
                      description: "Brazil licensed exchange (DOMESTIC) vs DEX/self-custody/foreign CEX (OFFSHORE)",
                    },
                    usdBrlRate: {
                      type: "string",
                      description: "Optional USD/BRL FX rate override (defaults to 5.80)",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  return { paymentRequired, requirements };
}

/**
 * Shared verifier/settler for flat-priced x402 endpoints ($0.01 TLH scan & $0.10 quick optimize).
 */
async function verifyFlatX402Payment(params: {
  paymentHeader?: string | null;
  env: Env;
  paymentRequired: PaymentRequired;
  requirements: PaymentRequirements;
}): Promise<QuickOptimizePaymentResult> {
  const { paymentHeader, env, paymentRequired, requirements } = params;
  const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired);

  const trimmedHeader = paymentHeader?.trim();
  if (!trimmedHeader) {
    return {
      status: "payment_required",
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  if (
    env.X402_DEV_BYPASS_TOKEN &&
    trimmedHeader === `dev-bypass:${env.X402_DEV_BYPASS_TOKEN}`
  ) {
    return {
      status: "paid",
      settlementTx: "dev-bypass",
    };
  }

  const paymentPayload = parsePaymentPayload(trimmedHeader);
  if (!paymentPayload) {
    return {
      status: "invalid_payment",
      reason: "Malformed x402 payment signature header",
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  const outcome = await verifyAndSettleWithFacilitators({
    paymentPayload,
    requirements,
    env,
  });

  if (!outcome.ok) {
    return {
      status: outcome.kind,
      reason: outcome.reason,
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  return {
    status: "paid",
    settlementTx: outcome.settleResult.transaction,
    paymentResponseHeader: encodePaymentResponseHeader(outcome.settleResult),
  };
}

/**
 * Verifies & settles the 1-parameter $0.01 USDC x402 payment for `/api/v1/x402/tlh-scan`.
 */
export async function verifyTlhScanPayment(params: {
  paymentHeader?: string | null;
  env: Env;
  requestUrl?: string;
}): Promise<QuickOptimizePaymentResult> {
  const { paymentHeader, env, requestUrl } = params;
  const { paymentRequired, requirements } = buildTlhScanPaymentRequired(env, requestUrl);
  return verifyFlatX402Payment({ paymentHeader, env, paymentRequired, requirements });
}

/**
 * Verifies & settles the 1-step $0.10 USDC x402 payment before parsing/running the optimization.
 */
export async function verifyQuickOptimizePayment(params: {
  paymentHeader?: string | null;
  env: Env;
  requestUrl?: string;
}): Promise<QuickOptimizePaymentResult> {
  const { paymentHeader, env, requestUrl } = params;
  const { paymentRequired, requirements } = buildQuickOptimizePaymentRequired(env, requestUrl);
  return verifyFlatX402Payment({ paymentHeader, env, paymentRequired, requirements });
}

/**
 * Verifies & settles the $0.01 USDC x402 payment for `/api/v1/x402/pre-trade-check`.
 */
export async function verifyPreTradeCheckPayment(params: {
  paymentHeader?: string | null;
  env: Env;
  requestUrl?: string;
}): Promise<QuickOptimizePaymentResult> {
  const { paymentHeader, env, requestUrl } = params;
  const { paymentRequired, requirements } = buildPreTradeCheckPaymentRequired(env, requestUrl);
  return verifyFlatX402Payment({ paymentHeader, env, paymentRequired, requirements });
}

/**
 * Verifies & settles the $0.005 USDC x402 payment for `/api/v1/x402/br-35k-status`.
 */
export async function verifyBr35kStatusPayment(params: {
  paymentHeader?: string | null;
  env: Env;
  requestUrl?: string;
}): Promise<QuickOptimizePaymentResult> {
  const { paymentHeader, env, requestUrl } = params;
  const { paymentRequired, requirements } = buildBr35kStatusPaymentRequired(env, requestUrl);
  return verifyFlatX402Payment({ paymentHeader, env, paymentRequired, requirements });
}
