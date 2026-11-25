import { describe, expect, it } from "vitest";
import type {
  BorrowVsSellInput,
  CheckTaxImpactInput,
  DeductibleExpenseInput,
} from "@taxrail/shared";
import {
  analyzeBorrowVsSell,
  analyzeCryptoDisposal,
  analyzeDeductibleExpense,
  calculateDynamicPricing,
  classifyBrDeductibleExpense,
  classifyUsDeductibleExpense,
  evaluateBorrowVsSell,
  optimizeBrCryptoTax,
  optimizeUsCapitalGains,
  scanUsTlhOpportunities,
} from "../src/index.js";

describe("US Capital Gains & TLH", () => {
  const asOfDate = "2026-06-15T12:00:00Z";

  it("saves tax with US HIFO/SpecID vs FIFO, enforces 365-day rule, and applies 3.8% NIIT", () => {
    const input: CheckTaxImpactInput = {
      jurisdiction: "US",
      regime: "INDIVIDUAL",
      targetAsset: "ETH",
      sellQuantity: 2,
      currentPriceUsd: 4000,
      asOfDate,
      context: {
        marginalOrdinaryRate: 0.35, // Triggers 20% LT rate instead of 15%
        applyNiit: true, // +3.8% NIIT => ST 38.8%, LT 23.8%
        realizedLossesYtdUsd: 500,
        carryforwardLossesUsd: 500,
      },
      lots: [
        // Oldest lot (FIFO picks this): held > 365 days, very low basis ($500) -> LT gain $3500/ETH
        {
          lotId: "lot-fifo-old-eth-001",
          asset: "ETH",
          quantity: 2,
          costBasisUsd: 500,
          acquiredAt: "2024-01-01T00:00:00Z", // > 365 days -> LONG_TERM (23.8%)
          custodyLocation: "SELF_CUSTODY",
        },
        // Exactly 365 days -> still SHORT_TERM!
        {
          lotId: "lot-exact-365-eth-002",
          asset: "ETH",
          quantity: 1,
          costBasisUsd: 3000,
          acquiredAt: "2025-06-15T12:00:00Z", // exactly 365 days -> SHORT_TERM (38.8%)
          custodyLocation: "SELF_CUSTODY",
        },
        // High-basis recent lot -> lowest tax per unit (gain $500 * 38.8% = $194/ETH)
        {
          lotId: "lot-hifo-high-eth-003",
          asset: "ETH",
          quantity: 2,
          costBasisUsd: 3500,
          acquiredAt: "2026-02-01T00:00:00Z", // SHORT_TERM (38.8%)
          custodyLocation: "SELF_CUSTODY",
        },
        // Underwater lot -> unrealized loss (picked first by SpecID if sold, or TLH if left)
        {
          lotId: "lot-tlh-loss-eth-004",
          asset: "ETH",
          quantity: 1.5,
          costBasisUsd: 5000,
          acquiredAt: "2026-03-01T00:00:00Z",
          custodyLocation: "SELF_CUSTODY",
        },
      ],
    };

    const result = optimizeUsCapitalGains(input);
    expect(result.baselineStrategy).toBe("US_FIFO");
    expect(result.recommendedStrategy).toBe("US_HIFO_SPEC_ID");

    // FIFO sells 2 ETH from lot-fifo-old-eth-001: gain $7000 - $1000 losses = $6000 * 0.238 = $1428
    expect(result.baselineTaxUsd).toBe(1428);

    // SpecID sells 1.5 ETH from underwater lot (-$1500 loss) + 0.5 ETH from lot-hifo-high ($250 gain)
    // Net disposal is negative -> $0 tax!
    expect(result.optimizedTaxUsd).toBe(0);
    expect(result.taxSavedUsd).toBe(1428);
    expect(result.selectedLots[0].lotId).toBe("lot-tlh-loss-eth-004");
    expect(result.selectedLots[1].lotId).toBe("lot-hifo-high-eth-003");
    expect(result.selectedLots[1].term).toBe("SHORT_TERM");
    expect(result.selectedLots[1].effectiveTaxRate).toBe(0.388);

    // Check strict 365-day boundary on exact 365-day lot when sold
    const boundaryTest = optimizeUsCapitalGains({
      ...input,
      sellQuantity: 1,
      lots: [input.lots[1]],
    });
    expect(boundaryTest.selectedLots[0].holdingDays).toBe(365);
    expect(boundaryTest.selectedLots[0].term).toBe("SHORT_TERM");

    const ltBoundaryTest = optimizeUsCapitalGains({
      ...input,
      sellQuantity: 1,
      lots: [
        {
          ...input.lots[1],
          acquiredAt: "2025-06-14T12:00:00Z", // 366 days
        },
      ],
    });
    expect(ltBoundaryTest.selectedLots[0].holdingDays).toBe(366);
    expect(ltBoundaryTest.selectedLots[0].term).toBe("LONG_TERM");
  });

  it("scans remaining lots for TLH opportunities with correlated replacements and $3k ordinary cap", () => {
    const assets: Array<{ asset: string; expectedReplacement: string }> = [
      { asset: "WBTC", expectedReplacement: "cbBTC" },
      { asset: "BTC", expectedReplacement: "WBTC" },
      { asset: "WETH", expectedReplacement: "wstETH" },
      { asset: "ETH", expectedReplacement: "wstETH" },
      { asset: "SOL", expectedReplacement: "jitoSOL" },
      { asset: "ARB", expectedReplacement: "ARB-CORRELATED" },
    ];

    for (const { asset, expectedReplacement } of assets) {
      const input: CheckTaxImpactInput = {
        jurisdiction: "US",
        regime: "INDIVIDUAL",
        targetAsset: asset,
        sellQuantity: 1,
        currentPriceUsd: 1000,
        asOfDate,
        context: {
          marginalOrdinaryRate: 0.32,
          applyNiit: false,
          realizedGainsYtdUsd: 4000,
        },
        lots: [
          {
            lotId: `gain-${asset}`,
            asset,
            quantity: 1,
            costBasisUsd: 500,
            acquiredAt: "2026-01-01T00:00:00Z",
            custodyLocation: "DOMESTIC",
          },
          {
            lotId: `loss-${asset}`,
            asset,
            quantity: 3, // SpecID sells 1 unit (-$2,000 loss), leaving 2 units ($4,000 unrealized loss) for TLH
            costBasisUsd: 3000,
            acquiredAt: "2026-02-01T00:00:00Z",
            custodyLocation: "SELF_CUSTODY",
          },
        ],
      };

      const tlh = scanUsTlhOpportunities(input);
      expect(tlh).toHaveLength(1);
      expect(tlh[0].lotId).toBe(`loss-${asset}`);
      expect(tlh[0].quantity).toBe(2);
      expect(tlh[0].unrealizedLossUsd).toBe(4000);
      // Remaining gain pool = $4,000 YTD - $2,000 realized on disposal = $2,000,
      // plus $2,000 against ordinary income (under $3,000 cap) => $4,000 * 32% = $1,280
      expect(tlh[0].estimatedTaxShieldUsd).toBe(1280);
      expect(tlh[0].suggestedReplacementAsset).toBe(expectedReplacement);
    }
  });
});

