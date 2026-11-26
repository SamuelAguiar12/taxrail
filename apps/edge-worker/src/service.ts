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
  Br35kStatusResult,
  CheckTaxImpactInput,
  CheckTaxImpactRedactedResponse,
  CheckTaxImpactRequest,
  ClaimDossierInput,
  ClaimDossierResponse,
  DeductibleExpenseInput,
  DeductibleExpensePreview,
  FullTaxOptimizationPlan,
  Jurisdiction,
  PrepareExecutionInput,
  PrepareExecutionResponse,
  PreTradeCheckResult,
  SwapIntentPayload,
  TaxLot,
  TaxRegime,
  WalletTlhScanResult,
} from "@taxrail/shared";
import {
  analyzeBorrowVsSell,
  analyzeCryptoDisposal,
  analyzeDeductibleExpense,
} from "@taxrail/tax-engine";
import { EVM_TOKEN_REGISTRY } from "@taxrail/execution";
import { DEFAULT_PAY_TO_ADDRESS, type Env } from "./env.js";
import { recordPaidReceipt } from "./feedback.js";
import {
  fetchLive0xQuote,
  fetchSpotPriceUsd,
  fetchWalletLotsFromAlchemy,
  fetchWalletPortfolioFromAlchemy,
  getExplorerTxUrl,
  resolveZeroXTokenInfo,
  verifyOperationFeeReceipt,
  type PortfolioAssetLots,
} from "./onchain.js";
import {
  DEFAULT_PLAN_TTL_SECONDS,
  type ExecutionVerificationMeta,
  type PlanStore,
} from "./plan-store.js";

