import type { DynamicPricingQuote, PricingTier } from "@taxrail/shared";
import { round2 } from "./utils.js";

const TIER_FEE_RATES: Readonly<Record<PricingTier, number>> = {
  STANDARD: 0.10,
  VOLUME: 0.07,
  ENTERPRISE: 0.05,
};

/**
 * Computes TaxRail's hybrid outcome-based pricing quote:
 * - Fee tier: STANDARD (10%), VOLUME (7%), ENTERPRISE (5%) of verified tax savings.
 * - Minimum fee $0.50, hard-capped at 50% of `taxSavedUsd` so the client always retains net positive value.
 * - Hybrid guardrail: fees <= $50 are settled 100% upfront via HTTP 402 USDC;
 *   fees > $50 cap upfront x402 at $10 and route the remainder via embedded swap bps (<= 100 bps)
 *   and/or enterprise balance.
 * - 20% affiliate share for referring agent/integrator wallets.
 */
export function calculateDynamicPricing(params: {
  taxSavedUsd: number;
  estimatedTransactionUsd?: number;
  pricingTier?: PricingTier;
  referrerWallet?: string;
}): DynamicPricingQuote {
  const tier: PricingTier = params.pricingTier ?? "STANDARD";
  const feeRatePct = TIER_FEE_RATES[tier];
  const taxSavedUsd = round2(Math.max(0, params.taxSavedUsd));

  if (taxSavedUsd <= 0) {
    return {
      taxSavedUsd: 0,
      feeRatePct,
      totalFeeUsd: 0,
      upfrontX402Usd: 0,
      embeddedSwapFeeBps: 0,
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

  let upfrontX402Usd = 0;
  let embeddedSwapFeeBps = 0;
  let embeddedSwapFeeUsd = 0;
  let enterpriseBalanceUsd = 0;

  if (totalFeeUsd <= 50) {
    upfrontX402Usd = totalFeeUsd;
  } else {
    upfrontX402Usd = 10;
    const remaining = round2(totalFeeUsd - 10);
    const txUsd = params.estimatedTransactionUsd;

    if (txUsd !== undefined && txUsd > 0) {
      embeddedSwapFeeBps = Math.min(100, Math.round((remaining / txUsd) * 10000));
      embeddedSwapFeeUsd = round2((txUsd * embeddedSwapFeeBps) / 10000);
      enterpriseBalanceUsd = round2(Math.max(0, remaining - embeddedSwapFeeUsd));
    } else {
      enterpriseBalanceUsd = remaining;
    }
  }

  const affiliateShareUsd = params.referrerWallet ? round2(totalFeeUsd * 0.20) : 0;
  const clientNetBenefitUsd = round2(taxSavedUsd - totalFeeUsd);
  const roiMultiple = totalFeeUsd > 0 ? round2(taxSavedUsd / totalFeeUsd) : 0;

  return {
    taxSavedUsd,
    feeRatePct,
    totalFeeUsd,
    upfrontX402Usd,
    embeddedSwapFeeBps,
    embeddedSwapFeeUsd,
    enterpriseBalanceUsd,
    ...(params.referrerWallet ? { affiliateWallet: params.referrerWallet } : {}),
    affiliateShareUsd,
    clientNetBenefitUsd,
    roiMultiple,
  };
}