describe("US Deductible Expenses", () => {
  it("classifies Schedule C / Corporate categories and applies 21% C-Corp vs 32% Individual shield", () => {
    const cloudCorp: DeductibleExpenseInput = {
      jurisdiction: "US",
      regime: "C_CORP",
      vendorName: "Anthropic",
      description: "Claude API compute tokens for agent inference",
      amountUsd: 10000,
      hasFiscalDocument: true,
      fiscalDocumentId: "INV-2026-881",
    };

    const resCorp = classifyUsDeductibleExpense(cloudCorp);
    expect(resCorp.category).toBe("Cloud & AI Compute");
    expect(resCorp.deductible).toBe(true);
    expect(resCorp.taxSavingsBreakdown.incomeTaxShieldUsd).toBe(2100);
    expect(resCorp.taxSavedUsd).toBe(2100);
    expect(resCorp.complianceChecklist.some((c) => c.includes("W-9"))).toBe(true);

    const saasLlcInput: DeductibleExpenseInput = {
      jurisdiction: "US",
      regime: "LLC_PASS_THROUGH",
      vendorName: "GitHub",
      description: "Team Enterprise SaaS subscription",
      amountUsd: 1000,
    };
    const saasLlc = classifyUsDeductibleExpense(saasLlcInput);
    expect(saasLlc.category).toBe("Software & SaaS");
    expect(saasLlc.taxSavedUsd).toBe(320);

    expect(
      classifyUsDeductibleExpense({
        ...saasLlcInput,
        vendorName: "Meta",
        description: "Paid social ads campaign",
      }).category
    ).toBe("Marketing & Ads");

    expect(
      classifyUsDeductibleExpense({
        ...saasLlcInput,
        vendorName: "Cooley LLP",
        description: "Corporate legal advisory",
      }).category
    ).toBe("Professional Services");

    expect(
      classifyUsDeductibleExpense({
        ...saasLlcInput,
        vendorName: "Delta Air Lines",
        description: "Flight and hotel for client summit",
      }).category
    ).toBe("Travel & Lodging");

    expect(
      classifyUsDeductibleExpense({
        ...saasLlcInput,
        vendorName: "Local Hardware Store",
        description: "Office supplies and cables",
      }).category
    ).toBe("General Business Expense");
  });
});

