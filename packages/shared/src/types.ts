export type Jurisdiction = "US" | "BR";

export type TaxRegimeUS = "INDIVIDUAL" | "LLC_PASS_THROUGH" | "C_CORP";

export type TaxRegimeBR =
  | "PF_LEI_14754"
  | "PF_DOMESTIC"
  | "PJ_LUCRO_REAL"
  | "PJ_SIMPLES_EXPORT";

export type TaxRegime = TaxRegimeUS | TaxRegimeBR;

export type CustodyLocation = "DOMESTIC" | "OFFSHORE" | "SELF_CUSTODY";

export type SupportedChain = "base" | "ethereum" | "arbitrum" | "solana";

export type PricingTier = "STANDARD" | "VOLUME" | "ENTERPRISE";

export interface TaxLot {
  lotId: string;
  asset: string;
  quantity: number;
  /** Cost basis per 1 unit of asset in USD */
  costBasisUsd: number;
  /** ISO 8601 date string */
  acquiredAt: string;
  custodyLocation: CustodyLocation;
}

export interface RealizedContext {
  realizedGainsYtdUsd?: number;
  realizedLossesYtdUsd?: number;
  /** Used for Brazil PF_DOMESTIC R$ 35k monthly sales exemption check */
  monthlyGrossSalesBrl?: number;
  /** USD/BRL exchange rate; defaults to 5.80 if omitted */
  usdBrlRate?: number;
  /** US marginal ordinary income rate (0..0.37) */
  marginalOrdinaryRate?: number;
  /** Include 3.8% Net Investment Income Tax for high-income US individuals */
  applyNiit?: boolean;
  /** Prior year accumulated losses available to offset (BR Lei 14.754 / US carryforward) */
  carryforwardLossesUsd?: number;
}

export interface CheckTaxImpactInput {
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  chain?: SupportedChain;
  walletAddress?: string;
  targetAsset: string;
  sellQuantity?: number;
  targetProceedsUsd?: number;
  currentPriceUsd: number;
  targetQuoteAsset?: string;
  lots: TaxLot[];
  context?: RealizedContext;
  referrerWallet?: string;
  pricingTier?: PricingTier;
  /** ISO timestamp override for deterministic calculations/testing */
  asOfDate?: string;
}

/**
 * Request payload accepted by Edge Worker & MCP tools:
 * allows omitting `lots` and `currentPriceUsd` when `walletAddress` is provided
 * so TaxRail can hydrate balances/lots and spot price automatically via Alchemy.
 */
export type CheckTaxImpactRequest = Omit<
  CheckTaxImpactInput,
  "lots" | "currentPriceUsd"
> & {
  currentPriceUsd?: number;
  lots?: TaxLot[];
};

export interface DynamicPricingQuote {
  taxSavedUsd: number;
  /** Fee rate on verified tax savings (guaranteed >= 0.10 = 10% across tiers) */
  feeRatePct: number;
  totalFeeUsd: number;
  /** How TaxRail collects the 10% verified-savings fee */
  settlementMode: "PAY_FROM_OPERATION" | "UPFRONT_X402" | "FREE";
  /** True when the operation can pay 100% of TaxRail's fee from swap/borrow proceeds ($0 upfront) */
  zeroUpfrontAvailable: boolean;
  /** Exact USD fee collected directly from the on-chain swap output or Aave borrowed USDC */
  operationFeeUsd: number;
  /** Upfront USDC payment required via HTTP 402 fallback (used for non-onchain dossiers or x402-only unlock) */
  upfrontX402Usd: number;
  /** Fee embedded as Partner/Integrator fee in swap calldata (0..1000 bps = up to 10%) */
  embeddedSwapFeeBps: number;
  /** Exact parts-per-million fee embedded in 0x v2 calldata (0..100000 ppm = up to 10%) */
  embeddedSwapFeePpm: number;
  /** Equivalent USD value of embedded swap fee */
  embeddedSwapFeeUsd: number;
  /** Any excess savings fee beyond swap cap that requires enterprise settlement */
  enterpriseBalanceUsd: number;
  affiliateWallet?: string;
  /** 20% of TaxRail's total fee shared with agent/integrator developer */
  affiliateShareUsd: number;
  clientNetBenefitUsd: number;
  roiMultiple: number;
}

