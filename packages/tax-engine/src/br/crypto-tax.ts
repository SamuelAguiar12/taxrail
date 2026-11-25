import type { CheckTaxImpactInput, SelectedLotDisposal, TaxLot } from "@taxrail/shared";
import {
  assertJurisdictionRegime,
  computeHoldingDays,
  filterMatchingLots,
  resolveDisposalQuantity,
  round2,
  round8,
} from "../utils.js";

export interface BrCryptoTaxResult {
  baselineStrategy: string;
  recommendedStrategy: string;
  baselineTaxUsd: number;
  optimizedTaxUsd: number;
  taxSavedUsd: number;
  selectedLots: SelectedLotDisposal[];
  warnings: string[];
}

/**
 * Lei nº 13.259/2016 progressive capital gains tax table for Brazilian domestic PF disposals:
 * - Up to R$ 5M: 15%
 * - R$ 5M to R$ 10M: 17.5%
 * - R$ 10M to R$ 30M: 20%
 * - Above R$ 30M: 22.5%
 */
export function computeBrProgressiveCapitalGainsTaxBrl(netGainBrl: number): {
  taxBrl: number;
  effectiveRate: number;
} {
  if (netGainBrl <= 0) {
    return { taxBrl: 0, effectiveRate: 0 };
  }

  const brackets: ReadonlyArray<{ limit: number; rate: number }> = [
    { limit: 5_000_000, rate: 0.15 },
    { limit: 10_000_000, rate: 0.175 },
    { limit: 30_000_000, rate: 0.20 },
    { limit: Number.POSITIVE_INFINITY, rate: 0.225 },
  ];

  let remaining = netGainBrl;
  let prevLimit = 0;
  let taxBrl = 0;

  for (const bracket of brackets) {
    if (remaining <= 0) break;
    const span = bracket.limit - prevLimit;
    const taxableInBracket = Math.min(remaining, span);
    taxBrl += taxableInBracket * bracket.rate;
    remaining -= taxableInBracket;
    prevLimit = bracket.limit;
  }

  return {
    taxBrl,
    effectiveRate: taxBrl / netGainBrl,
  };
}

function allocateBrLots(
  orderedLots: TaxLot[],
  quantityToSell: number,
  currentPriceUsd: number,
  asOfDate: string,
  term: "LEI_14754" | "BR_DOMESTIC",
  effectiveTaxRate: number
): SelectedLotDisposal[] {
  let remaining = quantityToSell;
  const disposals: SelectedLotDisposal[] = [];

  for (const lot of orderedLots) {
    if (remaining <= 1e-9) break;
    const qty = round8(Math.min(remaining, lot.quantity));
    if (qty <= 0) continue;

    const proceedsUsd = round2(qty * currentPriceUsd);
    const costBasisTotalUsd = round2(qty * lot.costBasisUsd);
    const gainOrLossUsd = round2(proceedsUsd - costBasisTotalUsd);
    const holdingDays = computeHoldingDays(lot.acquiredAt, asOfDate);

    disposals.push({
      lotId: lot.lotId,
      asset: lot.asset,
      quantityToSell: qty,
      proceedsUsd,
      costBasisTotalUsd,
      gainOrLossUsd,
      holdingDays,
      term,
      effectiveTaxRate: Number(effectiveTaxRate.toFixed(4)),
      estimatedTaxUsd: round2(gainOrLossUsd * effectiveTaxRate),
    });

    remaining = round8(remaining - qty);
  }

  return disposals;
}

function sumNetGain(disposals: SelectedLotDisposal[]): number {
  return disposals.reduce((sum, d) => sum + d.gainOrLossUsd, 0);
}

/**
 * Optimizes Brazilian crypto disposals across:
 * - `PF_LEI_14754`: 15% flat tax on offshore/self-custody net gains with YTD + carryforward loss offset.
 * - `PF_DOMESTIC`: R$ 35,000 monthly gross sales exemption (IN RFB 1.888) and 15%–22.5% progressive table
 *   above R$ 35k, flagging deferral/splitting opportunities to stay exempt.
 * - `PJ_LUCRO_REAL`: 34% corporate IRPJ/CSLL rate on realized gains with loss offset.
 */
