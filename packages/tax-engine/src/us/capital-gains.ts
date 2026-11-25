import type { CheckTaxImpactInput, SelectedLotDisposal, TaxLot } from "@taxrail/shared";
import {
  assertJurisdictionRegime,
  computeHoldingDays,
  filterMatchingLots,
  resolveDisposalQuantity,
  round2,
  round8,
} from "../utils.js";

export interface UsCapitalGainsResult {
  baselineStrategy: "US_FIFO";
  recommendedStrategy: "US_HIFO_SPEC_ID";
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  selectedLots: SelectedLotDisposal[];
  warnings: string[];
}

interface EvaluatedLot {
  lot: TaxLot;
  holdingDays: number;
  term: "SHORT_TERM" | "LONG_TERM";
  effectiveTaxRate: number;
  gainPerUnitUsd: number;
  taxPerUnitUsd: number;
}

/**
 * Resolves US ST/LT capital gains tax rates under IRC §§1(h), 11, 1222, and 1411 (NIIT).
 * - Individuals & LLC pass-throughs: ST = marginal ordinary (default 0.32, capped 0.37);
 *   LT (>365 days) = 0.15 (or 0.20 if marginal >= 0.35); optional +3.8% NIIT.
 * - C-Corps: flat 21% rate on both ST and LT gains (no NIIT).
 */
function resolveUsRates(input: CheckTaxImpactInput): {
  stRate: number;
  ltRate: number;
  niitWarning: string | null;
} {
  if (input.regime === "C_CORP") {
    return {
      stRate: 0.21,
      ltRate: 0.21,
      niitWarning: input.context?.applyNiit
        ? "NIIT (3.8% under IRC §1411) does not apply to C-Corporations; flat 21% corporate rate applied."
        : null,
    };
  }

  const marginalRate = Math.min(0.37, Math.max(0, input.context?.marginalOrdinaryRate ?? 0.32));
  const niitRate = input.context?.applyNiit ? 0.038 : 0;
  const baseLtRate = marginalRate >= 0.35 ? 0.20 : 0.15;

  return {
    stRate: marginalRate + niitRate,
    ltRate: baseLtRate + niitRate,
    niitWarning: null,
  };
}

function evaluateLots(
  lots: TaxLot[],
  currentPriceUsd: number,
  asOfDate: string,
  stRate: number,
  ltRate: number
): EvaluatedLot[] {
  return lots.map((lot) => {
    const holdingDays = computeHoldingDays(lot.acquiredAt, asOfDate);
    // IRC §1222: long-term requires holding strictly more than 1 year (> 365 days).
    const isLongTerm = holdingDays > 365;
    const term = isLongTerm ? "LONG_TERM" : "SHORT_TERM";
    const effectiveTaxRate = isLongTerm ? ltRate : stRate;
    const gainPerUnitUsd = currentPriceUsd - lot.costBasisUsd;
    const taxPerUnitUsd = gainPerUnitUsd * effectiveTaxRate;

    return {
      lot,
      holdingDays,
      term,
      effectiveTaxRate,
      gainPerUnitUsd,
      taxPerUnitUsd,
    };
  });
}

function allocateLots(
  orderedLots: EvaluatedLot[],
  quantityToSell: number,
  currentPriceUsd: number
): SelectedLotDisposal[] {
  let remaining = quantityToSell;
  const disposals: SelectedLotDisposal[] = [];

  for (const item of orderedLots) {
    if (remaining <= 1e-9) break;
    const qty = round8(Math.min(remaining, item.lot.quantity));
    if (qty <= 0) continue;

    const proceedsUsd = round2(qty * currentPriceUsd);
    const costBasisTotalUsd = round2(qty * item.lot.costBasisUsd);
    const gainOrLossUsd = round2(proceedsUsd - costBasisTotalUsd);
    const estimatedTaxUsd = round2(gainOrLossUsd * item.effectiveTaxRate);

    disposals.push({
      lotId: item.lot.lotId,
      asset: item.lot.asset,
      quantityToSell: qty,
      proceedsUsd,
      costBasisTotalUsd,
      gainOrLossUsd,
      holdingDays: item.holdingDays,
      term: item.term,
      effectiveTaxRate: Number(item.effectiveTaxRate.toFixed(4)),
      estimatedTaxUsd,
    });

    remaining = round8(remaining - qty);
  }

  return disposals;
}

/**
 * Computes net US capital gains tax under IRS Schedule D netting rules,
 * cross-netting ST/LT within the disposal and applying YTD realized losses
 * plus prior-year capital loss carryforwards.
 */
