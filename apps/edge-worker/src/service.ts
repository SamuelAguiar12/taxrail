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
  SwapIntentPayload,
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

  return redacted;
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

  return preview;
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

  return preview;
}