export function optimizeBrCryptoTax(input: CheckTaxImpactInput): BrCryptoTaxResult {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const asOfDate = input.asOfDate ?? new Date().toISOString();
  const usdBrlRate = input.context?.usdBrlRate ?? 5.80;
  const matchingLots = filterMatchingLots(input.lots, input.targetAsset);
  const { quantityToSell, warnings } = resolveDisposalQuantity(input, matchingLots);

  if (quantityToSell <= 0 || matchingLots.length === 0) {
    return {
      baselineStrategy: "BR_FIFO",
      recommendedStrategy: `BR_${input.regime}`,
      baselineTaxUsd: 0,
      optimizedTaxUsd: 0,
      taxSavedUsd: 0,
      selectedLots: [],
      warnings,
    };
  }

  const fifoLots = [...matchingLots].sort(
    (a, b) => Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt)
  );
  // Tax-optimal lot order: highest cost basis first (minimizes taxable gain / harvests losses)
  const hifoLots = [...matchingLots].sort((a, b) => {
    if (Math.abs(b.costBasisUsd - a.costBasisUsd) > 1e-9) {
      return b.costBasisUsd - a.costBasisUsd;
    }
    return Date.parse(a.acquiredAt) - Date.parse(b.acquiredAt);
  });

  const availableLossesUsd =
    (input.context?.realizedLossesYtdUsd ?? 0) + (input.context?.carryforwardLossesUsd ?? 0);

  if (input.regime === "PF_LEI_14754") {
    const rate = 0.15;
    const fifoDisposals = allocateBrLots(
      fifoLots,
      quantityToSell,
      input.currentPriceUsd,
      asOfDate,
      "LEI_14754",
      rate
    );
    const hifoDisposals = allocateBrLots(
      hifoLots,
      quantityToSell,
      input.currentPriceUsd,
      asOfDate,
      "LEI_14754",
      rate
    );

    // Baseline: naive uncompensated FIFO disposal (ignores YTD / carryforward offshore losses)
    const baselineNetGain = Math.max(0, sumNetGain(fifoDisposals));
    const baselineTaxUsd = round2(baselineNetGain * rate);

    // Optimized: tax-optimal lots + Lei 14.754 loss compensation
    const optRawGain = sumNetGain(hifoDisposals);
    const optimizedNetGain = Math.max(0, optRawGain - availableLossesUsd);
    const optimizedTaxUsd = round2(optimizedNetGain * rate);
    const taxSavedUsd = Math.max(0, round2(baselineTaxUsd - optimizedTaxUsd));

    warnings.push(
      "Lei 14.754/2023: Offshore and self-custody crypto gains are taxed annually at 15% on DAA with no R$ 35,000 monthly exemption; losses from foreign financial applications/virtual assets may be compensated."
    );
    if (matchingLots.length > 1) {
      warnings.push(
        "RFB Preço Médio Rule: Verify whether holdings sit in a single exchange/wallet requiring weighted-average cost (Preço Médio) rather than segregated lot identification."
      );
    }

    return {
      baselineStrategy: "BR_LEI_14754_FIFO_UNCOMPENSATED",
      recommendedStrategy: "BR_LEI_14754_LOSS_COMPENSATED",
      baselineTaxUsd,
      optimizedTaxUsd,
      taxSavedUsd,
      selectedLots: hifoDisposals,
      warnings,
    };
  }

  if (input.regime === "PF_DOMESTIC") {
    const priorMonthlySalesBrl = input.context?.monthlyGrossSalesBrl ?? 0;
    const proceedsUsd = round2(quantityToSell * input.currentPriceUsd);
    const proceedsBrl = round2(proceedsUsd * usdBrlRate);
    const totalMonthlySalesBrl = round2(priorMonthlySalesBrl + proceedsBrl);
    const EXEMPTION_BRL = 35_000;

    if (totalMonthlySalesBrl <= EXEMPTION_BRL) {
      const exemptDisposals = allocateBrLots(
        hifoLots,
        quantityToSell,
        input.currentPriceUsd,
        asOfDate,
        "BR_DOMESTIC",
        0
      );
      const remainingHeadroomBrl = round2(EXEMPTION_BRL - totalMonthlySalesBrl);
      warnings.push(
        `IN RFB 1.888 Exemption Preserved: Combined monthly gross sales of R$ ${totalMonthlySalesBrl.toFixed(2)} (at USD/BRL ${usdBrlRate.toFixed(2)}) remain within the R$ 35,000.00 monthly exemption. Remaining monthly headroom: R$ ${remainingHeadroomBrl.toFixed(2)}.`
      );

      return {
        baselineStrategy: "BR_DOMESTIC_FIFO",
        recommendedStrategy: "BR_DOMESTIC_EXEMPT_UNDER_35K",
        baselineTaxUsd: 0,
        optimizedTaxUsd: 0,
        taxSavedUsd: 0,
        selectedLots: exemptDisposals,
        warnings,
      };
    }

    // Exceeds R$ 35,000 monthly gross sales -> progressive 15%–22.5% table (Lei 13.259)
    const fifoRawDisposals = allocateBrLots(
      fifoLots,
      quantityToSell,
      input.currentPriceUsd,
      asOfDate,
      "BR_DOMESTIC",
      0.15
    );
    const fifoNetGainBrl = Math.max(0, sumNetGain(fifoRawDisposals) * usdBrlRate);
    const fifoTax = computeBrProgressiveCapitalGainsTaxBrl(fifoNetGainBrl);
    const baselineTaxUsd = round2(fifoTax.taxBrl / usdBrlRate);

    const hifoPrelim = allocateBrLots(
      hifoLots,
      quantityToSell,
      input.currentPriceUsd,
      asOfDate,
      "BR_DOMESTIC",
      0.15
    );
    const hifoNetGainBrl = Math.max(0, sumNetGain(hifoPrelim) * usdBrlRate);
    const hifoTax = computeBrProgressiveCapitalGainsTaxBrl(hifoNetGainBrl);
    const optimizedTaxUsd = round2(hifoTax.taxBrl / usdBrlRate);
    const taxSavedUsd = Math.max(0, round2(baselineTaxUsd - optimizedTaxUsd));

    const effectiveRate = hifoTax.effectiveRate || 0.15;
    const selectedLots = allocateBrLots(
      hifoLots,
      quantityToSell,
      input.currentPriceUsd,
      asOfDate,
      "BR_DOMESTIC",
      effectiveRate
    );

    const headroomThisMonthBrl = Math.max(0, round2(EXEMPTION_BRL - priorMonthlySalesBrl));
    if (proceedsBrl <= EXEMPTION_BRL) {
      warnings.push(
        `R$ 35k Split/Deferral Alert: Total monthly sales (R$ ${totalMonthlySalesBrl.toFixed(2)}) exceed R$ 35,000.00 only because R$ ${priorMonthlySalesBrl.toFixed(2)} was already sold this month. Deferring this R$ ${proceedsBrl.toFixed(2)} disposal to next calendar month (or selling only R$ ${headroomThisMonthBrl.toFixed(2)} this month and the rest next month) keeps each month under R$ 35,000 and eliminates $${optimizedTaxUsd.toFixed(2)} in GCAP tax.`
      );
    } else {
      const monthsToSplit = Math.ceil(proceedsBrl / EXEMPTION_BRL);
      const maxMonthlyUsd = round2(EXEMPTION_BRL / usdBrlRate);
      warnings.push(
        `R$ 35k Split/Deferral Alert: Disposal proceeds of R$ ${proceedsBrl.toFixed(2)} (total monthly R$ ${totalMonthlySalesBrl.toFixed(2)}) exceed the R$ 35,000.00 monthly exemption. Splitting across ${monthsToSplit} calendar months (<= R$ 35,000 / ~$${maxMonthlyUsd.toFixed(2)} per month) qualifies each tranche for full exemption, saving up to $${optimizedTaxUsd.toFixed(2)}.`
      );
    }

    warnings.push(
      "PF_DOMESTIC Note: Domestic individual crypto capital losses cannot be carried forward to offset future GCAP gains; DARF (código 4600) is due by the last business day of the month following disposal."
    );

    return {
      baselineStrategy: "BR_DOMESTIC_FIFO",
      recommendedStrategy: "BR_DOMESTIC_PROGRESSIVE_SPLIT_ADVISED",
      baselineTaxUsd,
      optimizedTaxUsd,
      taxSavedUsd,
      selectedLots,
      warnings,
    };
  }

  // PJ_LUCRO_REAL (34% corporate IRPJ + CSLL) or PJ_SIMPLES_EXPORT fallback (15%–22.5% Ganho de Capital)
  const isLucroReal = input.regime === "PJ_LUCRO_REAL";
  const corpRate = isLucroReal ? 0.34 : 0.15;

  const fifoDisposals = allocateBrLots(
    fifoLots,
    quantityToSell,
    input.currentPriceUsd,
    asOfDate,
    "BR_DOMESTIC",
    corpRate
  );
  const hifoDisposals = allocateBrLots(
    hifoLots,
    quantityToSell,
    input.currentPriceUsd,
    asOfDate,
    "BR_DOMESTIC",
    corpRate
  );

  const baselineTaxUsd = round2(Math.max(0, sumNetGain(fifoDisposals)) * corpRate);
  const optNetGain = isLucroReal
    ? Math.max(0, sumNetGain(hifoDisposals) - availableLossesUsd)
    : Math.max(0, sumNetGain(hifoDisposals));
  const optimizedTaxUsd = round2(optNetGain * corpRate);
  const taxSavedUsd = Math.max(0, round2(baselineTaxUsd - optimizedTaxUsd));

  if (isLucroReal) {
    warnings.push(
      "PJ Lucro Real: Realized crypto gains are taxed at 34% (15% IRPJ + 10% surtax + 9% CSLL). Note that prior-year tax loss carryforwards (Prejuízo Fiscal) are subject to the 30% annual taxable-profit offset cap (trava dos 30%)."
    );
  } else {
    warnings.push(
      "PJ Simples Nacional: Capital gains on digital assets are taxed separately outside the DAS unified guide under Ganho de Capital (15%–22.5%)."
    );
  }

  return {
    baselineStrategy: `BR_${input.regime}_FIFO`,
    recommendedStrategy: `BR_${input.regime}_OPTIMIZED`,
    baselineTaxUsd,
    optimizedTaxUsd,
    taxSavedUsd,
    selectedLots: hifoDisposals,
    warnings,
  };
}
