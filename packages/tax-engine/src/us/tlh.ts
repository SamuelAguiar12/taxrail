import type { CheckTaxImpactInput, SelectedLotDisposal, TlhOpportunity } from "@taxrail/shared";
import { filterMatchingLots, round2, round8 } from "../utils.js";
import { optimizeUsCapitalGains } from "./capital-gains.js";

const CORRELATED_REPLACEMENTS: Readonly<Record<string, string>> = {
  WBTC: "cbBTC",
  BTC: "WBTC",
  WETH: "wstETH",
  ETH: "wstETH",
  SOL: "jitoSOL",
};

function suggestReplacementAsset(asset: string): string {
  const normalized = asset.trim().toUpperCase();
  return CORRELATED_REPLACEMENTS[normalized] ?? `${normalized}-CORRELATED`;
}

/**
 * Scans remaining (non-selected) lots of `targetAsset` with unrealized losses
 * (`currentPriceUsd < costBasisUsd`) and quantifies Tax-Loss Harvesting (TLH)
 * shields using the short-term rate against realized gains plus up to $3,000
 * annual ordinary income offset (IRC §1211(b) for non-corporate taxpayers).
 */
export function scanUsTlhOpportunities(
  input: CheckTaxImpactInput,
  preselectedLots?: SelectedLotDisposal[]
): TlhOpportunity[] {
  const selectedLots = preselectedLots ?? optimizeUsCapitalGains(input).selectedLots;

  const soldQtyByLot = new Map<string, number>();
  let currentDisposalNetGain = 0;
  for (const disposal of selectedLots) {
    soldQtyByLot.set(
      disposal.lotId,
      round8((soldQtyByLot.get(disposal.lotId) ?? 0) + disposal.quantityToSell)
    );
    currentDisposalNetGain += disposal.gainOrLossUsd;
  }

  const matchingLots = filterMatchingLots(input.lots, input.targetAsset);

  const candidateLots = matchingLots
    .map((lot) => {
      const soldQty = soldQtyByLot.get(lot.lotId) ?? 0;
      const remainingQty = round8(Math.max(0, lot.quantity - soldQty));
      const unrealizedLossUsd =
        remainingQty > 0 && input.currentPriceUsd < lot.costBasisUsd
          ? round2((lot.costBasisUsd - input.currentPriceUsd) * remainingQty)
          : 0;

      return {
        lot,
        remainingQty,
        unrealizedLossUsd,
      };
    })
    .filter((item) => item.remainingQty > 0 && item.unrealizedLossUsd > 0)
    .sort((a, b) => b.unrealizedLossUsd - a.unrealizedLossUsd);

  if (candidateLots.length === 0) {
    return [];
  }

  const isCorp = input.regime === "C_CORP";
  const marginalRate = isCorp
    ? 0.21
    : Math.min(0.37, Math.max(0, input.context?.marginalOrdinaryRate ?? 0.32));
  const niitRate = !isCorp && input.context?.applyNiit ? 0.038 : 0;
  const stCapitalRate = marginalRate + niitRate;
  const ordinaryRate = marginalRate;

  const priorGains = input.context?.realizedGainsYtdUsd ?? 0;
  const priorLosses =
    (input.context?.realizedLossesYtdUsd ?? 0) + (input.context?.carryforwardLossesUsd ?? 0);

  let remainingGainPool = Math.max(0, priorGains + currentDisposalNetGain - priorLosses);
  // IRC §1211(b): Individuals/pass-throughs may deduct up to $3,000 of net capital losses
  // against ordinary income per tax year; C-Corps cannot offset ordinary income.
  let remainingOrdinaryOffset = isCorp ? 0 : 3000;

  return candidateLots.map(({ lot, remainingQty, unrealizedLossUsd }) => {
    const offsetAgainstGains = Math.min(unrealizedLossUsd, remainingGainPool);
    remainingGainPool = Math.max(0, remainingGainPool - offsetAgainstGains);

    const leftoverAfterGains = Math.max(0, unrealizedLossUsd - offsetAgainstGains);
    const offsetAgainstOrdinary = Math.min(leftoverAfterGains, remainingOrdinaryOffset);
    remainingOrdinaryOffset = Math.max(0, remainingOrdinaryOffset - offsetAgainstOrdinary);

    const carryforwardLossUsd = round2(Math.max(0, leftoverAfterGains - offsetAgainstOrdinary));
    const estimatedTaxShieldUsd = round2(
      offsetAgainstGains * stCapitalRate + offsetAgainstOrdinary * ordinaryRate
    );

    const replacement = suggestReplacementAsset(lot.asset);
    const rationaleParts = [
      `Harvest ${round8(remainingQty)} ${lot.asset} at $${input.currentPriceUsd} (basis $${lot.costBasisUsd}) to realize $${unrealizedLossUsd.toFixed(2)} capital loss.`,
      `Rotate into correlated non-identical ${replacement} to maintain beta exposure while mitigating economic-substance / wash-sale risk.`,
    ];

    if (offsetAgainstGains > 0) {
      rationaleParts.push(
        `Offsets $${offsetAgainstGains.toFixed(2)} of realized gains at ${(stCapitalRate * 100).toFixed(1)}%.`
      );
    }
    if (offsetAgainstOrdinary > 0) {
      rationaleParts.push(
        `Applies $${offsetAgainstOrdinary.toFixed(2)} against ordinary income (IRC §1211(b) $3,000 annual cap) at ${(ordinaryRate * 100).toFixed(1)}%.`
      );
    }
    if (carryforwardLossUsd > 0) {
      rationaleParts.push(
        `Remaining $${carryforwardLossUsd.toFixed(2)} carries forward indefinitely to offset future capital gains.`
      );
    }

    return {
      lotId: lot.lotId,
      asset: lot.asset,
      quantity: remainingQty,
      unrealizedLossUsd,
      estimatedTaxShieldUsd,
      suggestedReplacementAsset: replacement,
      rationale: rationaleParts.join(" "),
    };
  });
}
