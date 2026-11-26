import { z } from "zod";

export const JurisdictionSchema = z.enum(["US", "BR"]);

export const TaxRegimeSchema = z.enum([
  "INDIVIDUAL",
  "LLC_PASS_THROUGH",
  "C_CORP",
  "PF_LEI_14754",
  "PF_DOMESTIC",
  "PJ_LUCRO_REAL",
  "PJ_SIMPLES_EXPORT",
]);

export const CustodyLocationSchema = z.enum([
  "DOMESTIC",
  "OFFSHORE",
  "SELF_CUSTODY",
]);

export const SupportedChainSchema = z.enum([
  "base",
  "ethereum",
  "arbitrum",
  "solana",
]);

export const PricingTierSchema = z.enum(["STANDARD", "VOLUME", "ENTERPRISE"]);

export const TaxLotSchema = z.object({
  lotId: z.string().min(1),
  asset: z.string().min(1),
  quantity: z.number().positive(),
  costBasisUsd: z.number().nonnegative(),
  acquiredAt: z.string().min(4),
  custodyLocation: CustodyLocationSchema,
});

export const RealizedContextSchema = z.object({
  realizedGainsYtdUsd: z.number().nonnegative().optional(),
  realizedLossesYtdUsd: z.number().nonnegative().optional(),
  monthlyGrossSalesBrl: z.number().nonnegative().optional(),
  usdBrlRate: z.number().positive().optional(),
  marginalOrdinaryRate: z.number().min(0).max(0.5).optional(),
  applyNiit: z.boolean().optional(),
  carryforwardLossesUsd: z.number().nonnegative().optional(),
});

export const CheckTaxImpactInputSchema = z
  .object({
    jurisdiction: JurisdictionSchema,
    regime: TaxRegimeSchema,
    chain: SupportedChainSchema.optional(),
    walletAddress: z.string().optional(),
    targetAsset: z.string().min(1),
    sellQuantity: z.number().positive().optional(),
    targetProceedsUsd: z.number().positive().optional(),
    currentPriceUsd: z.number().positive(),
    targetQuoteAsset: z.string().min(1).optional(),
    lots: z.array(TaxLotSchema).min(1),
    context: RealizedContextSchema.optional(),
    referrerWallet: z.string().optional(),
    pricingTier: PricingTierSchema.optional(),
    asOfDate: z.string().optional(),
  })
  .refine(
    (d) => d.sellQuantity !== undefined || d.targetProceedsUsd !== undefined,
    { message: "Either sellQuantity or targetProceedsUsd must be provided" }
  );

export const CheckTaxImpactRequestSchema = z
  .object({
    jurisdiction: JurisdictionSchema,
    regime: TaxRegimeSchema,
    chain: SupportedChainSchema.optional(),
    walletAddress: z.string().optional(),
    targetAsset: z.string().min(1),
    sellQuantity: z.number().positive().optional(),
    targetProceedsUsd: z.number().positive().optional(),
    currentPriceUsd: z.number().positive().optional(),
    targetQuoteAsset: z.string().min(1).optional(),
    lots: z.array(TaxLotSchema).min(1).optional(),
    context: RealizedContextSchema.optional(),
    referrerWallet: z.string().optional(),
    pricingTier: PricingTierSchema.optional(),
    asOfDate: z.string().optional(),
  })
  .refine(
    (d) => d.sellQuantity !== undefined || d.targetProceedsUsd !== undefined,
    { message: "Either sellQuantity or targetProceedsUsd must be provided" }
  )
  .refine(
    (d) =>
      (d.lots !== undefined && d.lots.length > 0) ||
      (d.walletAddress !== undefined && /^0x[a-fA-F0-9]{40}$/.test(d.walletAddress)),
    {
      message:
        "Provide either non-empty `lots` or a valid EVM `walletAddress` (0x...) for automatic on-chain scanning",
    }
  );

export const BorrowVsSellInputSchema = z.object({
  jurisdiction: JurisdictionSchema,
  regime: TaxRegimeSchema,
  chain: z.enum(["base", "ethereum", "arbitrum"]).optional(),
  borrowerAddress: z.string().optional(),
  collateralAsset: z.string().min(1),
  collateralAmount: z.number().positive(),
  collateralPriceUsd: z.number().positive(),
  collateralCostBasisUsd: z.number().nonnegative(),
  holdingDays: z.number().nonnegative(),
  liquidityNeededUsd: z.number().positive(),
  borrowApr: z.number().min(0).max(1).optional(),
  horizonDays: z.number().positive().optional(),
  marginalOrdinaryRate: z.number().min(0).max(0.5).optional(),
  referrerWallet: z.string().optional(),
  pricingTier: PricingTierSchema.optional(),
});

export const DeductibleExpenseInputSchema = z.object({
  jurisdiction: JurisdictionSchema,
  regime: TaxRegimeSchema,
  vendorName: z.string().min(1),
  description: z.string().min(1),
  amountUsd: z.number().positive(),
  currency: z.enum(["USD", "BRL"]).optional(),
  paidWithInternationalCard: z.boolean().optional(),
  hasFiscalDocument: z.boolean().optional(),
  fiscalDocumentId: z.string().optional(),
  usdBrlRate: z.number().positive().optional(),
  referrerWallet: z.string().optional(),
  pricingTier: PricingTierSchema.optional(),
});

export const UnlockPlanInputSchema = z.object({
  planId: z.string().min(1),
});

export const PrepareExecutionInputSchema = z.object({
  planId: z.string().min(1),
  takerAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "takerAddress must be a valid 0x EVM address")
    .optional(),
  buyAsset: z.string().min(1).optional(),
  borrowerAddress: z
    .string()
    .regex(/^0x[a-fA-F0-9]{40}$/, "borrowerAddress must be a valid 0x EVM address")
    .optional(),
});

export const ClaimDossierInputSchema = z.object({
  planId: z.string().min(1),
  txHash: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{64}$/, "txHash must be a valid 32-byte 0x transaction hash"),
  chain: z.enum(["base", "ethereum", "arbitrum"]).optional(),
  feeTxHash: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{64}$/, "feeTxHash must be a valid 32-byte 0x transaction hash")
    .optional(),
});
