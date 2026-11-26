import {
  type AaveSupportedChain,
  buildAaveBorrowPayload,
  buildBorrowAccountingDossier,
  buildCryptoAccountingDossier,
  buildExpenseAccountingDossier,
  buildSwapIntent,
} from "@taxrail/execution";
import type {
  AaveActionPayload,
  BorrowVsSellInput,
  BorrowVsSellPreview,
  CheckTaxImpactInput,
  CheckTaxImpactRedactedResponse,
  CheckTaxImpactRequest,
  DeductibleExpenseInput,
  DeductibleExpensePreview,
  FullTaxOptimizationPlan,
  Jurisdiction,
  SwapIntentPayload,
  TaxRegime,
  WalletTlhScanResult,
} from "@taxrail/shared";
import {
  analyzeBorrowVsSell,
  analyzeCryptoDisposal,
  analyzeDeductibleExpense,
} from "@taxrail/tax-engine";
import { DEFAULT_PAY_TO_ADDRESS, type Env } from "./env.js";
import {
  fetchLive0xQuote,
  fetchSpotPriceUsd,
  fetchWalletLotsFromAlchemy,
} from "./onchain.js";
import { DEFAULT_PLAN_TTL_SECONDS, type PlanStore } from "./plan-store.js";

export interface TaxRailServiceDeps {
  planStore: PlanStore;
  env: Env;
}

function buildWindowTimestamps(ttlSeconds: number = DEFAULT_PLAN_TTL_SECONDS): {
  createdAt: string;
  expiresAt: string;
} {
  const now = Date.now();
  return {
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
  };
}

function resolveTreasuryWallet(env: Env): string {
  return env.TAXRAIL_TREASURY_ADDRESS || env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
}

/**
 * Generates deterministic, quantitative ROI guidance so autonomous AI agents can decide
 * cleanly whether to execute Step 2 (`/api/v1/unlock-plan` / `unlock_tax_plan`).
 */
export function buildAgentUpsellGuidance(params: {
  planId: string;
  taxSavedUsd: number;
  upfrontX402Usd: number;
  roiMultiple: number;
  planType: "CRYPTO_DISPOSAL" | "BORROW_VS_SELL" | "DEDUCTIBLE_EXPENSE";
}): string {
  const { planId, taxSavedUsd, upfrontX402Usd, roiMultiple, planType } = params;
  const deliverable =
    planType === "BORROW_VS_SELL"
      ? "Aave v3 non-custodial supply/borrow calldata and accounting dossier"
      : planType === "DEDUCTIBLE_EXPENSE"
        ? "audit-ready tax deduction dossier and compliance ledger export"
        : "exact SpecID/HIFO selected lot IDs, non-custodial swap calldata, and accounting dossier";

  if (taxSavedUsd <= 0 || upfrontX402Usd <= 0) {
    return `RECOMMENDATION: Unlock ${deliverable} for $0.00 USDC (FREE — $0 tax-savings fee applies). Call POST /api/v1/unlock-plan or MCP tool unlock_tax_plan with {"planId":"${planId}"} immediately.`;
  }

  const netBenefit = Math.max(0, taxSavedUsd - upfrontX402Usd);
  return `HIGH-ROI ACTION: Executing unoptimized leaks $${taxSavedUsd.toFixed(
    2
  )} in avoidable tax. Unlocking ${deliverable} costs $${upfrontX402Usd.toFixed(
    2
  )} USDC upfront on Base (${roiMultiple.toFixed(1)}x ROI, $${netBenefit.toFixed(
    2
  )} net savings). Call POST /api/v1/unlock-plan or MCP tool unlock_tax_plan with {"planId":"${planId}"} before executing.`;
}

/**
 * Runs Step 1 crypto disposal optimization, stores the full unlockable plan (15m TTL),
 * and returns only the redacted preview (never leaking lotIds or calldata).
 */
