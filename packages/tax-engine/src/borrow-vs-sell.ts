import type { BorrowVsSellInput } from "@taxrail/shared";
import { assertJurisdictionRegime, round2 } from "./utils.js";

export interface BorrowVsSellEvaluation {
  recommendation: "BORROW_AAVE_V3" | "SELL_OPTIMIZED_LOTS";
  sellTaxCostUsd: number;
  netBorrowCostUsd: number;
  corporateInterestTaxShieldUsd: number;
  taxSavedUsd: number;
  projectedLtvPct: number;
  liquidationWarning: string | null;
}

function resolveCollateralSellTaxRate(input: BorrowVsSellInput): number {
  if (input.jurisdiction === "US") {
    if (input.regime === "C_CORP") {
      return 0.21;
    }
    const marginalRate = Math.min(0.37, Math.max(0, input.marginalOrdinaryRate ?? 0.32));
    if (input.holdingDays > 365) {
      return marginalRate >= 0.35 ? 0.20 : 0.15;
    }
    return marginalRate;
  }

  // Brazil regimes
  switch (input.regime) {
    case "PF_LEI_14754":
      return 0.15;
    case "PF_DOMESTIC": {
      const estimatedProceedsBrl = input.liquidityNeededUsd * 5.80;
      return estimatedProceedsBrl <= 35_000 ? 0 : 0.15;
    }
    case "PJ_LUCRO_REAL":
      return 0.34;
    case "PJ_SIMPLES_EXPORT":
      return 0.15;
    default:
      return 0.15;
  }
}

/**
 * Compares the immediate tax cost of liquidating appreciated collateral vs borrowing
 * USDC against that collateral on Aave V3 (`netBorrowCostUsd = interest - corporate shield`),
 * and computes projected LTV with a >65% liquidation risk warning.
 */
export function evaluateBorrowVsSell(input: BorrowVsSellInput): BorrowVsSellEvaluation {
  assertJurisdictionRegime(input.jurisdiction, input.regime);

  const collateralValueUsd = input.collateralAmount * input.collateralPriceUsd;
  const unitsToSell = Math.min(
    input.collateralAmount,
    input.liquidityNeededUsd / input.collateralPriceUsd
  );
  const unrealizedGainPerUnit = Math.max(0, input.collateralPriceUsd - input.collateralCostBasisUsd);
  const realizedGainOnSellUsd = unitsToSell * unrealizedGainPerUnit;

  const sellTaxRate = resolveCollateralSellTaxRate(input);
  const sellTaxCostUsd = round2(realizedGainOnSellUsd * sellTaxRate);

  const borrowApr = input.borrowApr ?? 0.055;
  const horizonDays = input.horizonDays ?? 180;
  const grossBorrowCostUsd = input.liquidityNeededUsd * borrowApr * (horizonDays / 365);

  // Corporate interest expense deductibility: 21% US C-Corp (IRC §163(j) assumed compliant),
  // 34% BR Lucro Real (IRPJ + CSLL). Individuals generally cannot deduct investment interest against crypto gains.
  const shieldRate =
    input.regime === "C_CORP" ? 0.21 : input.regime === "PJ_LUCRO_REAL" ? 0.34 : 0;
  const corporateInterestTaxShieldUsd = round2(grossBorrowCostUsd * shieldRate);
  const netBorrowCostUsd = round2(Math.max(0, grossBorrowCostUsd - corporateInterestTaxShieldUsd));

  const projectedLtvPct = round2((input.liquidityNeededUsd / collateralValueUsd) * 100);
  const liquidationWarning =
    projectedLtvPct > 65
      ? `High liquidation risk: projected LTV is ${projectedLtvPct.toFixed(2)}% (> 65% safety threshold). Add collateral or reduce borrow size to maintain an Aave V3 health factor buffer.`
      : null;

  const recommendation: "BORROW_AAVE_V3" | "SELL_OPTIMIZED_LOTS" =
    sellTaxCostUsd > netBorrowCostUsd ? "BORROW_AAVE_V3" : "SELL_OPTIMIZED_LOTS";
  const taxSavedUsd = Math.max(0, round2(sellTaxCostUsd - netBorrowCostUsd));

  return {
    recommendation,
    sellTaxCostUsd,
    netBorrowCostUsd,
    corporateInterestTaxShieldUsd,
    taxSavedUsd,
    projectedLtvPct,
    liquidationWarning,
  };
}
