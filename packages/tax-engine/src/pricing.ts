import type { DynamicPricingQuote, PricingTier } from "@taxrail/shared";
import { round2 } from "./utils.js";

const TIER_FEE_RATES: Readonly<Record<PricingTier, number>> = {
  STANDARD: 0.10,
  VOLUME: 0.10,
  ENTERPRISE: 0.10,
};

const MAX_SWAP_FEE_BPS = 1000; // 10.00% native 0x v2 / Jupiter cap
const MAX_SWAP_FEE_PPM = 100_000; // 10.00% exact parts-per-million

/**
 * Computes TaxRail's outcome-based pricing quote:
 * - Guaranteed minimum 10% of verified tax savings (`feeRatePct = 0.10` across all tiers).
 * - Minimum fee $0.50, hard-capped at 50% of `taxSavedUsd` so the client always retains net positive value.
 * - For on-chain operations (swaps & Aave v3 borrow-vs-sell), 100% of the fee is collected directly
 *   from the operation (`settlementMode: "PAY_FROM_OPERATION"`, $0 upfront) up to 1000 bps / 100,000 ppm
 *   on swaps or added to the Aave USDC borrow amount.
 * - Retains `upfrontX402Usd` as an optional fallback for legacy `/api/v1/unlock-plan` x402 callers
 *   and non-onchain corporate expense dossiers (`settlementMode: "UPFRONT_X402"`).
 * - 20% affiliate share for referring agent/integrator wallets.
 */
export function calculateDynamicPricing(params: {
  taxSavedUsd: number;
  estimatedTransactionUsd?: number;
  pricingTier?: PricingTier;
  referrerWallet?: string;
  supportsOnchainFee?: boolean;
  isBorrowOperation?: boolean;
}): DynamicPricingQuote {
  const tier: PricingTier = params.pricingTier ?? "STANDARD";
  const feeRatePct = TIER_FEE_RATES[tier];
  const taxSavedUsd = round2(Math.max(0, params.taxSavedUsd));

  if (taxSavedUsd <= 0) {
    return {
      taxSavedUsd: 0,
      feeRatePct,
      totalFeeUsd: 0,
      settlementMode: "FREE",
      zeroUpfrontAvailable: true,
      operationFeeUsd: 0,
      upfrontX402Usd: 0,
      embeddedSwapFeeBps: 0,
      embeddedSwapFeePpm: 0,
      embeddedSwapFeeUsd: 0,
      enterpriseBalanceUsd: 0,
      ...(params.referrerWallet ? { affiliateWallet: params.referrerWallet } : {}),
      affiliateShareUsd: 0,
      clientNetBenefitUsd: 0,
      roiMultiple: 0,
    };
  }

  const rawFee = Math.max(0.50, round2(taxSavedUsd * feeRatePct));
  const totalFeeUsd = round2(Math.min(rawFee, taxSavedUsd * 0.5));
  const supportsOnchainFee = params.supportsOnchainFee ?? true;
  const isBorrowOperation = params.isBorrowOperation ?? false;

  let settlementMode: DynamicPricingQuote["settlementMode"] = "UPFRONT_X402";
  let zeroUpfrontAvailable = false;
  let operationFeeUsd = 0;
  let embeddedSwapFeeBps = 0;
  let embeddedSwapFeePpm = 0;
  let embeddedSwapFeeUsd = 0;
  let enterpriseBalanceUsd = 0;
  const upfrontX402Usd = totalFeeUsd <= 50 ? totalFeeUsd : isBorrowOperation || supportsOnchainFee ? 10 : 50;

  if (supportsOnchainFee && isBorrowOperation) {
    settlementMode = "PAY_FROM_OPERATION";
    zeroUpfrontAvailable = true;
    operationFeeUsd = totalFeeUsd;
    enterpriseBalanceUsd = 0;
  } else if (
    supportsOnchainFee &&
    params.estimatedTransactionUsd !== undefined &&
    params.estimatedTransactionUsd > 0
  ) {
    const txUsd = params.estimatedTransactionUsd;
    settlementMode = "PAY_FROM_OPERATION";
    zeroUpfrontAvailable = true;
    embeddedSwapFeePpm = Math.min(
      MAX_SWAP_FEE_PPM,
      Math.max(1, Math.ceil((totalFeeUsd / txUsd) * 1_000_000))
    );
    embeddedSwapFeeBps = Math.min(
      MAX_SWAP_FEE_BPS,
      Math.max(1, Math.ceil((totalFeeUsd / txUsd) * 10_000))
    );
    embeddedSwapFeeUsd = round2(Math.min(totalFeeUsd, (txUsd * embeddedSwapFeePpm) / 1_000_000));
    operationFeeUsd = embeddedSwapFeeUsd;
    enterpriseBalanceUsd = round2(Math.max(0, totalFeeUsd - operationFeeUsd));
  } else {
    settlementMode = "UPFRONT_X402";
    zeroUpfrontAvailable = false;
    operationFeeUsd = 0;
    enterpriseBalanceUsd = round2(Math.max(0, totalFeeUsd - upfrontX402Usd));
  }

  const affiliateShareUsd = params.referrerWallet ? round2(totalFeeUsd * 0.20) : 0;
  const clientNetBenefitUsd = round2(taxSavedUsd - totalFeeUsd);
  const roiMultiple = totalFeeUsd > 0 ? round2(taxSavedUsd / totalFeeUsd) : 0;

  return {
    taxSavedUsd,
    feeRatePct,
    totalFeeUsd,
    settlementMode,
    zeroUpfrontAvailable,
    operationFeeUsd,
    upfrontX402Usd,
    embeddedSwapFeeBps,
    embeddedSwapFeePpm,
    embeddedSwapFeeUsd,
    enterpriseBalanceUsd,
    ...(params.referrerWallet ? { affiliateWallet: params.referrerWallet } : {}),
    affiliateShareUsd,
    clientNetBenefitUsd,
    roiMultiple,
  };
}