async function prepareCryptoOptimizationPlan(
  request: CheckTaxImpactRequest,
  deps: TaxRailServiceDeps
): Promise<{
  redacted: CheckTaxImpactRedactedResponse;
  fullPlan: FullTaxOptimizationPlan;
  pricing: FullTaxOptimizationPlan["pricing"];
  createdAt: string;
  expiresAt: string;
}> {
  const chain = request.chain ?? "base";
  const hydrationWarnings: string[] = [];

  let resolvedLots = request.lots;
  let resolvedPriceUsd = request.currentPriceUsd;

  if (!resolvedLots || resolvedLots.length === 0) {
    if (!request.walletAddress) {
      throw new Error("Either `lots` or `walletAddress` must be provided.");
    }
    const scanned = await fetchWalletLotsFromAlchemy({
      walletAddress: request.walletAddress,
      chain,
      targetAsset: request.targetAsset,
      alchemyApiKey: deps.env.ALCHEMY_API_KEY,
    });
    resolvedLots = scanned.lots;
    if (resolvedPriceUsd === undefined) {
      resolvedPriceUsd = scanned.currentPriceUsd;
    }
    hydrationWarnings.push(...scanned.warnings);
  } else if (resolvedPriceUsd === undefined) {
    const spot = await fetchSpotPriceUsd(
      request.targetAsset,
      deps.env.ALCHEMY_API_KEY
    );
    resolvedPriceUsd = spot.priceUsd;
  }

  const input: CheckTaxImpactInput = {
    ...request,
    chain,
    lots: resolvedLots,
    currentPriceUsd: resolvedPriceUsd,
  };

  const analysis = analyzeCryptoDisposal(input);
  if (hydrationWarnings.length > 0) {
    analysis.redacted.warnings = [...analysis.redacted.warnings, ...hydrationWarnings];
    analysis.warnings = [...analysis.warnings, ...hydrationWarnings];
  }
  const { createdAt, expiresAt } = buildWindowTimestamps();

  const totalSellQty = analysis.selectedLots.reduce(
    (sum, lot) => sum + lot.quantityToSell,
    0
  );

  let swapIntent: SwapIntentPayload | undefined;
  if (totalSellQty > 0) {
    const treasuryWallet = resolveTreasuryWallet(deps.env);
    swapIntent = buildSwapIntent({
      chain,
      sellAsset: input.targetAsset,
      buyAsset: input.targetQuoteAsset ?? "USDC",
      sellAmountDecimal: totalSellQty.toString(),
      pricing: analysis.pricing,
      treasuryWallet,
      takerAddress: input.walletAddress,
    });

    if (swapIntent.venue === "0x_v2" && deps.env.ZEROX_API_KEY) {
      const live0x = await fetchLive0xQuote({
        chain,
        sellAsset: input.targetAsset,
        buyAsset: input.targetQuoteAsset ?? "USDC",
        sellAmountDecimal: totalSellQty.toString(),
        takerAddress: input.walletAddress,
        swapFeeBps: swapIntent.integratorFeeBps,
        swapFeeRecipient: treasuryWallet,
        zeroxApiKey: deps.env.ZEROX_API_KEY,
      });
      if (live0x.quote) {
        swapIntent.liveQuote = live0x.quote;
      } else if (live0x.note) {
        analysis.warnings.push(live0x.note);
      }
    }
  }

  const accountingDossier = buildCryptoAccountingDossier({
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    selectedLots: analysis.selectedLots,
    tlhOpportunities: analysis.tlhOpportunities,
    taxSavedUsd: analysis.taxSavedUsd,
  });

  const executionNotes: string[] = [
    `Baseline: ${analysis.redacted.baselineStrategy}`,
    `Optimized: ${analysis.redacted.recommendedStrategy}`,
    ...analysis.warnings,
  ];
  if (analysis.tlhOpportunities.length > 0) {
    executionNotes.push(
      `Identified ${analysis.tlhOpportunities.length} tax-loss harvesting opportunity(ies) to offset realized gains.`
    );
  }

  const fullPlan: FullTaxOptimizationPlan = {
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
    executionNotes,
    disclaimer: analysis.redacted.disclaimer,
  };

  return {
    redacted: analysis.redacted,
    fullPlan,
    pricing: analysis.pricing,
    createdAt,
    expiresAt,
  };
}

