import type { DeductibleExpenseInput } from "@taxrail/shared";
import {
  assertJurisdictionRegime,
  classifyExpenseCategory,
  type ExpenseCategory,
  round2,
} from "../utils.js";

export interface BrExpenseClassificationResult {
  category: ExpenseCategory;
  deductible: boolean;
  taxSavingsBreakdown: {
    incomeTaxShieldUsd: number;
    pisCofinsCreditUsd: number;
    ibsCbsReadinessCreditUsd: number;
    iofAndSpreadSavingsUsd: number;
  };
  taxSavedUsd: number;
  complianceChecklist: string[];
}

const PIS_COFINS_ELIGIBLE_CATEGORIES: ReadonlySet<ExpenseCategory> = new Set([
  "Cloud & AI Compute",
  "Software & SaaS",
  "Professional Services",
]);

const IOF_RATE = 0.0338;
const BANK_FX_SPREAD_RATE = 0.04;

/**
 * Classifies Brazilian corporate expenses under:
 * - `PJ_LUCRO_REAL`: 34% IRPJ/CSLL shield (Art. 311 RIR/2018) + 9.25% non-cumulative PIS/COFINS
 *   credits (1.65% + 7.60%, STJ Tema 779 insumo test) for eligible cloud/software/service inputs
 *   + 12% IBS/CBS transitional readiness tag (EC 132/2023 & LC 214/2025).
 * - `PJ_SIMPLES_EXPORT`: No Lucro Real operational deduction; quantifies 3.38% IOF + ~4% bank FX
 *   spread savings when replacing international credit cards with USD/USDC settlement, plus
 *   service-export documentation requirements.
 */
export function classifyBrDeductibleExpense(
  input: DeductibleExpenseInput
): BrExpenseClassificationResult {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const category = classifyExpenseCategory(input.vendorName, input.description);
  const iofAndSpreadSavingsUsd = input.paidWithInternationalCard
    ? round2(input.amountUsd * (IOF_RATE + BANK_FX_SPREAD_RATE))
    : 0;

  if (input.regime === "PJ_LUCRO_REAL") {
    const incomeTaxShieldUsd = round2(input.amountUsd * 0.34);
    const isInputEligible = PIS_COFINS_ELIGIBLE_CATEGORIES.has(category);
    const pisCofinsCreditUsd = isInputEligible ? round2(input.amountUsd * 0.0925) : 0;
    // Transitional 12% IBS/CBS readiness indicator (EC 132/2023); tracked separately so it does
    // not double-count against the current-law 9.25% PIS/COFINS credit it gradually replaces.
    const ibsCbsReadinessCreditUsd = isInputEligible ? round2(input.amountUsd * 0.12) : 0;
    const taxSavedUsd = round2(
      incomeTaxShieldUsd + pisCofinsCreditUsd + iofAndSpreadSavingsUsd
    );

    const complianceChecklist: string[] = [
      `Lucro Real (IRPJ 25% + CSLL 9%): Substantiate "${category}" expense as necessary and usual to corporate activity (Art. 311 RIR/2018) for ECD/ECF booking.`,
      isInputEligible
        ? `PIS/COFINS Non-Cumulative Credit (9.25%): Eligible input ("${category}") under STJ Tema 779 essentiality test; book in EFD-Contribuições.`
        : `PIS/COFINS Check: "${category}" generally does not qualify as a creditable production input (insumo) under Laws 10.637/2002 & 10.833/2003.`,
      `IBS/CBS Readiness Tag (EC 132/2023): Estimated $${ibsCbsReadinessCreditUsd.toFixed(2)} (12% reference) transitional non-cumulative credit readiness; ensure NF-e/NFS-e layout supports IBS/CBS fields (2026–2033 rollout).`,
      input.hasFiscalDocument && input.fiscalDocumentId
        ? `Fiscal Document Verified: NF-e / Invoice "${input.fiscalDocumentId}" linked for SPED compliance.`
        : "Fiscal Document Required: Attach NF-e/NFS-e (domestic) or commercial Invoice + cross-border CIDE/IRRF/ISS-import check (foreign SaaS/cloud).",
    ];

    if (input.paidWithInternationalCard) {
      complianceChecklist.push(
        `FX Optimization: Replacing international credit card settlement with direct USD/USDC wire or export-linked USD account saves $${iofAndSpreadSavingsUsd.toFixed(2)} (3.38% IOF + ~4% bank FX spread).`
      );
    }

    return {
      category,
      deductible: true,
      taxSavingsBreakdown: {
        incomeTaxShieldUsd,
        pisCofinsCreditUsd,
        ibsCbsReadinessCreditUsd,
        iofAndSpreadSavingsUsd,
      },
      taxSavedUsd,
      complianceChecklist,
    };
  }

  // PJ_SIMPLES_EXPORT (or fallback non-Lucro-Real corporate)
  const complianceChecklist: string[] = [
    "Simples Nacional Regime: Taxes apply on gross revenue (DAS); operating expenses do not generate IRPJ/CSLL deductions or PIS/COFINS credits.",
    input.paidWithInternationalCard
      ? `FX & IOF Savings Alert: Switching from Brazilian international credit card to USD/USDC settlement saves $${iofAndSpreadSavingsUsd.toFixed(2)} (3.38% IOF + ~4% bank FX spread).`
      : "FX Settlement Verified: Maintain direct USD/USDC or offshore export-proceeds settlement to avoid 3.38% IOF and bank FX spreads.",
    "Service Export Proof: Retain signed Service Agreement, commercial Invoice, and foreign-client payment/USDC off-ramp reconciliation to substantiate PIS/COFINS/ISS export exemption (LC 116/2003 Art. 2º, I).",
    input.hasFiscalDocument && input.fiscalDocumentId
      ? `Fiscal Document Verified: Reference "${input.fiscalDocumentId}" attached for DAS/NFS-e export reconciliation.`
      : "Fiscal Document Required: Issue NFS-e de Exportação matching the exact USD/BRL PTAX conversion and attach cross-border settlement proof.",
  ];

  return {
    category,
    deductible: false,
    taxSavingsBreakdown: {
      incomeTaxShieldUsd: 0,
      pisCofinsCreditUsd: 0,
      ibsCbsReadinessCreditUsd: 0,
      iofAndSpreadSavingsUsd,
    },
    taxSavedUsd: iofAndSpreadSavingsUsd,
    complianceChecklist,
  };
}