export interface CheckTaxImpactRedactedResponse {
  planId: string;
  planType: "CRYPTO_DISPOSAL" | "BORROW_VS_SELL" | "DEDUCTIBLE_EXPENSE";
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  baselineStrategy: string;
  recommendedStrategy: string;
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  pricing: DynamicPricingQuote;
  warnings: string[];
  zeroUpfrontExecution?: {
    tool: "prepare_execution";
    endpoint: "/api/v1/prepare-execution";
    claimEndpoint: "/api/v1/claim-dossier";
    planId: string;
    upfrontPaymentRequiredUsd: 0;
    feePaidFromOperationUsd: number;
    feeRatePct: number;
  };
  nextAction: {
    tool: "unlock_tax_plan";
    endpoint: "/api/v1/unlock-plan";
    planId: string;
    upfrontPaymentRequiredUsd: number;
    paymentAsset: "USDC";
    paymentNetwork: "eip155:8453";
  };
  agentGuidance?: string;
  disclaimer: string;
}

export interface SelectedLotDisposal {
  lotId: string;
  asset: string;
  quantityToSell: number;
  proceedsUsd: number;
  costBasisTotalUsd: number;
  gainOrLossUsd: number;
  holdingDays: number;
  term: "SHORT_TERM" | "LONG_TERM" | "LEI_14754" | "BR_DOMESTIC";
  effectiveTaxRate: number;
  estimatedTaxUsd: number;
}

export interface TlhOpportunity {
  lotId: string;
  asset: string;
  quantity: number;
  unrealizedLossUsd: number;
  estimatedTaxShieldUsd: number;
  suggestedReplacementAsset: string;
  rationale: string;
}

export interface SwapIntentPayload {
  venue: "0x_v2" | "cow_swap" | "jupiter";
  chain: SupportedChain;
  sellAsset: string;
  buyAsset: string;
  sellAmountDecimal: string;
  integratorFeeBps: number;
  integratorFeePpm?: number;
  multiRecipientSplit?: boolean;
  feeRecipients: Array<{
    recipient: string;
    shareBps: number;
    role: "TAXRAIL_TREASURY" | "AFFILIATE_AGENT";
  }>;
  requestTemplate: Record<string, unknown>;
  /** Live quote payload enriched from 0x Swap API v2 when ZEROX_API_KEY is configured */
  liveQuote?: Record<string, unknown>;
}

export interface AaveBatchCall {
  to: string;
  data: `0x${string}`;
  value: "0";
  description: string;
}

export interface AaveFeeTransferTransaction extends AaveBatchCall {
  amountUsd: number;
  recipient: string;
}

export interface AaveActionPayload {
  protocol: "aave_v3";
  chain: "base" | "ethereum" | "arbitrum";
  poolAddress: string;
  netLiquidityUsd: number;
  feePaidFromBorrowUsd: number;
  totalBorrowAmountUsd: number;
  approveCollateralTransaction?: AaveBatchCall;
  supplyTransaction?: AaveBatchCall;
  borrowTransaction: AaveBatchCall;
  feeTransferTransaction?: AaveFeeTransferTransaction;
  affiliateFeeTransferTransaction?: AaveFeeTransferTransaction;
  atomicBatchCalls: AaveBatchCall[];
}

export interface AccountingDossier {
  format:
    | "IRS_FORM_8949"
    | "QUICKBOOKS_EXPENSE"
    | "BR_LEI_14754"
    | "BR_LUCRO_REAL_OMIE_SPED";
  generatedAt: string;
  summary: Record<string, unknown>;
  records: Array<Record<string, unknown>>;
  csvExport?: string;
  disclaimer: string;
}