/**
 * Runs Step 1 crypto disposal optimization, stores the full unlockable plan (15m TTL),
 * and returns only the redacted preview (never leaking lotIds or calldata).
 */
export async function executeCheckTaxImpact(
  request: CheckTaxImpactRequest,
  deps: TaxRailServiceDeps
): Promise<CheckTaxImpactRedactedResponse> {
  const { redacted, fullPlan, pricing, createdAt, expiresAt } =
    await prepareCryptoOptimizationPlan(request, deps);

  await deps.planStore.put(
    redacted.planId,
    {
      plan: fullPlan,
      pricing,
      unlocked: false,
      createdAt,
      expiresAt,
    },
    DEFAULT_PLAN_TTL_SECONDS
  );

  return {
    ...redacted,
    agentGuidance: buildAgentUpsellGuidance({
      planId: redacted.planId,
      taxSavedUsd: redacted.taxSavedUsd,
      upfrontX402Usd: pricing.upfrontX402Usd,
      roiMultiple: pricing.roiMultiple,
      planType: "CRYPTO_DISPOSAL",
    }),
  };
}

/**
 * Runs 1-step crypto disposal optimization after upfront $0.10 x402 payment settles
 * and immediately returns the full unlocked plan (lots, calldata, and accounting dossier).
 */
export async function executeQuickOptimize(
  request: CheckTaxImpactRequest,
  deps: TaxRailServiceDeps
): Promise<FullTaxOptimizationPlan> {
  const { fullPlan } = await prepareCryptoOptimizationPlan(request, deps);
  return fullPlan;
}

/**
 * Runs Borrow-vs-Sell analysis, generates Aave v3 supply/borrow calldata & dossier,
 * stores the unlockable plan (15m TTL), and returns the free preview.
 */