function computeNetUsDisposalTax(
  disposals: SelectedLotDisposal[],
  stRate: number,
  ltRate: number,
  availableLossesUsd: number
): number {
  let stNet = 0;
  let ltNet = 0;

  for (const d of disposals) {
    if (d.term === "SHORT_TERM") {
      stNet += d.gainOrLossUsd;
    } else {
      ltNet += d.gainOrLossUsd;
    }
  }

  // Step 1: Cross-net ST and LT inside the disposal
  if (stNet < 0 && ltNet > 0) {
    const combined = stNet + ltNet;
    stNet = combined < 0 ? combined : 0;
    ltNet = combined > 0 ? combined : 0;
  } else if (ltNet < 0 && stNet > 0) {
    const combined = stNet + ltNet;
    stNet = combined > 0 ? combined : 0;
    ltNet = combined < 0 ? combined : 0;
  }

  // Step 2: Apply YTD realized losses + prior carryforward losses (ST first, then LT)
  let remainingLosses = Math.max(0, availableLossesUsd);
  if (stNet > 0 && remainingLosses > 0) {
    const offset = Math.min(stNet, remainingLosses);
    stNet -= offset;
    remainingLosses -= offset;
  }
  if (ltNet > 0 && remainingLosses > 0) {
    const offset = Math.min(ltNet, remainingLosses);
    ltNet -= offset;
    remainingLosses -= offset;
  }

  const totalTax = Math.max(0, stNet) * stRate + Math.max(0, ltNet) * ltRate;
  return round2(Math.max(0, totalTax));
}

/**
 * Compares naive US FIFO disposal against tax-optimal Specific Identification (HIFO / SpecID).
 * Incorporates the 365-day ST/LT boundary, optional 3.8% NIIT, YTD realized losses,
 * and capital loss carryforwards.
 */
export function optimizeUsCapitalGains(input: CheckTaxImpactInput): UsCapitalGainsResult {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const asOfDate = input.asOfDate ?? new Date().toISOString();
  const matchingLots = filterMatchingLots(input.lots, input.targetAsset);
  const { quantityToSell, warnings } = resolveDisposalQuantity(input, matchingLots);

  if (quantityToSell <= 0 || matchingLots.length === 0) {
    return {
      baselineStrategy: "US_FIFO",
      recommendedStrategy: "US_HIFO_SPEC_ID",
      baselineTaxUsd: 0,
      optimizedTaxUsd: 0,
      taxSavedUsd: 0,
      selectedLots: [],
      warnings,
    };
  }

  const { stRate, ltRate, niitWarning } = resolveUsRates(input);
  if (niitWarning) warnings.push(niitWarning);

  const evaluated = evaluateLots(matchingLots, input.currentPriceUsd, asOfDate, stRate, ltRate);
  const availableLossesUsd =
    (input.context?.realizedLossesYtdUsd ?? 0) + (input.context?.carryforwardLossesUsd ?? 0);

  // Baseline: FIFO (oldest acquiredAt first)
  const fifoOrdered = [...evaluated].sort(
    (a, b) => Date.parse(a.lot.acquiredAt) - Date.parse(b.lot.acquiredAt)
  );
  const fifoDisposals = allocateLots(fifoOrdered, quantityToSell, input.currentPriceUsd);
  const baselineTaxUsd = computeNetUsDisposalTax(
    fifoDisposals,
    stRate,
    ltRate,
    availableLossesUsd
  );

  // Optimal: SpecID / HIFO (lowest tax per unit disposed first; tie-break highest basis, then longest held)
  const specIdOrdered = [...evaluated].sort((a, b) => {
    if (Math.abs(a.taxPerUnitUsd - b.taxPerUnitUsd) > 1e-9) {
      return a.taxPerUnitUsd - b.taxPerUnitUsd;
    }
    if (Math.abs(b.lot.costBasisUsd - a.lot.costBasisUsd) > 1e-9) {
      return b.lot.costBasisUsd - a.lot.costBasisUsd;
    }
    return b.holdingDays - a.holdingDays;
  });

  const selectedLots = allocateLots(specIdOrdered, quantityToSell, input.currentPriceUsd);
  const optimizedTaxUsd = computeNetUsDisposalTax(
    selectedLots,
    stRate,
    ltRate,
    availableLossesUsd
  );
  const taxSavedUsd = Math.max(0, round2(baselineTaxUsd - optimizedTaxUsd));

  // Regulatory & operational warnings (NEVER include lotId in warnings)
  warnings.push(
    "IRS Form 1099-DA & Rev. Proc. 2024-28: Specific Identification (HIFO/SpecID) must be documented contemporaneously prior to execution on a per-wallet / per-account basis."
  );

  const nearLongTermLots = selectedLots.filter(
    (d) => d.term === "SHORT_TERM" && d.holdingDays >= 335 && d.holdingDays <= 365 && d.gainOrLossUsd > 0
  );
  if (nearLongTermLots.length > 0) {
    const minDaysRemaining = Math.min(...nearLongTermLots.map((d) => 366 - d.holdingDays));
    warnings.push(
      `One or more selected short-term gain lots are within ${minDaysRemaining} day(s) of crossing the 365-day long-term capital gains threshold.`
    );
  }

  const custodyTypes = new Set(matchingLots.map((l) => l.custodyLocation));
  if (custodyTypes.size > 1) {
    warnings.push(
      "Holdings span multiple custody locations (domestic/offshore/self-custody); verify wallet-by-wallet SpecID segregation under Rev. Proc. 2024-28."
    );
  }

  return {
    baselineStrategy: "US_FIFO",
    recommendedStrategy: "US_HIFO_SPEC_ID",
    baselineTaxUsd,
    optimizedTaxUsd,
    taxSavedUsd,
    selectedLots,
    warnings,
  };
}