export interface BorrowVsSellInput {
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  chain?: "base" | "ethereum" | "arbitrum";
  borrowerAddress?: string;
  collateralAsset: string;
  collateralAmount: number;
  collateralPriceUsd: number;
  /** Unrealized cost basis per 1 unit of collateral */
  collateralCostBasisUsd: number;
  /** Days collateral has been held */
  holdingDays: number;
  liquidityNeededUsd: number;
  /** Expected Aave borrow APR (e.g. 0.055 for 5.5%) */
  borrowApr?: number;
  /** Expected holding horizon in days (e.g. 180) */
  horizonDays?: number;
  marginalOrdinaryRate?: number;
  referrerWallet?: string;
  pricingTier?: PricingTier;
}

export interface BorrowVsSellPreview {
  planId: string;
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  recommendation: "BORROW_AAVE_V3" | "SELL_OPTIMIZED_LOTS";
  sellTaxCostUsd: number;
  netBorrowCostUsd: number;
  corporateInterestTaxShieldUsd: number;
  taxSavedUsd: number;
  projectedLtvPct: number;
  liquidationWarning: string | null;
  pricing: DynamicPricingQuote;
  agentGuidance?: string;
  disclaimer: string;
}

export interface DeductibleExpenseInput {
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  vendorName: string;
  description: string;
  amountUsd: number;
  currency?: "USD" | "BRL";
  paidWithInternationalCard?: boolean;
  hasFiscalDocument?: boolean;
  /** Fiscal document ID (NF-e key or Invoice ID) */
  fiscalDocumentId?: string;
  usdBrlRate?: number;
  referrerWallet?: string;
  pricingTier?: PricingTier;
}

export interface DeductibleExpensePreview {
  planId: string;
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  category: string;
  deductible: boolean;
  taxSavingsBreakdown: {
    incomeTaxShieldUsd: number;
    pisCofinsCreditUsd: number;
    ibsCbsReadinessCreditUsd: number;
    iofAndSpreadSavingsUsd: number;
  };
  taxSavedUsd: number;
  complianceChecklist: string[];
  pricing: DynamicPricingQuote;
  agentGuidance?: string;
  disclaimer: string;
}

export interface AssetTlhSummary {
  asset: string;
  currentPriceUsd: number;
  priceSource: "alchemy" | "coinbase" | "unavailable";
  lotsScanned: number;
  totalQuantity: number;
  unrealizedPnlUsd: number;
  estimatedTaxSavingsUsd: number;
  recommendedStrategy?: string;
  tlhOpportunities: Array<{
    lotId: string;
    acquiredAt: string;
    quantity: number;
    costBasisUsd: number;
    unrealizedLossUsd: number;
  }>;
  planId?: string;
  upfrontUnlockCostUsd?: number;
}

export interface WalletTlhScanResult {
  status: "TLH_OPPORTUNITIES_FOUND" | "SCAN_READY" | "NO_ELIGIBLE_LOTS_FOUND";
  walletAddress: string;
  chain: "base" | "ethereum" | "arbitrum";
  asset: string;
  scannedAssets: string[];
  assetBreakdown: AssetTlhSummary[];
  currentPriceUsd: number | null;
  priceSource: "alchemy" | "coinbase" | "unavailable";
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  lotsScanned: number;
  totalQuantity: number;
  unrealizedPnlUsd: number;
  estimatedTaxSavingsUsd: number;
  taxRiskScore: "LOW" | "MEDIUM" | "HIGH";
  yearEndTlhDeadline: string;
  rulesApplied: string[];
  tlhOpportunities: Array<{
    lotId: string;
    acquiredAt: string;
    quantity: number;
    costBasisUsd: number;
    unrealizedLossUsd: number;
  }>;
  planId?: string;
  upfrontUnlockCostUsd?: number;
  warnings: string[];
  nextRecommendedAction: {
    action: "UNLOCK_PLAN" | "RUN_QUICK_OPTIMIZE" | "CHECK_TAX_IMPACT";
    endpoint: string;
    planId?: string;
    instruction: string;
  };
  disclaimer: string;
}