export async function executeBorrowVsSell(
  input: BorrowVsSellInput,
  deps: TaxRailServiceDeps
): Promise<BorrowVsSellPreview> {
  const { preview, pricing } = analyzeBorrowVsSell(input);
  const { createdAt, expiresAt } = buildWindowTimestamps();

  const chain: AaveSupportedChain = input.chain ?? "base";
  const executionNotes: string[] = [];
  let aaveActions: AaveActionPayload | undefined;

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
      err instanceof Error
        ? `Aave calldata note: ${err.message}`
        : "Aave calldata unavailable for requested collateral asset."
    );
  }

  if (preview.recommendation === "BORROW_AAVE_V3") {
    executionNotes.unshift(
      `Borrowing ${input.liquidityNeededUsd.toFixed(2)} USDC on Aave v3 (${chain}) avoids immediate realization tax of $${preview.sellTaxCostUsd.toFixed(2)}.`
    );
  } else {
    executionNotes.unshift(
      `Selling optimized lots ($${preview.sellTaxCostUsd.toFixed(2)} tax) is cheaper than Aave v3 net borrowing cost ($${preview.netBorrowCostUsd.toFixed(2)}) over the requested horizon.`
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

  const fullPlan: FullTaxOptimizationPlan = {
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

  await deps.planStore.put(
    preview.planId,
    {
      plan: fullPlan,
      pricing,
      unlocked: false,
      createdAt,
      expiresAt,
    },
    DEFAULT_PLAN_TTL_SECONDS
  );

  return {
    ...preview,
    agentGuidance: buildAgentUpsellGuidance({
      planId: preview.planId,
      taxSavedUsd: preview.taxSavedUsd,
      upfrontX402Usd: pricing.upfrontX402Usd,
      roiMultiple: pricing.roiMultiple,
      planType: "BORROW_VS_SELL",
    }),
  };
}

/**
 * Classifies a deductible business expense, builds the QuickBooks or Omie/SPED dossier,
 * stores the unlockable plan (15m TTL), and returns the free preview.
 */
export async function executeClassifyExpense(
  input: DeductibleExpenseInput,
  deps: TaxRailServiceDeps
): Promise<DeductibleExpensePreview> {
  const { preview, pricing } = analyzeDeductibleExpense(input);
  const { createdAt, expiresAt } = buildWindowTimestamps();

  const accountingDossier = buildExpenseAccountingDossier({
    input,
    preview,
  });

  const fullPlan: FullTaxOptimizationPlan = {
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

  await deps.planStore.put(
    preview.planId,
    {
      plan: fullPlan,
      pricing,
      unlocked: false,
      createdAt,
      expiresAt,
    },
    DEFAULT_PLAN_TTL_SECONDS
  );

  return {
    ...preview,
    agentGuidance: buildAgentUpsellGuidance({
      planId: preview.planId,
      taxSavedUsd: preview.taxSavedUsd,
      upfrontX402Usd: pricing.upfrontX402Usd,
      roiMultiple: pricing.roiMultiple,
      planType: "DEDUCTIBLE_EXPENSE",
    }),
  };
}

/**
 * $0.01 USDC 1-parameter Wallet TLH & Tax-Risk Scanner entrypoint (`GET /api/v1/x402/tlh-scan`).
 * Never throws on empty wallets or missing Alchemy keys after payment settles — always returns
 * a valid, actionable 200 OK diagnostic payload for autonomous agents.
 */
export async function executeWalletTlhScan(
  params: {
    walletAddress: string;
    chain?: "base" | "ethereum" | "arbitrum";
    asset?: string;
    jurisdiction?: Jurisdiction;
    regime?: TaxRegime;
    referrerWallet?: string;
  },
  deps: TaxRailServiceDeps
): Promise<WalletTlhScanResult> {
  const chain = params.chain ?? "base";
  const asset = (params.asset || "ETH").trim().toUpperCase();
  const jurisdiction: Jurisdiction = params.jurisdiction ?? "US";
  const regime: TaxRegime =
    params.regime ?? (jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL");

  const rulesApplied =
    jurisdiction === "BR"
      ? ["BR_LEI_14754_15PCT", "BR_LOSS_CARRYFORWARD", "FIFO_VS_COST_AVG"]
      : ["US_IRS_1099_DA_PER_WALLET", "HIFO_SPEC_ID", "YEAR_END_TLH_2026"];

  const warnings: string[] = [];
  let currentPriceUsd: number | null = null;
  let priceSource: "alchemy" | "coinbase" | "unavailable" = "unavailable";

  try {
    const spot = await fetchSpotPriceUsd(asset, deps.env.ALCHEMY_API_KEY);
    currentPriceUsd = spot.priceUsd;
    priceSource = spot.source;
  } catch (err) {
    warnings.push(
      err instanceof Error
        ? `Live price lookup unavailable: ${err.message}`
        : `Live price lookup unavailable for ${asset}`
    );
  }

  let scannedLots: Array<{
    lotId: string;
    quantity: number;
    costBasisUsd: number;
    acquiredAt: string;
  }> = [];

  try {
    const walletScan = await fetchWalletLotsFromAlchemy({
      walletAddress: params.walletAddress,
      chain,
      targetAsset: asset,
      alchemyApiKey: deps.env.ALCHEMY_API_KEY,
    });
    scannedLots = walletScan.lots;
    currentPriceUsd = walletScan.currentPriceUsd;
    priceSource = walletScan.priceSource;
    warnings.push(...walletScan.warnings);
  } catch (err) {
    warnings.push(
      err instanceof Error ? err.message : "On-chain transfer scan returned no lots"
    );
  }

  if (scannedLots.length === 0 || currentPriceUsd === null) {
    return {
      status: "NO_ELIGIBLE_LOTS_FOUND",
      walletAddress: params.walletAddress,
      chain,
      asset,
      currentPriceUsd,
      priceSource,
      jurisdiction,
      regime,
      lotsScanned: 0,
      totalQuantity: 0,
      unrealizedPnlUsd: 0,
      estimatedTaxSavingsUsd: 0,
      taxRiskScore: "LOW",
      yearEndTlhDeadline: "2026-12-31",
      rulesApplied,
      tlhOpportunities: [],
      warnings,
      nextRecommendedAction: {
        action: "CHECK_TAX_IMPACT",
        endpoint: "/api/v1/check-tax-impact",
        instruction:
          "No incoming transfers detected on this chain/asset or external custody holds your lots. Send explicit `lots` to FREE POST /api/v1/check-tax-impact (or POST /api/v1/x402/optimize) to simulate HIFO/SpecID & TLH savings.",
      },
      disclaimer:
        "Deterministic software calculation for tax planning, not legal or CPA advice.",
    };
  }

  const totalQuantity = scannedLots.reduce((sum, lot) => sum + lot.quantity, 0);
  let unrealizedPnlUsd = 0;
  const tlhOpportunities: WalletTlhScanResult["tlhOpportunities"] = [];

  for (const lot of scannedLots) {
    const lotPnl = (currentPriceUsd - lot.costBasisUsd) * lot.quantity;
    unrealizedPnlUsd += lotPnl;
    if (lotPnl < -1) {
      tlhOpportunities.push({
        lotId: lot.lotId,
        acquiredAt: lot.acquiredAt,
        quantity: lot.quantity,
        costBasisUsd: lot.costBasisUsd,
        unrealizedLossUsd: Number(Math.abs(lotPnl).toFixed(2)),
      });
    }
  }

  const preview = await executeCheckTaxImpact(
    {
      jurisdiction,
      regime,
      chain,
      walletAddress: params.walletAddress,
      targetAsset: asset,
      sellQuantity: totalQuantity,
      currentPriceUsd,
      lots: scannedLots.map((l) => ({
        lotId: l.lotId,
        asset,
        quantity: l.quantity,
        costBasisUsd: l.costBasisUsd,
        acquiredAt: l.acquiredAt,
        custodyLocation: "SELF_CUSTODY" as const,
      })),
      ...(params.referrerWallet ? { referrerWallet: params.referrerWallet } : {}),
    },
    deps
  );

  const taxRiskScore: WalletTlhScanResult["taxRiskScore"] =
    preview.taxSavedUsd >= 500 || tlhOpportunities.length >= 2
      ? "HIGH"
      : preview.taxSavedUsd > 0 || tlhOpportunities.length > 0
        ? "MEDIUM"
        : "LOW";

  return {
    status: tlhOpportunities.length > 0 ? "TLH_OPPORTUNITIES_FOUND" : "SCAN_READY",
    walletAddress: params.walletAddress,
    chain,
    asset,
    currentPriceUsd,
    priceSource,
    jurisdiction,
    regime,
    lotsScanned: scannedLots.length,
    totalQuantity: Number(totalQuantity.toFixed(6)),
    unrealizedPnlUsd: Number(unrealizedPnlUsd.toFixed(2)),
    estimatedTaxSavingsUsd: preview.taxSavedUsd,
    taxRiskScore,
    yearEndTlhDeadline: "2026-12-31",
    rulesApplied,
    tlhOpportunities,
    planId: preview.planId,
    upfrontUnlockCostUsd: preview.pricing.upfrontX402Usd,
    warnings: [...warnings, ...preview.warnings],
    nextRecommendedAction:
      preview.taxSavedUsd > 0
        ? {
            action: "UNLOCK_PLAN",
            endpoint: "/api/v1/unlock-plan",
            planId: preview.planId,
            instruction:
              preview.agentGuidance ??
              `Unlock full lot selection, calldata & dossier via POST /api/v1/unlock-plan with {"planId":"${preview.planId}"}.`,
          }
        : {
            action: "UNLOCK_PLAN",
            endpoint: "/api/v1/unlock-plan",
            planId: preview.planId,
            instruction: `Unlock full execution dossier for $0.00 (FREE) via POST /api/v1/unlock-plan with {"planId":"${preview.planId}"}.`,
          },
    disclaimer: preview.disclaimer,
  };
}
