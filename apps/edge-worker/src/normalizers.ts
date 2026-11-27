export function toOptionalNumber(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string" && val.trim() && Number.isFinite(Number(val))) {
    return Number(val);
  }
  return undefined;
}

export function normalizeRegime(rawRegime: unknown, jurisdiction: "US" | "BR"): string {
  if (typeof rawRegime !== "string" || !rawRegime.trim()) {
    return jurisdiction === "BR" ? "PF_LEI_14754" : "INDIVIDUAL";
  }
  const upper = rawRegime.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (upper === "PF" || upper === "LEI_14754") return "PF_LEI_14754";
  if (upper === "PJ" || upper === "LUCRO_REAL") return "PJ_LUCRO_REAL";
  if (upper === "LLC") return "LLC_PASS_THROUGH";
  if (upper === "CCORP") return "C_CORP";
  return upper;
}

export function normalizeCheckTaxImpactPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rawJur =
    typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim().toUpperCase() : "US";
  const jurisdiction: "US" | "BR" = rawJur === "BR" ? "BR" : "US";
  obj.jurisdiction = jurisdiction;
  obj.regime = normalizeRegime(obj.regime, jurisdiction);

  if (!obj.walletAddress) {
    const aliasWallet = obj.wallet_address ?? obj.address ?? obj.wallet;
    if (typeof aliasWallet === "string") obj.walletAddress = aliasWallet;
  }
  if (typeof obj.walletAddress === "string") {
    obj.walletAddress = obj.walletAddress.trim();
  }

  if (!obj.targetAsset) {
    const aliasAsset =
      obj.target_asset ?? obj.asset ?? obj.token ?? obj.sellAsset ?? obj.sell_asset;
    if (typeof aliasAsset === "string" && aliasAsset.trim()) {
      obj.targetAsset = aliasAsset.trim().toUpperCase();
    } else if (
      typeof obj.walletAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(obj.walletAddress)
    ) {
      obj.targetAsset = "ETH";
    }
  }

  if (obj.targetQuoteAsset === undefined && typeof obj.target_quote_asset === "string") {
    obj.targetQuoteAsset = obj.target_quote_asset;
  }
  if (obj.referrerWallet === undefined && typeof obj.referrer_wallet === "string") {
    obj.referrerWallet = obj.referrer_wallet;
  }
  if (obj.pricingTier === undefined && typeof obj.pricing_tier === "string") {
    obj.pricingTier = obj.pricing_tier;
  }
  if (obj.asOfDate === undefined && typeof obj.as_of_date === "string") {
    obj.asOfDate = obj.as_of_date;
  }

  if (obj.sellQuantity === undefined) {
    const aliasQty = toOptionalNumber(
      obj.sell_quantity ?? obj.sellAmount ?? obj.sell_amount ?? obj.amount ?? obj.quantity
    );
    if (aliasQty !== undefined) {
      obj.sellQuantity = aliasQty;
    } else if (
      obj.targetProceedsUsd === undefined &&
      obj.target_proceeds_usd === undefined &&
      typeof obj.walletAddress === "string" &&
      /^0x[a-fA-F0-9]{40}$/.test(obj.walletAddress)
    ) {
      obj.sellQuantity = 1;
    }
  } else {
    const numQty = toOptionalNumber(obj.sellQuantity);
    if (numQty !== undefined) obj.sellQuantity = numQty;
  }

  if (obj.targetProceedsUsd === undefined) {
    const numProceeds = toOptionalNumber(obj.target_proceeds_usd);
    if (numProceeds !== undefined) obj.targetProceedsUsd = numProceeds;
  } else {
    const numProceeds = toOptionalNumber(obj.targetProceedsUsd);
    if (numProceeds !== undefined) obj.targetProceedsUsd = numProceeds;
  }

  const numPrice = toOptionalNumber(obj.currentPriceUsd ?? obj.current_price_usd);
  if (numPrice !== undefined) {
    obj.currentPriceUsd = numPrice;
  }

  if (Array.isArray(obj.lots)) {
    const fallbackAsset =
      typeof obj.targetAsset === "string" && obj.targetAsset.trim()
        ? obj.targetAsset.trim().toUpperCase()
        : "ETH";
    obj.lots = obj.lots.map((item, idx) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const lot: Record<string, unknown> = { ...(item as Record<string, unknown>) };
      if (!lot.lotId && typeof lot.lot_id === "string") lot.lotId = lot.lot_id;
      if (!lot.lotId) lot.lotId = `lot_${idx + 1}`;
      if (!lot.asset) lot.asset = fallbackAsset;
      const qty = toOptionalNumber(lot.quantity ?? lot.amount);
      if (qty !== undefined) lot.quantity = qty;
      const basis = toOptionalNumber(lot.costBasisUsd ?? lot.cost_basis_usd ?? lot.costBasis);
      if (basis !== undefined) lot.costBasisUsd = basis;
      if (!lot.acquiredAt) {
        const acq = lot.acquired_at ?? lot.acquiredDate;
        if (typeof acq === "string" && acq.trim()) lot.acquiredAt = acq.trim();
      }
      if (!lot.custodyLocation) {
        const loc = lot.custody_location;
        lot.custodyLocation =
          typeof loc === "string" && loc.trim() ? loc.trim().toUpperCase() : "SELF_CUSTODY";
      } else if (typeof lot.custodyLocation === "string") {
        lot.custodyLocation = lot.custodyLocation.trim().toUpperCase();
      }
      return lot;
    });
  }

  return obj;
}

export function normalizeBorrowVsSellPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rawJur =
    typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim().toUpperCase() : "US";
  const jurisdiction: "US" | "BR" = rawJur === "BR" ? "BR" : "US";
  obj.jurisdiction = jurisdiction;
  obj.regime = normalizeRegime(obj.regime, jurisdiction);

  if (!obj.collateralAsset) {
    const aliasAsset = obj.collateral_asset ?? obj.collateral;
    if (typeof aliasAsset === "string" && aliasAsset.trim()) {
      obj.collateralAsset = aliasAsset.trim().toUpperCase();
    }
  }
  if (obj.collateralAmount === undefined) {
    const aliasAmount = toOptionalNumber(
      obj.collateralQuantity ?? obj.collateral_quantity ?? obj.collateral_amount ?? obj.amount
    );
    if (aliasAmount !== undefined) obj.collateralAmount = aliasAmount;
  } else {
    const num = toOptionalNumber(obj.collateralAmount);
    if (num !== undefined) obj.collateralAmount = num;
  }

  const price = toOptionalNumber(obj.collateralPriceUsd ?? obj.collateral_price_usd);
  if (price !== undefined) obj.collateralPriceUsd = price;

  const basis = toOptionalNumber(obj.collateralCostBasisUsd ?? obj.collateral_cost_basis_usd);
  if (basis !== undefined) obj.collateralCostBasisUsd = basis;

  const holdingDays = toOptionalNumber(obj.holdingDays ?? obj.holding_days);
  obj.holdingDays = holdingDays !== undefined ? holdingDays : 365;

  const liquidity = toOptionalNumber(
    obj.liquidityNeededUsd ?? obj.liquidity_needed_usd ?? obj.liquidityUsd ?? obj.liquidity_usd
  );
  if (liquidity !== undefined) obj.liquidityNeededUsd = liquidity;

  if (obj.horizonDays === undefined) {
    const horizon = toOptionalNumber(
      obj.holdingHorizonDays ?? obj.holding_horizon_days ?? obj.horizon_days
    );
    if (horizon !== undefined) obj.horizonDays = horizon;
  } else {
    const horizon = toOptionalNumber(obj.horizonDays);
    if (horizon !== undefined) obj.horizonDays = horizon;
  }

  const borrowApr = toOptionalNumber(obj.borrowApr ?? obj.borrow_apr);
  if (borrowApr !== undefined) obj.borrowApr = borrowApr;

  if (obj.borrowerAddress === undefined && typeof obj.borrower_address === "string") {
    obj.borrowerAddress = obj.borrower_address;
  }
  if (obj.referrerWallet === undefined && typeof obj.referrer_wallet === "string") {
    obj.referrerWallet = obj.referrer_wallet;
  }

  return obj;
}

export function normalizeClassifyExpensePayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rawJur =
    typeof obj.jurisdiction === "string" ? obj.jurisdiction.trim().toUpperCase() : "US";
  const jurisdiction: "US" | "BR" = rawJur === "BR" ? "BR" : "US";
  obj.jurisdiction = jurisdiction;

  if (typeof obj.regime !== "string" || !obj.regime.trim()) {
    obj.regime = jurisdiction === "BR" ? "PJ_LUCRO_REAL" : "C_CORP";
  } else {
    obj.regime = normalizeRegime(obj.regime, jurisdiction);
  }

  if (!obj.vendorName) {
    const aliasVendor = obj.vendor ?? obj.vendor_name;
    if (typeof aliasVendor === "string" && aliasVendor.trim()) {
      obj.vendorName = aliasVendor.trim();
    }
  }

  const amountUsd = toOptionalNumber(obj.amountUsd ?? obj.amount_usd ?? obj.amount);
  if (amountUsd !== undefined) obj.amountUsd = amountUsd;

  if (typeof obj.description !== "string" || !obj.description.trim()) {
    const categoryText =
      typeof obj.category === "string" && obj.category.trim() ? obj.category.trim() : "";
    const vendorText =
      typeof obj.vendorName === "string" && obj.vendorName.trim() ? obj.vendorName.trim() : "";
    if (categoryText && vendorText) {
      obj.description = `${categoryText} expense from ${vendorText}`;
    } else if (categoryText) {
      obj.description = `${categoryText} business expense`;
    } else if (vendorText) {
      obj.description = `Business expense from ${vendorText}`;
    }
  }

  if (obj.hasFiscalDocument === undefined && typeof obj.has_fiscal_document === "boolean") {
    obj.hasFiscalDocument = obj.has_fiscal_document;
  }
  if (obj.fiscalDocumentId === undefined && typeof obj.fiscal_document_id === "string") {
    obj.fiscalDocumentId = obj.fiscal_document_id;
  }
  if (
    obj.paidWithInternationalCard === undefined &&
    typeof obj.paid_with_international_card === "boolean"
  ) {
    obj.paidWithInternationalCard = obj.paid_with_international_card;
  }
  const usdBrlRate = toOptionalNumber(obj.usdBrlRate ?? obj.usd_brl_rate);
  if (usdBrlRate !== undefined) obj.usdBrlRate = usdBrlRate;
  if (obj.referrerWallet === undefined && typeof obj.referrer_wallet === "string") {
    obj.referrerWallet = obj.referrer_wallet;
  }

  return obj;
}

const VALID_FEEDBACK_CATEGORIES = new Set([
  "PRAISE",
  "BUG",
  "FEATURE_REQUEST",
  "ACCURACY",
  "GENERAL",
]);

export function normalizeFeedbackPayload(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const obj: Record<string, unknown> = { ...(raw as Record<string, unknown>) };

  const rating = toOptionalNumber(obj.rating);
  if (rating !== undefined) obj.rating = Math.round(rating);

  if (typeof obj.category === "string") {
    const upper = obj.category.trim().toUpperCase();
    obj.category = VALID_FEEDBACK_CATEGORIES.has(upper) ? upper : "GENERAL";
  }

  if (typeof obj.comment !== "string" || !obj.comment.trim()) {
    const aliasComment = obj.message ?? obj.text;
    if (typeof aliasComment === "string" && aliasComment.trim()) {
      obj.comment = aliasComment.trim();
    }
  }

  if (obj.planId === undefined && typeof obj.plan_id === "string") obj.planId = obj.plan_id;
  if (obj.settlementTx === undefined && typeof obj.settlement_tx === "string") {
    obj.settlementTx = obj.settlement_tx;
  }
  if (obj.agentName === undefined && typeof obj.agent_name === "string") {
    obj.agentName = obj.agent_name;
  }
  if (obj.allowPublicQuote === undefined && typeof obj.allow_public_quote === "boolean") {
    obj.allowPublicQuote = obj.allow_public_quote;
  }

  return obj;
}