describe("Brazil Crypto Tax (Lei 14.754, PF Domestic R$ 35k, PJ Lucro Real)", () => {
  const asOfDate = "2026-06-15T12:00:00Z";

  it("applies Lei 14.754 15% flat tax with YTD + carryforward loss compensation", () => {
    const input: CheckTaxImpactInput = {
      jurisdiction: "BR",
      regime: "PF_LEI_14754",
      targetAsset: "BTC",
      sellQuantity: 1,
      currentPriceUsd: 100000,
      asOfDate,
      context: {
        realizedLossesYtdUsd: 5000,
        carryforwardLossesUsd: 15000,
      },
      lots: [
        {
          lotId: "br-offshore-btc-1",
          asset: "BTC",
          quantity: 1,
          costBasisUsd: 60000, // $40,000 gain
          acquiredAt: "2025-01-01T00:00:00Z",
          custodyLocation: "OFFSHORE",
        },
      ],
    };

    const res = optimizeBrCryptoTax(input);
    // Baseline uncompensated: $40,000 * 15% = $6,000
    expect(res.baselineTaxUsd).toBe(6000);
    // Optimized: ($40,000 - $20,000 losses) * 15% = $3,000
    expect(res.optimizedTaxUsd).toBe(3000);
    expect(res.taxSavedUsd).toBe(3000);
    expect(res.selectedLots[0].term).toBe("LEI_14754");
  });

  it("exempts PF_DOMESTIC under R$ 35,000 monthly gross sales and flags split/deferral above R$ 35k", () => {
    // Under R$ 35k: $5,000 * 5.80 = R$ 29,000 + R$ 5,000 prior = R$ 34,000 <= R$ 35,000
    const exemptRes = optimizeBrCryptoTax({
      jurisdiction: "BR",
      regime: "PF_DOMESTIC",
      targetAsset: "BTC",
      sellQuantity: 0.05,
      currentPriceUsd: 100000, // proceeds = $5,000 = R$ 29,000
      asOfDate,
      context: {
        monthlyGrossSalesBrl: 5000,
        usdBrlRate: 5.80,
      },
      lots: [
        {
          lotId: "br-dom-1",
          asset: "BTC",
          quantity: 1,
          costBasisUsd: 40000,
          acquiredAt: "2025-01-01T00:00:00Z",
          custodyLocation: "DOMESTIC",
        },
      ],
    });

    expect(exemptRes.optimizedTaxUsd).toBe(0);
    expect(exemptRes.recommendedStrategy).toBe("BR_DOMESTIC_EXEMPT_UNDER_35K");

    // Over R$ 35k: prior R$ 20,000 + proceeds R$ 29,000 = R$ 49,000 > R$ 35,000
    const taxableRes = optimizeBrCryptoTax({
      jurisdiction: "BR",
      regime: "PF_DOMESTIC",
      targetAsset: "BTC",
      sellQuantity: 0.05,
      currentPriceUsd: 100000, // proceeds = $5,000, gain = $3,000
      asOfDate,
      context: {
        monthlyGrossSalesBrl: 20000,
        usdBrlRate: 5.80,
      },
      lots: [
        {
          lotId: "br-dom-2",
          asset: "BTC",
          quantity: 1,
          costBasisUsd: 40000,
          acquiredAt: "2025-01-01T00:00:00Z",
          custodyLocation: "DOMESTIC",
        },
      ],
    });

    // $3,000 gain * 15% = $450
    expect(taxableRes.optimizedTaxUsd).toBe(450);
    expect(
      taxableRes.warnings.some((w) => w.includes("R$ 35,000") && w.includes("Deferring"))
    ).toBe(true);
  });

  it("supports PJ_LUCRO_REAL 34% corporate crypto capital gains rate", () => {
    const res = optimizeBrCryptoTax({
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      targetAsset: "ETH",
      sellQuantity: 10,
      currentPriceUsd: 3000,
      asOfDate,
      lots: [
        {
          lotId: "pj-eth-1",
          asset: "ETH",
          quantity: 10,
          costBasisUsd: 2000,
          acquiredAt: "2025-01-01T00:00:00Z",
          custodyLocation: "DOMESTIC",
        },
      ],
    });
    // Gain = $10,000 * 34% = $3,400
    expect(res.optimizedTaxUsd).toBe(3400);
  });
});