export interface FullTaxOptimizationPlan {
  planId: string;
  planType: "CRYPTO_DISPOSAL" | "BORROW_VS_SELL" | "DEDUCTIBLE_EXPENSE";
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  createdAt: string;
  expiresAt: string;
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  pricing: DynamicPricingQuote;
  selectedLots?: SelectedLotDisposal[];
  tlhOpportunities?: TlhOpportunity[];
  swapIntent?: SwapIntentPayload;
  aaveActions?: AaveActionPayload;
  accountingDossier: AccountingDossier;
  executionNotes: string[];
  disclaimer: string;
}

export interface PreTradeCheckResult {
  status:
    | "PRE_TRADE_OPTIMIZED"
    | "BORROW_PREFERRED"
    | "WAIT_FOR_LONG_TERM"
    | "NO_TAX_IMPACT"
    | "NEEDS_LOT_HISTORY";
  recommendation:
    | "BORROW_AAVE_V3"
    | "WAIT_FOR_LONG_TERM"
    | "SELL_OPTIMIZED_HIFO"
    | "SELL_ZERO_TAX"
    | "PROVIDE_EXPLICIT_LOTS";
  walletAddress: string;
  chain: SupportedChain;
  sellAsset: string;
  sellAmount: number;
  currentPriceUsd: number | null;
  jurisdiction: Jurisdiction;
  regime: TaxRegime;
  lotsScanned: number;
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  longTermCliffWarning: string | null;
  borrowVsSellComparison?: {
    recommendation: "BORROW_AAVE_V3" | "SELL_OPTIMIZED_LOTS";
    sellTaxCostUsd: number;
    netBorrowCostUsd: number;
    taxSavedUsd: number;
    projectedLtvPct: number;
  };
  planId?: string;
  borrowPlanId?: string;
  upfrontUnlockCostUsd?: number;
  warnings: string[];
  agentGuidance: string;
  disclaimer: string;
}

export interface PrepareExecutionInput {
  planId: string;
  takerAddress?: string;
  buyAsset?: string;
  borrowerAddress?: string;
}

export interface PrepareExecutionResponse {
  planId: string;
  planType: "CRYPTO_DISPOSAL" | "BORROW_VS_SELL";
  chain: SupportedChain;
  settlementMode: "PAY_FROM_OPERATION" | "FREE";
  upfrontCostUsd: 0;
  feePaidFromOperationUsd: number;
  feeRatePct: number;
  taxSavedUsd: number;
  clientNetBenefitUsd: number;
  roiMultiple: number;
  treasuryWallet: string;
  affiliateWallet?: string;
  affiliateShareUsd: number;
  executionPayload: {
    type: "SWAP_0X_V2" | "SWAP_JUPITER" | "AAVE_V3_BORROW_BATCH";
    swapIntent?: SwapIntentPayload;
    aaveActions?: AaveActionPayload;
    expectedFeeTokenAddress?: string;
    expectedTreasuryFeeAtomic?: string;
  };
  nextAction: {
    tool: "claim_dossier";
    endpoint: "/api/v1/claim-dossier";
    planId: string;
    instruction: string;
  };
  disclaimer: string;
}

export interface ClaimDossierInput {
  planId: string;
  txHash: string;
  chain?: "base" | "ethereum" | "arbitrum";
  feeTxHash?: string;
}

export interface ClaimDossierResponse {
  verified: true;
  planId: string;
  settlementTx: string;
  explorerUrl: string;
  feePaidUsd: number;
  plan: FullTaxOptimizationPlan;
}

export interface Br35kStatusResult {
  status: "EXEMPT_UNDER_35K" | "BREACHES_35K_TAX_APPLIES" | "LEI_14754_FLAT_15PCT";
  custodyLocation: "DOMESTIC" | "OFFSHORE";
  monthlySalesBrl: number;
  plannedSaleBrl: number;
  projectedTotalBrl: number;
  thresholdBrl: number;
  remainingExemptBrl: number;
  remainingExemptUsd: number;
  wouldBreach35kThreshold: boolean;
  lei14754Applies: boolean;
  estimatedTaxRatePct: number;
  estimatedTaxIfSoldNowBrl: number;
  estimatedTaxIfSoldNowUsd: number;
  recommendedMaxSaleThisMonthUsd: number;
  usdBrlRate: number;
  ruleSummary: string;
  agentGuidance: string;
  disclaimer: string;
}
