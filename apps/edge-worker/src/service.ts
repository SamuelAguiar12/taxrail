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
  AssetTlhSummary,
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
  fetchWalletPortfolioFromAlchemy,
  type PortfolioAssetLots,
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
  const requestedAsset = (params.asset || "ALL").trim().toUpperCase();
  const jurisdiction: Jurisdiction = params.jurisdiction ?? "US";
  const regime: TaxRegime =
    params.regime ?? (jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL");

  const rulesApplied =
    jurisdiction === "BR"
      ? ["BR_LEI_14754_15PCT", "BR_LOSS_CARRYFORWARD", "FIFO_VS_COST_AVG"]
      : ["US_IRS_1099_DA_PER_WALLET", "HIFO_SPEC_ID", "YEAR_END_TLH_2026"];

  const warnings: string[] = [];
  let portfolioAssets: PortfolioAssetLots[] = [];

  try {
    const portfolio = await fetchWalletPortfolioFromAlchemy({
      walletAddress: params.walletAddress,
      chain,
      targetAsset: requestedAsset,
      alchemyApiKey: deps.env.ALCHEMY_API_KEY,
    });
    portfolioAssets = portfolio.assets;
    warnings.push(...portfolio.warnings);
  } catch (err) {
    warnings.push(
      err instanceof Error ? err.message : "On-chain transfer scan returned no lots"
    );
  }

  if (portfolioAssets.length === 0) {
    let fallbackPriceUsd: number | null = null;
    let fallbackSource: "alchemy" | "coinbase" | "unavailable" = "unavailable";
    if (requestedAsset !== "ALL") {
      try {
        const spot = await fetchSpotPriceUsd(requestedAsset, deps.env.ALCHEMY_API_KEY);
        fallbackPriceUsd = spot.priceUsd;
        fallbackSource = spot.source;
      } catch {
        // Leave null price safely
      }
    }

    return {
      status: "NO_ELIGIBLE_LOTS_FOUND",
      walletAddress: params.walletAddress,
      chain,
      asset: requestedAsset,
      scannedAssets: [],
      assetBreakdown: [],
      currentPriceUsd: fallbackPriceUsd,
      priceSource: fallbackSource,
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
          "No incoming volatile token transfers detected on this chain or custody is elsewhere. Send explicit `lots` to FREE POST /api/v1/check-tax-impact (or POST /api/v1/x402/optimize) to simulate HIFO/SpecID & TLH savings.",
      },
      disclaimer:
        "Deterministic software calculation for tax planning, not legal or CPA advice.",
    };
  }

  const assetBreakdown: AssetTlhSummary[] = [];
  const combinedTlhOpportunities: WalletTlhScanResult["tlhOpportunities"] = [];
  let totalLotsScanned = 0;
  let totalQuantityAll = 0;
  let totalUnrealizedPnlUsd = 0;
  let totalEstimatedTaxSavingsUsd = 0;

  for (const item of portfolioAssets) {
    warnings.push(...item.warnings);
    if (item.lots.length === 0) continue;

    const assetQty = item.lots.reduce((sum, l) => sum + l.quantity, 0);
    let assetPnl = 0;
    const assetTlh: AssetTlhSummary["tlhOpportunities"] = [];

    for (const lot of item.lots) {
      const lotPnl = (item.currentPriceUsd - lot.costBasisUsd) * lot.quantity;
      assetPnl += lotPnl;
      if (lotPnl < -1) {
        const tlhEntry = {
          lotId: lot.lotId,
          acquiredAt: lot.acquiredAt,
          quantity: lot.quantity,
          costBasisUsd: lot.costBasisUsd,
          unrealizedLossUsd: Number(Math.abs(lotPnl).toFixed(2)),
        };
        assetTlh.push(tlhEntry);
        combinedTlhOpportunities.push(tlhEntry);
      }
    }

    const preview = await executeCheckTaxImpact(
      {
        jurisdiction,
        regime,
        chain,
        walletAddress: params.walletAddress,
        targetAsset: item.asset,
        sellQuantity: assetQty,
        currentPriceUsd: item.currentPriceUsd,
        lots: item.lots,
        ...(params.referrerWallet ? { referrerWallet: params.referrerWallet } : {}),
      },
      deps
    );
    warnings.push(...preview.warnings);

    totalLotsScanned += item.lots.length;
    totalQuantityAll += assetQty;
    totalUnrealizedPnlUsd += assetPnl;
    totalEstimatedTaxSavingsUsd += preview.taxSavedUsd;

    assetBreakdown.push({
      asset: item.asset,
      currentPriceUsd: item.currentPriceUsd,
      priceSource: item.priceSource,
      lotsScanned: item.lots.length,
      totalQuantity: Number(assetQty.toFixed(6)),
      unrealizedPnlUsd: Number(assetPnl.toFixed(2)),
      estimatedTaxSavingsUsd: preview.taxSavedUsd,
      recommendedStrategy: preview.recommendedStrategy,
      tlhOpportunities: assetTlh,
      planId: preview.planId,
      upfrontUnlockCostUsd: preview.pricing.upfrontX402Usd,
    });
  }

  assetBreakdown.sort((a, b) => {
    if (b.estimatedTaxSavingsUsd !== a.estimatedTaxSavingsUsd) {
      return b.estimatedTaxSavingsUsd - a.estimatedTaxSavingsUsd;
    }
    return b.tlhOpportunities.length - a.tlhOpportunities.length;
  });

  const primaryAsset = assetBreakdown[0]!;
  const unlockableAssets = assetBreakdown.filter((a) => a.estimatedTaxSavingsUsd > 0 && a.planId);
  const taxRiskScore: WalletTlhScanResult["taxRiskScore"] =
    totalEstimatedTaxSavingsUsd >= 500 || combinedTlhOpportunities.length >= 2
      ? "HIGH"
      : totalEstimatedTaxSavingsUsd > 0 || combinedTlhOpportunities.length > 0
        ? "MEDIUM"
        : "LOW";

  const multiAssetSummary =
    unlockableAssets.length > 1
      ? `Found tax savings across ${unlockableAssets.length} tokens (${unlockableAssets
          .map((a) => `${a.asset}: $${a.estimatedTaxSavingsUsd.toFixed(2)} -> ${a.planId}`)
          .join("; ")}). Unlock any plan via POST /api/v1/unlock-plan.`
      : primaryAsset.estimatedTaxSavingsUsd > 0
        ? `Executing unoptimized leaks $${totalEstimatedTaxSavingsUsd.toFixed(
            2
          )} in avoidable tax (${primaryAsset.asset}). Unlock full SpecID/HIFO lots, calldata & dossier via POST /api/v1/unlock-plan with {"planId":"${primaryAsset.planId}"} ($${(
            primaryAsset.upfrontUnlockCostUsd ?? 0
          ).toFixed(2)} USDC).`
        : `Unlock full execution dossier for $0.00 (FREE) via POST /api/v1/unlock-plan with {"planId":"${primaryAsset.planId}"}.`;

  return {
    status: combinedTlhOpportunities.length > 0 ? "TLH_OPPORTUNITIES_FOUND" : "SCAN_READY",
    walletAddress: params.walletAddress,
    chain,
    asset: requestedAsset,
    scannedAssets: assetBreakdown.map((a) => a.asset),
    assetBreakdown,
    currentPriceUsd: primaryAsset.currentPriceUsd,
    priceSource: primaryAsset.priceSource,
    jurisdiction,
    regime,
    lotsScanned: totalLotsScanned,
    totalQuantity: Number(totalQuantityAll.toFixed(6)),
    unrealizedPnlUsd: Number(totalUnrealizedPnlUsd.toFixed(2)),
    estimatedTaxSavingsUsd: Number(totalEstimatedTaxSavingsUsd.toFixed(2)),
    taxRiskScore,
    yearEndTlhDeadline: "2026-12-31",
    rulesApplied,
    tlhOpportunities: combinedTlhOpportunities,
    planId: primaryAsset.planId,
    upfrontUnlockCostUsd: primaryAsset.upfrontUnlockCostUsd,
    warnings,
    nextRecommendedAction: {
      action: "UNLOCK_PLAN",
      endpoint: "/api/v1/unlock-plan",
      planId: primaryAsset.planId,
      instruction: multiAssetSummary,
    },
    disclaimer:
      "Deterministic software calculation for tax planning, not legal or CPA advice.",
  };
}