describe("Brazil Corporate Deductions (Lucro Real & Simples Export)", () => {
  it("computes PJ_LUCRO_REAL 34% IRPJ/CSLL + 9.25% PIS/COFINS + 12% IBS/CBS readiness", () => {
    const res = classifyBrDeductibleExpense({
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      vendorName: "AWS",
      description: "Cloud GPU compute & Kubernetes hosting",
      amountUsd: 10000,
      hasFiscalDocument: true,
      fiscalDocumentId: "NFE-352606000000000001",
    });

    expect(res.category).toBe("Cloud & AI Compute");
    expect(res.deductible).toBe(true);
    expect(res.taxSavingsBreakdown.incomeTaxShieldUsd).toBe(3400);
    expect(res.taxSavingsBreakdown.pisCofinsCreditUsd).toBe(925);
    expect(res.taxSavingsBreakdown.ibsCbsReadinessCreditUsd).toBe(1200);
    expect(res.taxSavedUsd).toBe(4325);
  });

  it("computes PJ_SIMPLES_EXPORT IOF 3.38% + 4% FX spread savings when replacing international card", () => {
    const res = classifyBrDeductibleExpense({
      jurisdiction: "BR",
      regime: "PJ_SIMPLES_EXPORT",
      vendorName: "Vercel",
      description: "Frontend hosting SaaS",
      amountUsd: 1000,
      paidWithInternationalCard: true,
    });

    expect(res.deductible).toBe(false);
    expect(res.taxSavingsBreakdown.incomeTaxShieldUsd).toBe(0);
    expect(res.taxSavingsBreakdown.pisCofinsCreditUsd).toBe(0);
    expect(res.taxSavingsBreakdown.iofAndSpreadSavingsUsd).toBe(73.8);
    expect(res.taxSavedUsd).toBe(73.8);
    expect(res.complianceChecklist.some((c) => c.includes("Service Export Proof"))).toBe(true);
  });
});

