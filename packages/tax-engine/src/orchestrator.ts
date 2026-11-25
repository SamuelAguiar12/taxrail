import type {
  BorrowVsSellInput,
  BorrowVsSellPreview,
  CheckTaxImpactInput,
  CheckTaxImpactRedactedResponse,
  DeductibleExpenseInput,
  DeductibleExpensePreview,
  DynamicPricingQuote,
  SelectedLotDisposal,
  TlhOpportunity,
} from "@taxrail/shared";
import { evaluateBorrowVsSell } from "./borrow-vs-sell.js";
import { classifyBrDeductibleExpense } from "./br/corporate.js";
import { optimizeBrCryptoTax } from "./br/crypto-tax.js";
import { calculateDynamicPricing } from "./pricing.js";
import { optimizeUsCapitalGains } from "./us/capital-gains.js";
import { classifyUsDeductibleExpense } from "./us/deductions.js";
import { scanUsTlhOpportunities } from "./us/tlh.js";
import { assertJurisdictionRegime, round2, TAXRAIL_DISCLAIMER } from "./utils.js";

function generatePlanId(): string {
  return `plan_${crypto.randomUUID().slice(0, 12)}`;
}

export interface AnalyzeCryptoDisposalResult {
  redacted: CheckTaxImpactRedactedResponse;
  selectedLots: SelectedLotDisposal[];
  tlhOpportunities: TlhOpportunity[];
  warnings: string[];
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  pricing: DynamicPricingQuote;
}

/**
 * Orchestrates jurisdiction-specific crypto disposal optimization, TLH scanning,
 * dynamic pricing, and strict redacted-preview generation (never leaking lotIds,
 * selectedLots, tlhOpportunities, or swap calldata in the pre-payment response).
 */
export function analyzeCryptoDisposal(
  input: CheckTaxImpactInput
): AnalyzeCryptoDisposalResult {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const planId = generatePlanId();

  const optimization =
    input.jurisdiction === "US" ? optimizeUsCapitalGains(input) : optimizeBrCryptoTax(input);

  const tlhOpportunities =
    input.jurisdiction === "US"
      ? scanUsTlhOpportunities(input, optimization.selectedLots)
      : [];

  const estimatedTransactionUsd = round2(
    optimization.selectedLots.reduce((sum, lot) => sum + lot.proceedsUsd, 0)
  );

  const pricing = calculateDynamicPricing({
    taxSavedUsd: optimization.taxSavedUsd,
    estimatedTransactionUsd:
      estimatedTransactionUsd > 0 ? estimatedTransactionUsd : input.targetProceedsUsd,
    pricingTier: input.pricingTier,
    referrerWallet: input.referrerWallet,
  });

  const redacted: CheckTaxImpactRedactedResponse = {
    planId,
    planType: "CRYPTO_DISPOSAL",
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    baselineStrategy: optimization.baselineStrategy,
    recommendedStrategy: optimization.recommendedStrategy,
    baselineTaxUsd: optimization.baselineTaxUsd,
    optimizedTaxUsd: optimization.optimizedTaxUsd,
    taxSavedUsd: optimization.taxSavedUsd,
    pricing,
    warnings: [...optimization.warnings],
    nextAction: {
      tool: "unlock_tax_plan",
      endpoint: "/api/v1/unlock-plan",
      planId,
      upfrontPaymentRequiredUsd: pricing.upfrontX402Usd,
      paymentAsset: "USDC",
      paymentNetwork: "eip155:8453",
    },
    disclaimer: TAXRAIL_DISCLAIMER,
  };

  return {
    redacted,
    selectedLots: optimization.selectedLots,
    tlhOpportunities,
    warnings: optimization.warnings,
    baselineTaxUsd: optimization.baselineTaxUsd,
    optimizedTaxUsd: optimization.optimizedTaxUsd,
    taxSavedUsd: optimization.taxSavedUsd,
    pricing,
  };
}

/**
 * Orchestrates Borrow-vs-Sell analysis (Aave V3 collateralized borrowing vs taxable disposal)
 * and computes outcome-based pricing.
 */
export function analyzeBorrowVsSell(input: BorrowVsSellInput): {
  preview: BorrowVsSellPreview;
  pricing: DynamicPricingQuote;
} {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const planId = generatePlanId();
  const evaluation = evaluateBorrowVsSell(input);

  const pricing = calculateDynamicPricing({
    taxSavedUsd: evaluation.taxSavedUsd,
    estimatedTransactionUsd: input.liquidityNeededUsd,
    pricingTier: input.pricingTier,
    referrerWallet: input.referrerWallet,
  });

  const preview: BorrowVsSellPreview = {
    planId,
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    recommendation: evaluation.recommendation,
    sellTaxCostUsd: evaluation.sellTaxCostUsd,
    netBorrowCostUsd: evaluation.netBorrowCostUsd,
    corporateInterestTaxShieldUsd: evaluation.corporateInterestTaxShieldUsd,
    taxSavedUsd: evaluation.taxSavedUsd,
    projectedLtvPct: evaluation.projectedLtvPct,
    liquidationWarning: evaluation.liquidationWarning,
    pricing,
    disclaimer: TAXRAIL_DISCLAIMER,
  };

  return { preview, pricing };
}

/**
 * Orchestrates US/BR deductible expense classification, tax shield computation,
 * compliance checklist generation, and outcome-based pricing.
 */
export function analyzeDeductibleExpense(input: DeductibleExpenseInput): {
  preview: DeductibleExpensePreview;
  pricing: DynamicPricingQuote;
} {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const planId = generatePlanId();
  const classification =
    input.jurisdiction === "US"
      ? classifyUsDeductibleExpense(input)
      : classifyBrDeductibleExpense(input);

  const pricing = calculateDynamicPricing({
    taxSavedUsd: classification.taxSavedUsd,
    estimatedTransactionUsd: input.amountUsd,
    pricingTier: input.pricingTier,
    referrerWallet: input.referrerWallet,
  });

  const preview: DeductibleExpensePreview = {
    planId,
    jurisdiction: input.jurisdiction,
    regime: input.regime,
    category: classification.category,
    deductible: classification.deductible,
    taxSavingsBreakdown: classification.taxSavingsBreakdown,
    taxSavedUsd: classification.taxSavedUsd,
    complianceChecklist: classification.complianceChecklist,
    pricing,
    disclaimer: TAXRAIL_DISCLAIMER,
  };

  return { preview, pricing };
}
