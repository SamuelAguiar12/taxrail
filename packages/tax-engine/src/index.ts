export {
  optimizeUsCapitalGains,
  type UsCapitalGainsResult,
} from "./us/capital-gains.js";

export { scanUsTlhOpportunities } from "./us/tlh.js";

export {
  classifyUsDeductibleExpense,
  type UsExpenseClassificationResult,
} from "./us/deductions.js";

export {
  optimizeBrCryptoTax,
  computeBrProgressiveCapitalGainsTaxBrl,
  type BrCryptoTaxResult,
} from "./br/crypto-tax.js";

export {
  classifyBrDeductibleExpense,
  type BrExpenseClassificationResult,
} from "./br/corporate.js";

export {
  evaluateBorrowVsSell,
  type BorrowVsSellEvaluation,
} from "./borrow-vs-sell.js";

export { calculateDynamicPricing } from "./pricing.js";

export {
  analyzeCryptoDisposal,
  analyzeBorrowVsSell,
  analyzeDeductibleExpense,
  type AnalyzeCryptoDisposalResult,
} from "./orchestrator.js";

export {
  TAXRAIL_DISCLAIMER,
  classifyExpenseCategory,
  computeHoldingDays,
  round2,
  round8,
  type ExpenseCategory,
} from "./utils.js";