describe("Borrow vs Sell Evaluator", () => {
  it("recommends BORROW_AAVE_V3 when sell tax exceeds net borrow cost with corporate shield", () => {
    const input: BorrowVsSellInput = {
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      chain: "base",
      collateralAsset: "ETH",
      collateralAmount: 100,
      collateralPriceUsd: 4000, // $400k collateral
      collateralCostBasisUsd: 1000, // 75% gain
      holdingDays: 400,
      liquidityNeededUsd: 100000, // 25% LTV
      borrowApr: 0.055,
      horizonDays: 180,
    };

    const res = evaluateBorrowVsSell(input);
    // Sell 25 ETH -> gain 25 * $3000 = $75,000 * 34% = $25,500 sell tax
    expect(res.sellTaxCostUsd).toBe(25500);
    // Gross borrow = 100,000 * 0.055 * (180/365) = $2,712.33; shield 34% = $922.19; net = $1,790.14
    expect(res.corporateInterestTaxShieldUsd).toBe(922.19);
    expect(res.netBorrowCostUsd).toBe(1790.14);
    expect(res.recommendation).toBe("BORROW_AAVE_V3");
    expect(res.taxSavedUsd).toBe(23709.86);
    expect(res.projectedLtvPct).toBe(25);
    expect(res.liquidationWarning).toBeNull();
  });

  it("emits liquidation warning when projected LTV > 65%", () => {
    const res = evaluateBorrowVsSell({
      jurisdiction: "US",
      regime: "INDIVIDUAL",
      collateralAsset: "WBTC",
      collateralAmount: 1,
      collateralPriceUsd: 100000,
      collateralCostBasisUsd: 99000,
      holdingDays: 500,
      liquidityNeededUsd: 70000, // 70% LTV > 65%
      borrowApr: 0.08,
      horizonDays: 365,
    });

    expect(res.projectedLtvPct).toBe(70);
    expect(res.liquidationWarning).not.toBeNull();
    // Sell tax on $700 gain * 15% = $105 < $5,600 borrow cost -> SELL_OPTIMIZED_LOTS
    expect(res.recommendation).toBe("SELL_OPTIMIZED_LOTS");
    expect(res.taxSavedUsd).toBe(0);
  });
});

describe("Dynamic Pricing Engine", () => {
  it("returns zero fees and roiMultiple = 0 when taxSavedUsd <= 0", () => {
    const q = calculateDynamicPricing({
      taxSavedUsd: 0,
      estimatedTransactionUsd: 50000,
      referrerWallet: "0xAffiliate123",
    });

    expect(q.totalFeeUsd).toBe(0);
    expect(q.upfrontX402Usd).toBe(0);
    expect(q.embeddedSwapFeeBps).toBe(0);
    expect(q.affiliateShareUsd).toBe(0);
    expect(q.roiMultiple).toBe(0);
  });

  it("charges 100% upfront x402 when totalFeeUsd <= $50", () => {
    const q = calculateDynamicPricing({
      taxSavedUsd: 300,
      pricingTier: "STANDARD",
      estimatedTransactionUsd: 10000,
    });

    expect(q.totalFeeUsd).toBe(30);
    expect(q.upfrontX402Usd).toBe(30);
    expect(q.embeddedSwapFeeBps).toBe(0);
    expect(q.embeddedSwapFeeUsd).toBe(0);
    expect(q.enterpriseBalanceUsd).toBe(0);
    expect(q.clientNetBenefitUsd).toBe(270);
    expect(q.roiMultiple).toBe(10);
  });

  it("applies >$50 hybrid guardrail ($10 upfront + swap bps <= 100 + enterprise overflow) and 20% affiliate split", () => {
    const q = calculateDynamicPricing({
      taxSavedUsd: 5000,
      pricingTier: "STANDARD", // 10% -> $500 totalFee
      estimatedTransactionUsd: 20000, // remaining $490 -> 245 bps -> capped at 100 bps ($200)
      referrerWallet: "0xAgentReferrer999",
    });

    expect(q.totalFeeUsd).toBe(500);
    expect(q.upfrontX402Usd).toBe(10);
    expect(q.embeddedSwapFeeBps).toBe(100);
    expect(q.embeddedSwapFeeUsd).toBe(200);
    expect(q.enterpriseBalanceUsd).toBe(290);
    expect(q.affiliateWallet).toBe("0xAgentReferrer999");
    expect(q.affiliateShareUsd).toBe(100);
    expect(q.clientNetBenefitUsd).toBe(4500);
    expect(q.roiMultiple).toBe(10);
  });

  it("caps minimum $0.50 fee at 50% of taxSavedUsd", () => {
    const q = calculateDynamicPricing({
      taxSavedUsd: 0.6,
      pricingTier: "STANDARD",
    });
    expect(q.totalFeeUsd).toBe(0.3);
    expect(q.clientNetBenefitUsd).toBe(0.3);
  });
});