export interface TaxRailServiceDeps {
  planStore: PlanStore;
  env: Env;
  skipLive0xQuote?: boolean;
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
  operationFeeUsd?: number;
  roiMultiple: number;
  planType: "CRYPTO_DISPOSAL" | "BORROW_VS_SELL" | "DEDUCTIBLE_EXPENSE";
}): string {
  const { planId, taxSavedUsd, upfrontX402Usd, operationFeeUsd = 0, roiMultiple, planType } = params;
  const deliverable =
    planType === "BORROW_VS_SELL"
      ? "Aave v3 non-custodial supply/borrow batch and accounting dossier"
      : planType === "DEDUCTIBLE_EXPENSE"
        ? "audit-ready tax deduction dossier and compliance ledger export"
        : "exact SpecID/HIFO selected lot IDs, non-custodial swap calldata, and accounting dossier";

  if (taxSavedUsd <= 0 || (upfrontX402Usd <= 0 && operationFeeUsd <= 0)) {
    return `RECOMMENDATION: Unlock ${deliverable} for $0.00 USDC (FREE — $0 tax-savings fee applies). Call POST /api/v1/unlock-plan or MCP tool unlock_tax_plan with {"planId":"${planId}"} immediately.`;
  }

  const totalFee = operationFeeUsd > 0 ? operationFeeUsd : upfrontX402Usd;
  const netBenefit = Math.max(0, taxSavedUsd - totalFee);
  if (planType !== "DEDUCTIBLE_EXPENSE") {
    return `HIGH-ROI ACTION ($0 UPFRONT): Executing unoptimized leaks $${taxSavedUsd.toFixed(
      2
    )} in avoidable tax. Pay 10% ($${totalFee.toFixed(
      2
    )}) directly from the operation (${roiMultiple.toFixed(1)}x ROI, $${netBenefit.toFixed(
      2
    )} net savings): call POST /api/v1/prepare-execution with {"planId":"${planId}"}, sign the 1-click tx, then call POST /api/v1/claim-dossier to unlock ${deliverable} — or unlock dossier-only via POST /api/v1/unlock-plan ($${upfrontX402Usd.toFixed(
      2
    )} x402 Base USDC).`;
  }

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

    if (swapIntent.venue === "0x_v2" && deps.env.ZEROX_API_KEY && !deps.skipLive0xQuote) {
      const live0x = await fetchLive0xQuote({
        chain,
        sellAsset: input.targetAsset,
        buyAsset: input.targetQuoteAsset ?? "USDC",
        sellAmountDecimal: totalSellQty.toString(),
        takerAddress: input.walletAddress,
        swapFeeBps: swapIntent.integratorFeeBps,
        swapFeeRecipient: treasuryWallet,
        affiliateWallet: analysis.pricing.affiliateWallet,
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
      operationFeeUsd: pricing.operationFeeUsd,
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
      feeAmountUsd: pricing.operationFeeUsd,
      treasuryWallet: resolveTreasuryWallet(deps.env),
      affiliateWallet: input.referrerWallet,
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
      operationFeeUsd: pricing.operationFeeUsd,
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
      { ...deps, skipLive0xQuote: true }
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

/**
 * Executes the $0.01 USDC pre-trade swap/sell guardrail check (`GET|POST /api/v1/x402/pre-trade-check`).
 * Reconstructs wallet lots (when not explicitly provided), computes HIFO vs FIFO tax savings,
 * flags imminent Short-Term -> Long-Term tax cliffs, and compares Aave v3 borrow-vs-sell.
 */
export async function executePreTradeCheck(
  params: {
    walletAddress: string;
    sellAsset: string;
    sellAmount: number;
    chain?: "base" | "ethereum" | "arbitrum";
    jurisdiction?: Jurisdiction;
    regime?: TaxRegime;
    referrerWallet?: string;
    currentPriceUsd?: number;
    lots?: TaxLot[];
  },
  deps: TaxRailServiceDeps
): Promise<PreTradeCheckResult> {
  const chain = params.chain ?? "base";
  const jurisdiction: Jurisdiction = params.jurisdiction ?? "US";
  const regime: TaxRegime =
    params.regime ?? (jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL");
  const sellAsset = params.sellAsset.trim().toUpperCase();
  const warnings: string[] = [];

  let resolvedLots: TaxLot[] = params.lots ? [...params.lots] : [];
  let currentPriceUsd: number | null =
    typeof params.currentPriceUsd === "number" && params.currentPriceUsd > 0
      ? params.currentPriceUsd
      : null;

  if (resolvedLots.length === 0) {
    const portfolio = await fetchWalletPortfolioFromAlchemy({
      walletAddress: params.walletAddress,
      chain,
      targetAsset: sellAsset,
      alchemyApiKey: deps.env.ALCHEMY_API_KEY,
    });
    warnings.push(...portfolio.warnings);

    const matchedAsset = portfolio.assets.find(
      (item) => item.asset.toUpperCase() === sellAsset
    );
    if (matchedAsset) {
      resolvedLots = matchedAsset.lots;
      if (currentPriceUsd === null && matchedAsset.currentPriceUsd !== null && matchedAsset.currentPriceUsd > 0) {
        currentPriceUsd = matchedAsset.currentPriceUsd;
      }
    }
  }

  if (currentPriceUsd === null) {
    const spot = await fetchSpotPriceUsd(sellAsset, deps.env.ALCHEMY_API_KEY);
    if (spot.priceUsd !== null) {
      currentPriceUsd = spot.priceUsd;
    } else {
      warnings.push(`Live spot price unavailable for ${sellAsset} on ${chain}`);
    }
  }

  if (resolvedLots.length === 0 || currentPriceUsd === null || currentPriceUsd <= 0) {
    return {
      status: "NEEDS_LOT_HISTORY",
      recommendation: "PROVIDE_EXPLICIT_LOTS",
      walletAddress: params.walletAddress,
      chain,
      sellAsset,
      sellAmount: params.sellAmount,
      currentPriceUsd,
      jurisdiction,
      regime,
      lotsScanned: 0,
      baselineTaxUsd: 0,
      optimizedTaxUsd: 0,
      taxSavedUsd: 0,
      longTermCliffWarning: null,
      warnings:
        warnings.length > 0
          ? warnings
          : [
              `No historical lots or price oracle entry found for ${sellAsset} on ${chain}. Pass explicit lots via POST /api/v1/check-tax-impact.`,
            ],
      agentGuidance:
        "Lot history was unavailable on this chain; pass explicit tax lots via POST /api/v1/check-tax-impact to unlock SpecID savings.",
      disclaimer:
        "Deterministic software calculation for tax planning, not legal or CPA advice.",
    };
  }

  const preview = await executeCheckTaxImpact(
    {
      jurisdiction,
      regime,
      chain,
      walletAddress: params.walletAddress,
      targetAsset: sellAsset,
      sellQuantity: params.sellAmount,
      currentPriceUsd,
      lots: resolvedLots,
      ...(params.referrerWallet ? { referrerWallet: params.referrerWallet } : {}),
    },
    { ...deps, skipLive0xQuote: true }
  );
  warnings.push(...preview.warnings);

  // Detect imminent US Short-Term -> Long-Term cliff (held 305..364 days)
  let longTermCliffWarning: string | null = null;
  if (jurisdiction === "US") {
    const nowMs = Date.now();
    const soonest = resolvedLots
      .map((lot) => {
        const heldDays = (nowMs - Date.parse(lot.acquiredAt)) / 86_400_000;
        const daysRemaining = Math.ceil(366 - heldDays);
        return { lot, heldDays, daysRemaining };
      })
      .filter((entry) => entry.heldDays >= 305 && entry.heldDays < 366 && entry.lot.costBasisUsd < currentPriceUsd!)
      .sort((a, b) => a.daysRemaining - b.daysRemaining)[0];

    if (soonest) {
      longTermCliffWarning = `Lot ${soonest.lot.lotId} reaches 366-day US Long-Term Capital Gains eligibility in ${soonest.daysRemaining} day(s) — holding drops federal tax rate sharply vs short-term ordinary rates.`;
    }
  }

  // Compare Aave v3 Borrow-vs-Sell when selling creates meaningful tax liability
  const disposalNotionalUsd = params.sellAmount * currentPriceUsd;
  let borrowVsSellComparison: PreTradeCheckResult["borrowVsSellComparison"];
  let borrowPlanId: string | undefined;

  if (preview.optimizedTaxUsd >= 50 && disposalNotionalUsd >= 200) {
    const lowestBasisLot = [...resolvedLots].sort(
      (a, b) => a.costBasisUsd - b.costBasisUsd
    )[0]!;
    const borrowPreview = await executeBorrowVsSell(
      {
        jurisdiction,
        regime,
        chain: chain === "base" || chain === "ethereum" || chain === "arbitrum" ? chain : "base",
        collateralAsset: sellAsset,
        collateralAmount: params.sellAmount * 2,
        collateralPriceUsd: currentPriceUsd,
        collateralCostBasisUsd: lowestBasisLot.costBasisUsd,
        liquidityNeededUsd: Number(disposalNotionalUsd.toFixed(2)),
        holdingDays: 365,
        horizonDays: 90,
        ...(params.referrerWallet ? { referrerWallet: params.referrerWallet } : {}),
      },
      deps
    );
    borrowVsSellComparison = {
      recommendation: borrowPreview.recommendation,
      sellTaxCostUsd: borrowPreview.sellTaxCostUsd,
      netBorrowCostUsd: borrowPreview.netBorrowCostUsd,
      taxSavedUsd: borrowPreview.taxSavedUsd,
      projectedLtvPct: borrowPreview.projectedLtvPct,
    };
    borrowPlanId = borrowPreview.planId;
  }

  let recommendation: PreTradeCheckResult["recommendation"] = "SELL_OPTIMIZED_HIFO";
  let status: PreTradeCheckResult["status"] = "PRE_TRADE_OPTIMIZED";

  if (longTermCliffWarning && preview.optimizedTaxUsd > 25) {
    recommendation = "WAIT_FOR_LONG_TERM";
    status = "WAIT_FOR_LONG_TERM";
  } else if (borrowVsSellComparison?.recommendation === "BORROW_AAVE_V3") {
    recommendation = "BORROW_AAVE_V3";
    status = "BORROW_PREFERRED";
  } else if (preview.baselineTaxUsd <= 0 && preview.optimizedTaxUsd <= 0) {
    recommendation = "SELL_ZERO_TAX";
    status = "NO_TAX_IMPACT";
  }

  const agentGuidance =
    recommendation === "WAIT_FOR_LONG_TERM"
      ? `${longTermCliffWarning} Or unlock SpecID HIFO swap plan ${preview.planId} ($${preview.pricing.upfrontX402Usd.toFixed(2)} USDC) to save $${preview.taxSavedUsd.toFixed(2)} if you must sell today.`
      : recommendation === "BORROW_AAVE_V3" && borrowVsSellComparison
        ? `Do NOT sell ${params.sellAmount} ${sellAsset}: selling triggers ~$${borrowVsSellComparison.sellTaxCostUsd.toFixed(2)} tax while Aave v3 borrow nets ~$${borrowVsSellComparison.netBorrowCostUsd.toFixed(2)} (saves $${borrowVsSellComparison.taxSavedUsd.toFixed(2)}). Unlock borrowPlanId ${borrowPlanId} or swap planId ${preview.planId}.`
        : preview.taxSavedUsd > 0
          ? `HIFO/SpecID cuts tax from $${preview.baselineTaxUsd.toFixed(2)} to $${preview.optimizedTaxUsd.toFixed(2)} (saving $${preview.taxSavedUsd.toFixed(2)}). Unlock exact lot IDs & 0x calldata via POST /api/v1/unlock-plan {"planId":"${preview.planId}"} ($${preview.pricing.upfrontX402Usd.toFixed(2)} USDC).`
          : `No taxable gain leaked on ${params.sellAmount} ${sellAsset}. Unlock compliance dossier FREE ($0.00) with planId ${preview.planId}.`;

  return {
    status,
    recommendation,
    walletAddress: params.walletAddress,
    chain,
    sellAsset,
    sellAmount: params.sellAmount,
    currentPriceUsd,
    jurisdiction,
    regime,
    lotsScanned: resolvedLots.length,
    baselineTaxUsd: preview.baselineTaxUsd,
    optimizedTaxUsd: preview.optimizedTaxUsd,
    taxSavedUsd: preview.taxSavedUsd,
    longTermCliffWarning,
    ...(borrowVsSellComparison ? { borrowVsSellComparison } : {}),
    planId: preview.planId,
    ...(borrowPlanId ? { borrowPlanId } : {}),
    upfrontUnlockCostUsd: preview.pricing.upfrontX402Usd,
    warnings,
    agentGuidance,
    disclaimer:
      "Deterministic software calculation for tax planning, not legal or CPA advice.",
  };
}

/**
 * Computes Brazil R$35,000 monthly domestic exemption status vs Lei 14.754/2023 15% flat offshore tax
 * (`GET|POST /api/v1/x402/br-35k-status`, $0.005 USDC).
 */
export function executeBr35kStatus(params: {
  monthlySalesBrl: number;
  plannedSaleUsd: number;
  custodyLocation: "DOMESTIC" | "OFFSHORE";
  usdBrlRate?: number;
  estimatedGainMarginPct?: number;
}): Br35kStatusResult {
  const usdBrlRate =
    typeof params.usdBrlRate === "number" && params.usdBrlRate > 0 ? params.usdBrlRate : 5.8;
  const thresholdBrl = 35_000;
  const monthlySalesBrl = Math.max(0, Number(params.monthlySalesBrl.toFixed(2)));
  const plannedSaleBrl = Math.max(0, Number((params.plannedSaleUsd * usdBrlRate).toFixed(2)));
  const projectedTotalBrl = Number((monthlySalesBrl + plannedSaleBrl).toFixed(2));
  const gainMargin =
    typeof params.estimatedGainMarginPct === "number" &&
    params.estimatedGainMarginPct > 0 &&
    params.estimatedGainMarginPct <= 100
      ? params.estimatedGainMarginPct / 100
      : 0.35;

  if (params.custodyLocation === "OFFSHORE") {
    const estimatedTaxIfSoldNowBrl = Number((plannedSaleBrl * gainMargin * 0.15).toFixed(2));
    const estimatedTaxIfSoldNowUsd = Number((estimatedTaxIfSoldNowBrl / usdBrlRate).toFixed(2));

    return {
      status: "LEI_14754_FLAT_15PCT",
      custodyLocation: "OFFSHORE",
      monthlySalesBrl,
      plannedSaleBrl,
      projectedTotalBrl,
      thresholdBrl,
      remainingExemptBrl: 0,
      remainingExemptUsd: 0,
      wouldBreach35kThreshold: false,
      lei14754Applies: true,
      estimatedTaxRatePct: 15,
      estimatedTaxIfSoldNowBrl,
      estimatedTaxIfSoldNowUsd,
      recommendedMaxSaleThisMonthUsd: 0,
      usdBrlRate,
      ruleSummary:
        "Lei 14.754/2023 eliminates the R$35k monthly exemption for offshore exchanges, DEX swaps, and self-custody wallets: annual net crypto gains are taxed at a flat 15%.",
      agentGuidance:
        "Offshore/DEX swaps do NOT qualify for Brazil's R$35,000 monthly exemption. Harvest unrealized losses in the same calendar year via /api/v1/x402/tlh-scan or route liquidity through /api/v1/borrow-vs-sell before realizing taxable gains.",
      disclaimer:
        "Deterministic software calculation for Brazil crypto tax planning (Lei 14.754/2023 & IN RFB 1888), not legal or CPA advice.",
    };
  }

  const remainingBeforeSaleBrl = Math.max(0, Number((thresholdBrl - monthlySalesBrl).toFixed(2)));
  const remainingAfterSaleBrl = Math.max(0, Number((thresholdBrl - projectedTotalBrl).toFixed(2)));
  const wouldBreach35kThreshold = projectedTotalBrl > thresholdBrl;
  const recommendedMaxSaleThisMonthUsd = Number((remainingBeforeSaleBrl / usdBrlRate).toFixed(2));

  if (!wouldBreach35kThreshold) {
    return {
      status: "EXEMPT_UNDER_35K",
      custodyLocation: "DOMESTIC",
      monthlySalesBrl,
      plannedSaleBrl,
      projectedTotalBrl,
      thresholdBrl,
      remainingExemptBrl: remainingAfterSaleBrl,
      remainingExemptUsd: Number((remainingAfterSaleBrl / usdBrlRate).toFixed(2)),
      wouldBreach35kThreshold: false,
      lei14754Applies: false,
      estimatedTaxRatePct: 0,
      estimatedTaxIfSoldNowBrl: 0,
      estimatedTaxIfSoldNowUsd: 0,
      recommendedMaxSaleThisMonthUsd,
      usdBrlRate,
      ruleSummary:
        "Domestic exchange alienations totaling <= R$35,000.00 within the calendar month remain tax-exempt for Brazilian individuals (PF_DOMESTIC).",
      agentGuidance: `Safe to execute: projected monthly alienations (R$${projectedTotalBrl.toFixed(
        2
      )}) stay under the R$35,000 threshold, leaving R$${remainingAfterSaleBrl.toFixed(
        2
      )} (~$${(remainingAfterSaleBrl / usdBrlRate).toFixed(2)} USD) exempt this month.`,
      disclaimer:
        "Deterministic software calculation for Brazil crypto tax planning (Lei 14.754/2023 & IN RFB 1888), not legal or CPA advice.",
    };
  }

  const estimatedTaxIfSoldNowBrl = Number((plannedSaleBrl * gainMargin * 0.15).toFixed(2));
  const estimatedTaxIfSoldNowUsd = Number((estimatedTaxIfSoldNowBrl / usdBrlRate).toFixed(2));

  return {
    status: "BREACHES_35K_TAX_APPLIES",
    custodyLocation: "DOMESTIC",
    monthlySalesBrl,
    plannedSaleBrl,
    projectedTotalBrl,
    thresholdBrl,
    remainingExemptBrl: 0,
    remainingExemptUsd: 0,
    wouldBreach35kThreshold: true,
    lei14754Applies: false,
    estimatedTaxRatePct: 15,
    estimatedTaxIfSoldNowBrl,
    estimatedTaxIfSoldNowUsd,
    recommendedMaxSaleThisMonthUsd,
    usdBrlRate,
    ruleSummary:
      "Exceeding R$35,000.00 in total domestic monthly crypto sales removes the exemption for the ENTIRE month's gains (progressive 15%–22.5% DARF due next month).",
    agentGuidance: `STOP or SPLIT SALE: selling $${params.plannedSaleUsd.toFixed(
      2
    )} USD pushes monthly alienations to R$${projectedTotalBrl.toFixed(
      2
    )} (> R$35,000). Cap this month's sale at $${recommendedMaxSaleThisMonthUsd.toFixed(
      2
    )} USD (R$${remainingBeforeSaleBrl.toFixed(
      2
    )}) to pay R$0 tax, and defer the rest until the 1st of next month.`,
    disclaimer:
      "Deterministic software calculation for Brazil crypto tax planning (Lei 14.754/2023 & IN RFB 1888), not legal or CPA advice.",
  };
}

/**
 * Prepares a $0-upfront 1-click execution payload (`0x v2`, `Jupiter`, or `Aave v3`) with
 * TaxRail's exact 10% verified-savings fee embedded inside the operation itself.
 * Strictly redacts `selectedLots`, `tlhOpportunities`, and `accountingDossier` until
 * `claim_dossier` verifies the on-chain settlement receipt.
 */
export async function executePrepareExecution(
  input: PrepareExecutionInput,
  deps: TaxRailServiceDeps
): Promise<
  | { ok: true; data: PrepareExecutionResponse }
  | { ok: false; status: 400 | 404; error: string }
> {
  const stored = await deps.planStore.get(input.planId);
  if (!stored) {
    return { ok: false, status: 404, error: "Plan not found or expired" };
  }

  const { plan, pricing } = stored;
  if (plan.planType === "DEDUCTIBLE_EXPENSE") {
    return {
      ok: false,
      status: 400,
      error:
        "DEDUCTIBLE_EXPENSE plans have no on-chain swap/borrow operation. Unlock via POST /api/v1/unlock-plan.",
    };
  }

  const treasuryWallet = resolveTreasuryWallet(deps.env);
  const remainingTtl = stored.expiresAt
    ? Math.max(60, Math.ceil((Date.parse(stored.expiresAt) - Date.now()) / 1000))
    : DEFAULT_PLAN_TTL_SECONDS;

  if (plan.planType === "BORROW_VS_SELL") {
    const existingAave = plan.aaveActions;
    if (!existingAave) {
      return {
        ok: false,
        status: 400,
        error: "Aave v3 actions are unavailable for this plan.",
      };
    }

    const chain = existingAave.chain;
    let aaveActions = existingAave;
    const borrowerAddress = input.borrowerAddress || input.takerAddress;

    if (borrowerAddress && (!existingAave.feeTransferTransaction || borrowerAddress !== input.borrowerAddress)) {
      const rebuildFee = pricing.totalFeeUsd;
      // Re-encode with the caller's live borrower address by extracting collateral/amounts from notes or existing payload
      // Note: if the original plan already has valid actions, update onBehalfOf when borrowerAddress is passed
      const colMatch = existingAave.supplyTransaction?.description.match(/Supply\s+([\d.]+)\s+(\S+)\s+collateral/);
      const collateralAmount = colMatch ? Number(colMatch[1]) : 0;
      const collateralAsset = colMatch ? colMatch[2]! : "ETH";

      if (Number.isFinite(collateralAmount) && collateralAmount >= 0) {
        aaveActions = buildAaveBorrowPayload({
          chain,
          borrowerAddress,
          collateralAsset,
          collateralAmount,
          borrowAmountUsd: existingAave.netLiquidityUsd,
          feeAmountUsd: rebuildFee,
          treasuryWallet,
          affiliateWallet: pricing.affiliateWallet,
        });
      }
    }

    const usdcMeta = EVM_TOKEN_REGISTRY[chain].USDC;
    const treasuryFeeUsd = aaveActions.feeTransferTransaction?.amountUsd ?? 0;
    const expectedTreasuryFeeAtomic =
      treasuryFeeUsd > 0
        ? BigInt(Math.floor(treasuryFeeUsd * 0.98 * 1_000_000)).toString()
        : "0";

    const executionVerification: ExecutionVerificationMeta = {
      chain,
      treasuryWallet,
      expectedFeeTokenAddress: usdcMeta.address,
      expectedTreasuryFeeAtomic,
      expectedFeeUsd: pricing.totalFeeUsd,
    };

    const updatedPlan: FullTaxOptimizationPlan = {
      ...plan,
      aaveActions,
    };

    await deps.planStore.put(
      plan.planId,
      {
        ...stored,
        plan: updatedPlan,
        executionVerification,
      },
      remainingTtl
    );

    return {
      ok: true,
      data: {
        planId: plan.planId,
        planType: "BORROW_VS_SELL",
        chain,
        settlementMode: pricing.totalFeeUsd > 0 ? "PAY_FROM_OPERATION" : "FREE",
        upfrontCostUsd: 0,
        feePaidFromOperationUsd: aaveActions.feePaidFromBorrowUsd,
        feeRatePct: pricing.feeRatePct,
        taxSavedUsd: plan.taxSavedUsd,
        clientNetBenefitUsd: pricing.clientNetBenefitUsd,
        roiMultiple: pricing.roiMultiple,
        treasuryWallet,
        ...(pricing.affiliateWallet ? { affiliateWallet: pricing.affiliateWallet } : {}),
        affiliateShareUsd: pricing.affiliateShareUsd,
        executionPayload: {
          type: "AAVE_V3_BORROW_BATCH",
          aaveActions,
          expectedFeeTokenAddress: usdcMeta.address,
          expectedTreasuryFeeAtomic,
        },
        nextAction: {
          tool: "claim_dossier",
          endpoint: "/api/v1/claim-dossier",
          planId: plan.planId,
          instruction:
            "Execute `atomicBatchCalls` (via EIP-5792 wallet_sendCalls or sequentially), then call POST /api/v1/claim-dossier with { planId, txHash } (and feeTxHash if sequential) to unlock your IRS Form 8949 / DeCripto dossier.",
        },
        disclaimer: plan.disclaimer,
      },
    };
  }

  // CRYPTO_DISPOSAL swap preparation
  const baseSwap = plan.swapIntent;
  if (!baseSwap) {
    return {
      ok: false,
      status: 400,
      error: "Swap intent is unavailable for this plan.",
    };
  }

  const buyAsset = (input.buyAsset || baseSwap.buyAsset || "USDC").trim().toUpperCase();
  const chain = baseSwap.chain;
  const swapIntent = buildSwapIntent({
    chain,
    sellAsset: baseSwap.sellAsset,
    buyAsset,
    sellAmountDecimal: baseSwap.sellAmountDecimal,
    pricing,
    treasuryWallet,
    takerAddress: input.takerAddress,
  });

  if (swapIntent.venue === "0x_v2" && deps.env.ZEROX_API_KEY && !deps.skipLive0xQuote) {
    const live0x = await fetchLive0xQuote({
      chain,
      sellAsset: swapIntent.sellAsset,
      buyAsset,
      sellAmountDecimal: swapIntent.sellAmountDecimal,
      takerAddress: input.takerAddress,
      swapFeeBps: swapIntent.integratorFeeBps,
      swapFeeRecipient: treasuryWallet,
      affiliateWallet: pricing.affiliateWallet,
      zeroxApiKey: deps.env.ZEROX_API_KEY,
    });
    if (live0x.quote) {
      swapIntent.liveQuote = live0x.quote;
    }
  }

  const buyTokenInfo = resolveZeroXTokenInfo(chain, buyAsset);
  const isUsdStable = buyAsset === "USDC" || buyAsset === "USDT";
  const treasuryRatio = pricing.affiliateWallet ? 0.8 : 1.0;
  const expectedTreasuryUsd = pricing.operationFeeUsd * treasuryRatio;
  const expectedTreasuryFeeAtomic =
    isUsdStable && expectedTreasuryUsd > 0
      ? BigInt(Math.floor(expectedTreasuryUsd * 0.85 * 1_000_000)).toString()
      : "0";

  const evmChain: "base" | "ethereum" | "arbitrum" =
    chain === "ethereum" || chain === "arbitrum" ? chain : "base";

  const executionVerification: ExecutionVerificationMeta = {
    chain: evmChain,
    treasuryWallet,
    ...(buyTokenInfo ? { expectedFeeTokenAddress: buyTokenInfo.address } : {}),
    expectedTreasuryFeeAtomic,
    expectedFeeUsd: pricing.operationFeeUsd,
  };

  await deps.planStore.put(
    plan.planId,
    {
      ...stored,
      plan: { ...plan, swapIntent },
      executionVerification,
    },
    remainingTtl
  );

  return {
    ok: true,
    data: {
      planId: plan.planId,
      planType: "CRYPTO_DISPOSAL",
      chain,
      settlementMode: pricing.totalFeeUsd > 0 ? "PAY_FROM_OPERATION" : "FREE",
      upfrontCostUsd: 0,
      feePaidFromOperationUsd: pricing.operationFeeUsd,
      feeRatePct: pricing.feeRatePct,
      taxSavedUsd: plan.taxSavedUsd,
      clientNetBenefitUsd: pricing.clientNetBenefitUsd,
      roiMultiple: pricing.roiMultiple,
      treasuryWallet,
      ...(pricing.affiliateWallet ? { affiliateWallet: pricing.affiliateWallet } : {}),
      affiliateShareUsd: pricing.affiliateShareUsd,
      executionPayload: {
        type: swapIntent.venue === "jupiter" ? "SWAP_JUPITER" : "SWAP_0X_V2",
        swapIntent,
        ...(buyTokenInfo ? { expectedFeeTokenAddress: buyTokenInfo.address } : {}),
        expectedTreasuryFeeAtomic,
      },
      nextAction: {
        tool: "claim_dossier",
        endpoint: "/api/v1/claim-dossier",
        planId: plan.planId,
        instruction:
          "Sign and broadcast the swap transaction (`liveQuote.transaction` or `requestTemplate`), then call POST /api/v1/claim-dossier with { planId, txHash, chain } to verify the on-chain fee receipt and unlock your SpecID lots + accounting CSV.",
      },
      disclaimer: plan.disclaimer,
    },
  };
}

/**
 * Verifies the on-chain operation fee receipt for a `planId` and unlocks the full
 * SpecID Lot IDs + IRS Form 8949 / Brazil DeCripto accounting dossier.
 */
export async function executeClaimDossier(
  input: ClaimDossierInput,
  deps: TaxRailServiceDeps,
  opts: { devBypass?: boolean } = {}
): Promise<
  | { ok: true; data: ClaimDossierResponse }
  | { ok: false; status: 402 | 404; error: string; explorerUrl?: string }
> {
  const stored = await deps.planStore.get(input.planId);
  if (!stored) {
    return { ok: false, status: 404, error: "Plan not found or expired" };
  }

  const chain: "base" | "ethereum" | "arbitrum" =
    input.chain ?? stored.executionVerification?.chain ?? "base";
  const settlementTx = input.feeTxHash || input.txHash;
  const explorerUrl = getExplorerTxUrl(chain, settlementTx);
  const feePaidUsd =
    stored.executionVerification?.expectedFeeUsd ??
    (stored.pricing.operationFeeUsd > 0 ? stored.pricing.operationFeeUsd : stored.pricing.totalFeeUsd);

  if (opts.devBypass || stored.pricing.totalFeeUsd <= 0 || feePaidUsd <= 0) {
    const unlockedRecord = await deps.planStore.markUnlocked(input.planId, settlementTx);
    if (feePaidUsd > 0) {
      await recordPaidReceipt(deps.env, {
        settlementTx,
        tier: "10PCT_OPERATION_FEE",
        amountUsd: feePaidUsd,
        taxSavedUsd: stored.pricing.taxSavedUsd,
        planId: input.planId,
        explorerUrl,
      });
    }
    return {
      ok: true,
      data: {
        verified: true,
        planId: input.planId,
        settlementTx,
        explorerUrl,
        feePaidUsd: stored.pricing.totalFeeUsd <= 0 ? 0 : feePaidUsd,
        plan: unlockedRecord ? unlockedRecord.plan : stored.plan,
      },
    };
  }

  const treasuryWallet =
    stored.executionVerification?.treasuryWallet ?? resolveTreasuryWallet(deps.env);
  const expectedMinAtomic = stored.executionVerification?.expectedTreasuryFeeAtomic
    ? BigInt(stored.executionVerification.expectedTreasuryFeeAtomic)
    : undefined;

  const verification = await verifyOperationFeeReceipt({
    chain,
    txHash: settlementTx,
    treasuryWallet,
    expectedTokenAddress: stored.executionVerification?.expectedFeeTokenAddress,
    expectedMinAtomic,
    alchemyApiKey: deps.env.ALCHEMY_API_KEY,
  });

  if (!verification.verified) {
    return {
      ok: false,
      status: 402,
      error: verification.reason,
      explorerUrl: verification.explorerUrl,
    };
  }

  const unlockedRecord = await deps.planStore.markUnlocked(input.planId, settlementTx);
  await recordPaidReceipt(deps.env, {
    settlementTx,
    tier: "10PCT_OPERATION_FEE",
    amountUsd: feePaidUsd,
    taxSavedUsd: stored.pricing.taxSavedUsd,
    planId: input.planId,
    explorerUrl: verification.explorerUrl,
  });

  return {
    ok: true,
    data: {
      verified: true,
      planId: input.planId,
      settlementTx,
      explorerUrl: verification.explorerUrl,
      feePaidUsd,
      plan: unlockedRecord ? unlockedRecord.plan : stored.plan,
    },
  };
}
