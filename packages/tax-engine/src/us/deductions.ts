import type { DeductibleExpenseInput } from "@taxrail/shared";
import {
  assertJurisdictionRegime,
  classifyExpenseCategory,
  type ExpenseCategory,
  round2,
} from "../utils.js";

export interface UsExpenseClassificationResult {
  category: ExpenseCategory;
  irsScheduleCategory: string;
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

const IRS_SCHEDULE_MAP: Readonly<Record<ExpenseCategory, string>> = {
  "Cloud & AI Compute": "Schedule C Line 27a / Form 1120 Other Deductions (Cloud & Compute)",
  "Software & SaaS": "Schedule C Line 18 / Form 1120 Office & Software Subscriptions",
  "Marketing & Ads": "Schedule C Line 8 / Form 1120 Advertising",
  "Professional Services": "Schedule C Line 17 / Form 1120 Legal & Professional Services",
  "Travel & Lodging": "Schedule C Line 24a / Form 1120 Travel (50% meal rules separate)",
  "General Business Expense": "Schedule C Line 27a / Form 1120 Ordinary & Necessary Business Expense",
};

/**
 * Classifies a US business expense into IRS Schedule C / Corporate (Form 1120) categories,
 * computes the federal income tax shield (21% for C-Corp under IRC §11; 32% marginal rate
 * for Individual / LLC pass-through), and generates an IRC §162 compliance checklist.
 */
export function classifyUsDeductibleExpense(
  input: DeductibleExpenseInput
): UsExpenseClassificationResult {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const category = classifyExpenseCategory(input.vendorName, input.description);
  const irsScheduleCategory = IRS_SCHEDULE_MAP[category];
  const shieldRate = input.regime === "C_CORP" ? 0.21 : 0.32;
  const incomeTaxShieldUsd = round2(input.amountUsd * shieldRate);

  const complianceChecklist: string[] = [
    `IRS Mapping: Record under ${irsScheduleCategory}.`,
    "Vendor Tax Form: Collect Form W-9 (US vendor) or Form W-8BEN-E (non-US entity) prior to settlement.",
    input.hasFiscalDocument && input.fiscalDocumentId
      ? `Itemized Invoice Verified: Document ID "${input.fiscalDocumentId}" attached for IRC §162 substantiation.`
      : "Itemized Invoice Required: Obtain and retain itemized vendor invoice/receipt showing date, amount, and service description (IRC §162).",
    `Business Purpose Log: Document contemporaneous business rationale linking "${input.vendorName}" (${category}) to revenue-producing operations.`,
  ];

  if (category === "Professional Services") {
    complianceChecklist.push(
      "Form 1099-NEC Check: Track cumulative annual payments to non-corporate US contractors; file Form 1099-NEC if >= $600/year."
    );
  }

  if (category === "Travel & Lodging") {
    complianceChecklist.push(
      "Travel Substantiation (IRC §274): Retain itinerary, business meeting logs, and separate any meals (generally 50% deductible) from lodging/airfare (100% deductible)."
    );
  }

  return {
    category,
    irsScheduleCategory,
    deductible: true,
    taxSavingsBreakdown: {
      incomeTaxShieldUsd,
      pisCofinsCreditUsd: 0,
      ibsCbsReadinessCreditUsd: 0,
      iofAndSpreadSavingsUsd: 0,
    },
    taxSavedUsd: incomeTaxShieldUsd,
    complianceChecklist,
  };
}