describe("Orchestrator & Strict Anti-Leakage Guardrail", () => {
  it("never leaks any lotId, selectedLots, tlhOpportunities, or calldata in redacted response", () => {
    const secretLotIds = [
      "SECRET-WALLET-LOT-ALPHA-991",
      "SECRET-WALLET-LOT-BETA-882",
      "SECRET-WALLET-LOT-GAMMA-773",
    ];

    const input: CheckTaxImpactInput = {
      jurisdiction: "US",
      regime: "INDIVIDUAL",
      chain: "base",
      targetAsset: "ETH",
      sellQuantity: 1.5,
      currentPriceUsd: 4000,
      asOfDate: "2026-06-15T12:00:00Z",
      referrerWallet: "0xPartner",
      lots: [
        {
          lotId: secretLotIds[0],
          asset: "ETH",
          quantity: 2,
          costBasisUsd: 1000,
          acquiredAt: "2024-01-01T00:00:00Z",
          custodyLocation: "DOMESTIC",
        },
        {
          lotId: secretLotIds[1],
          asset: "ETH",
          quantity: 1.5,
          costBasisUsd: 3800,
          acquiredAt: "2026-03-01T00:00:00Z",
          custodyLocation: "SELF_CUSTODY",
        },
        {
          lotId: secretLotIds[2],
          asset: "ETH",
          quantity: 2,
          costBasisUsd: 5500,
          acquiredAt: "2026-04-01T00:00:00Z",
          custodyLocation: "SELF_CUSTODY",
        },
      ],
    };

    const result = analyzeCryptoDisposal(input);

    // Full internal result contains lotIds in selectedLots & tlhOpportunities
    expect(result.selectedLots.length).toBeGreaterThan(0);
    expect(result.tlhOpportunities.length).toBeGreaterThan(0);
    expect(result.redacted.planId).toMatch(/^plan_/);

    // Serialized redacted payload MUST NOT contain any lotId or privileged fields
    const serialized = JSON.stringify(result.redacted);
    for (const secretId of secretLotIds) {
      expect(serialized).not.toContain(secretId);
    }
    expect(serialized).not.toContain("lotId");
    expect(serialized).not.toContain("selectedLots");
    expect(serialized).not.toContain("tlhOpportunities");
    expect(serialized).not.toContain("calldata");
    expect(result.redacted.nextAction.endpoint).toBe("/api/v1/unlock-plan");
    expect(result.redacted.nextAction.paymentNetwork).toBe("eip155:8453");
  });

  it("orchestrates borrow-vs-sell and deductible-expense previews with planIds", () => {
    const borrowOut = analyzeBorrowVsSell({
      jurisdiction: "US",
      regime: "C_CORP",
      collateralAsset: "ETH",
      collateralAmount: 50,
      collateralPriceUsd: 4000,
      collateralCostBasisUsd: 1000,
      holdingDays: 200,
      liquidityNeededUsd: 50000,
    });
    expect(borrowOut.preview.planId).toMatch(/^plan_/);
    expect(borrowOut.preview.pricing).toEqual(borrowOut.pricing);

    const expenseOut = analyzeDeductibleExpense({
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      vendorName: "OpenAI",
      description: "GPT API inference compute",
      amountUsd: 5000,
    });
    expect(expenseOut.preview.planId).toMatch(/^plan_/);
    expect(expenseOut.preview.pricing).toEqual(expenseOut.pricing);
    expect(expenseOut.preview.category).toBe("Cloud & AI Compute");
  });
});
