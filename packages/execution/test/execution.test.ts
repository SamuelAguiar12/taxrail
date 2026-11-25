import type {
  BorrowVsSellPreview,
  DeductibleExpenseInput,
  DeductibleExpensePreview,
  DynamicPricingQuote,
  SelectedLotDisposal,
  TlhOpportunity,
} from "@taxrail/shared";
import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  AAVE_V3_POOL_ABI,
  AAVE_V3_POOL_ADDRESSES,
  EVM_TOKEN_REGISTRY,
  FALLBACK_BORROWER_ADDRESS,
  buildAaveBorrowPayload,
  buildBorrowAccountingDossier,
  buildCryptoAccountingDossier,
  buildExpenseAccountingDossier,
  buildSwapIntent,
} from "../src/index.js";

function makePricing(
  overrides: Partial<DynamicPricingQuote> = {}
): DynamicPricingQuote {
  return {
    taxSavedUsd: 2500,
    feeRatePct: 0.1,
    totalFeeUsd: 250,
    upfrontX402Usd: 10,
    embeddedSwapFeeBps: 50,
    embeddedSwapFeeUsd: 240,
    enterpriseBalanceUsd: 0,
    affiliateShareUsd: 0,
    clientNetBenefitUsd: 2250,
    roiMultiple: 10,
    ...overrides,
  };
}

describe("buildAaveBorrowPayload", () => {
  it("encodes valid Aave v3 supply and borrow ABI calldata for Base, Ethereum, and Arbitrum", () => {
    const borrower = "0x1111111111111111111111111111111111111111";

    const cases = [
      {
        chain: "base" as const,
        collateralAsset: "ETH",
        expectedCollateral: EVM_TOKEN_REGISTRY.base.WETH.address,
        collateralAmount: 2.5,
        borrowAmountUsd: 3000,
      },
      {
        chain: "ethereum" as const,
        collateralAsset: "WBTC",
        expectedCollateral: EVM_TOKEN_REGISTRY.ethereum.WBTC.address,
        collateralAmount: 0.5,
        borrowAmountUsd: 15000,
      },
      {
        chain: "arbitrum" as const,
        collateralAsset: "cbBTC",
        expectedCollateral: EVM_TOKEN_REGISTRY.arbitrum.cbBTC.address,
        collateralAmount: 1.25,
        borrowAmountUsd: 40000,
      },
    ];

    for (const c of cases) {
      const payload = buildAaveBorrowPayload({
        chain: c.chain,
        borrowerAddress: borrower,
        collateralAsset: c.collateralAsset,
        collateralAmount: c.collateralAmount,
        borrowAmountUsd: c.borrowAmountUsd,
      });

      expect(payload.protocol).toBe("aave_v3");
      expect(payload.chain).toBe(c.chain);
      expect(payload.poolAddress).toBe(AAVE_V3_POOL_ADDRESSES[c.chain]);

      // supply(address,uint256,address,uint16) => 4-byte selector + 4 * 32-byte words = 132 bytes => 266 hex chars
      expect(payload.supplyTransaction).toBeDefined();
      expect(payload.supplyTransaction!.to).toBe(AAVE_V3_POOL_ADDRESSES[c.chain]);
      expect(payload.supplyTransaction!.value).toBe("0");
      expect(payload.supplyTransaction!.data).toMatch(/^0x[0-9a-fA-F]{264}$/);

      const decodedSupply = decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: payload.supplyTransaction!.data,
      });
      expect(decodedSupply.functionName).toBe("supply");
      expect(decodedSupply.args[0]).toBe(c.expectedCollateral);
      expect(decodedSupply.args[2]).toBe(borrower);
      expect(decodedSupply.args[3]).toBe(0);

      // borrow(address,uint256,uint256,uint16,address) => 4-byte selector + 5 * 32-byte words = 164 bytes => 330 hex chars
      expect(payload.borrowTransaction.to).toBe(AAVE_V3_POOL_ADDRESSES[c.chain]);
      expect(payload.borrowTransaction.value).toBe("0");
      expect(payload.borrowTransaction.data).toMatch(/^0x[0-9a-fA-F]{328}$/);

      const decodedBorrow = decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: payload.borrowTransaction.data,
      });
      expect(decodedBorrow.functionName).toBe("borrow");
      expect(decodedBorrow.args[0]).toBe(EVM_TOKEN_REGISTRY[c.chain].USDC.address);
      expect(decodedBorrow.args[1]).toBe(BigInt(c.borrowAmountUsd) * 1_000_000n);
      expect(decodedBorrow.args[2]).toBe(2n);
      expect(decodedBorrow.args[3]).toBe(0);
      expect(decodedBorrow.args[4]).toBe(borrower);
    }
  });

  it("falls back safely to 0x...dEaD when borrowerAddress is invalid or omitted", () => {
    const omitted = buildAaveBorrowPayload({
      chain: "base",
      collateralAsset: "WETH",
      collateralAmount: 1,
      borrowAmountUsd: 1000,
    });

    const invalid = buildAaveBorrowPayload({
      chain: "base",
      borrowerAddress: "not-a-valid-address",
      collateralAsset: "WETH",
      collateralAmount: 1,
      borrowAmountUsd: 1000,
    });

    for (const payload of [omitted, invalid]) {
      const decodedBorrow = decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: payload.borrowTransaction.data,
      });
      expect(decodedBorrow.args[4]).toBe(FALLBACK_BORROWER_ADDRESS);

      const decodedSupply = decodeFunctionData({
        abi: AAVE_V3_POOL_ABI,
        data: payload.supplyTransaction!.data,
      });
      expect(decodedSupply.args[2]).toBe(FALLBACK_BORROWER_ADDRESS);
    }
  });
});

describe("buildSwapIntent", () => {
  const treasury = "0xTreasury00000000000000000000000000000001";
  const affiliate = "0xAffiliate0000000000000000000000000000002";

  it("enforces integratorFeeBps <= 100 even when pricing requests a higher value", () => {
    const intent = buildSwapIntent({
      chain: "base",
      sellAsset: "WETH",
      buyAsset: "USDC",
      sellAmountDecimal: "2.5",
      pricing: makePricing({ embeddedSwapFeeBps: 250 }),
      treasuryWallet: treasury,
    });

    expect(intent.venue).toBe("0x_v2");
    expect(intent.integratorFeeBps).toBe(100);
    expect(intent.feeRecipients).toEqual([
      {
        recipient: treasury,
        shareBps: 100,
        role: "TAXRAIL_TREASURY",
      },
    ]);

    const req = intent.requestTemplate as {
      endpoint: string;
      queryParams: Record<string, unknown>;
    };
    expect(req.endpoint).toBe("/swap/allowance-holder/quote");
    expect(req.queryParams.swapFeeBps).toBe(100);
    expect(req.queryParams.swapFeeRecipient).toBe(treasury);
  });

  it("splits feeRecipients 80/20 when affiliateWallet is present", () => {
    const intent = buildSwapIntent({
      chain: "arbitrum",
      sellAsset: "WBTC",
      buyAsset: "USDC",
      sellAmountDecimal: "0.25",
      pricing: makePricing({
        embeddedSwapFeeBps: 80,
        affiliateWallet: affiliate,
      }),
      treasuryWallet: treasury,
    });

    expect(intent.venue).toBe("0x_v2");
    expect(intent.integratorFeeBps).toBe(80);
    expect(intent.feeRecipients).toEqual([
      {
        recipient: treasury,
        shareBps: 64,
        role: "TAXRAIL_TREASURY",
      },
      {
        recipient: affiliate,
        shareBps: 16,
        role: "AFFILIATE_AGENT",
      },
    ]);
  });

  it("builds CoW Swap template for ethereum and Jupiter template for solana", () => {
    const ethIntent = buildSwapIntent({
      chain: "ethereum",
      sellAsset: "WETH",
      buyAsset: "USDC",
      sellAmountDecimal: "1.0",
      pricing: makePricing({ embeddedSwapFeeBps: 45 }),
      treasuryWallet: treasury,
    });
    expect(ethIntent.venue).toBe("cow_swap");
    expect(ethIntent.requestTemplate.endpoint).toBe("/api/v1/quote");
    const cowBody = ethIntent.requestTemplate.body as {
      appData: { metadata: { partnerFee: { bps: number; recipient: string } } };
    };
    expect(cowBody.appData.metadata.partnerFee.bps).toBe(45);
    expect(cowBody.appData.metadata.partnerFee.recipient).toBe(treasury);

    const solIntent = buildSwapIntent({
      chain: "solana",
      sellAsset: "SOL",
      buyAsset: "USDC",
      sellAmountDecimal: "10",
      pricing: makePricing({ embeddedSwapFeeBps: 60 }),
      treasuryWallet: "So1Treasury11111111111111111111111111111111",
    });
    expect(solIntent.venue).toBe("jupiter");
    expect(solIntent.requestTemplate.endpoint).toBe("/swap/v1/quote");
    const jupParams = solIntent.requestTemplate.queryParams as Record<
      string,
      unknown
    >;
    expect(jupParams.platformFeeBps).toBe(60);
    expect(jupParams.amount).toBe("10000000000");
  });
});

describe("accounting dossiers", () => {
  const sampleLots: SelectedLotDisposal[] = [
    {
      lotId: "lot-1",
      asset: "ETH",
      quantityToSell: 2,
      proceedsUsd: 6000,
      costBasisTotalUsd: 4000,
      gainOrLossUsd: 2000,
      holdingDays: 420,
      term: "LONG_TERM",
      effectiveTaxRate: 0.15,
      estimatedTaxUsd: 300,
    },
    {
      lotId: "lot-2",
      asset: "SOL",
      quantityToSell: 10,
      proceedsUsd: 1500,
      costBasisTotalUsd: 1800,
      gainOrLossUsd: -300,
      holdingDays: 90,
      term: "SHORT_TERM",
      effectiveTaxRate: 0.32,
      estimatedTaxUsd: -96,
    },
  ];

  const sampleTlh: TlhOpportunity[] = [
    {
      lotId: "lot-tlh-1",
      asset: "ARB",
      quantity: 1000,
      unrealizedLossUsd: 500,
      estimatedTaxShieldUsd: 160,
      suggestedReplacementAsset: "OP",
      rationale: "Harvest unrealized loss to offset short-term gains.",
    },
  ];

  it("builds US IRS Form 8949 dossier with exact CSV columns and CPA disclaimer", () => {
    const dossier = buildCryptoAccountingDossier({
      jurisdiction: "US",
      regime: "INDIVIDUAL",
      selectedLots: sampleLots,
      tlhOpportunities: sampleTlh,
      taxSavedUsd: 450,
    });

    expect(dossier.format).toBe("IRS_FORM_8949");
    expect(dossier.records).toHaveLength(2);
    expect(dossier.csvExport).toBeDefined();

    const lines = dossier.csvExport!.split("\n");
    expect(lines[0]).toBe(
      "Description of Property,Date Acquired,Date Sold,Proceeds,Cost Basis,Code,Adjustment,Gain or Loss,Term"
    );
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("2 ETH");
    expect(lines[1]).toContain("6000.00,4000.00,,0.00,2000.00,LONG_TERM");
    expect(dossier.disclaimer).toMatch(/software-only/i);
    expect(dossier.disclaimer).toMatch(/CPA/i);
  });

  it("builds BR Lei 14.754 / DeCripto dossier with USD and BRL PTAX summary", () => {
    const brLots: SelectedLotDisposal[] = [
      {
        ...sampleLots[0],
        term: "LEI_14754",
      },
    ];

    const dossier = buildCryptoAccountingDossier({
      jurisdiction: "BR",
      regime: "PF_LEI_14754",
      selectedLots: brLots,
      tlhOpportunities: [],
      taxSavedUsd: 300,
    });

    expect(dossier.format).toBe("BR_LEI_14754");
    expect(dossier.summary.ptaxReferenceRate).toBe(5.8);
    expect(dossier.summary.totalProceedsUsd).toBe(6000);
    expect(dossier.summary.totalProceedsBrl).toBe(34800);
    expect(dossier.records[0].deCriptoClassification).toBeDefined();
    expect(dossier.disclaimer).toMatch(/Contador/i);
  });

  it("builds BorrowVsSell accounting dossier", () => {
    const preview: BorrowVsSellPreview = {
      planId: "plan-borrow-1",
      jurisdiction: "US",
      regime: "C_CORP",
      recommendation: "BORROW_AAVE_V3",
      sellTaxCostUsd: 4200,
      netBorrowCostUsd: 800,
      corporateInterestTaxShieldUsd: 210,
      taxSavedUsd: 3400,
      projectedLtvPct: 40,
      liquidationWarning: null,
      pricing: makePricing({ taxSavedUsd: 3400 }),
      disclaimer: "preview disclaimer",
    };

    const dossier = buildBorrowAccountingDossier({
      jurisdiction: "US",
      regime: "C_CORP",
      preview,
    });

    expect(dossier.format).toBe("IRS_FORM_8949");
    expect(dossier.summary.accountingTreatment).toBe(
      "NON_TAXABLE_COLLATERALIZED_LOAN"
    );
    expect(dossier.records.length).toBeGreaterThanOrEqual(2);
    expect(dossier.disclaimer).toMatch(/CPA/i);
  });

  it("builds DeductibleExpense dossiers for US QuickBooks and BR Lucro Real Omie/SPED", () => {
    const usInput: DeductibleExpenseInput = {
      jurisdiction: "US",
      regime: "LLC_PASS_THROUGH",
      vendorName: "AWS",
      description: "Cloud GPU compute",
      amountUsd: 1000,
      fiscalDocumentId: "INV-2026-001",
    };
    const usPreview: DeductibleExpensePreview = {
      planId: "exp-us-1",
      jurisdiction: "US",
      regime: "LLC_PASS_THROUGH",
      category: "Cloud Infrastructure",
      deductible: true,
      taxSavingsBreakdown: {
        incomeTaxShieldUsd: 300,
        pisCofinsCreditUsd: 0,
        ibsCbsReadinessCreditUsd: 0,
        iofAndSpreadSavingsUsd: 0,
      },
      taxSavedUsd: 300,
      complianceChecklist: ["Retain vendor invoice"],
      pricing: makePricing({ taxSavedUsd: 300 }),
      disclaimer: "preview",
    };

    const usDossier = buildExpenseAccountingDossier({
      input: usInput,
      preview: usPreview,
    });
    expect(usDossier.format).toBe("QUICKBOOKS_EXPENSE");
    expect(usDossier.records[0].txnType).toBe("Expense");
    expect(usDossier.csvExport).toContain("AWS");

    const brInput: DeductibleExpenseInput = {
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      vendorName: "OpenAI Enterprise",
      description: "API inference credits",
      amountUsd: 2000,
      usdBrlRate: 5.8,
      hasFiscalDocument: true,
      fiscalDocumentId: "NFSE-9988",
    };
    const brPreview: DeductibleExpensePreview = {
      planId: "exp-br-1",
      jurisdiction: "BR",
      regime: "PJ_LUCRO_REAL",
      category: "Software / AI Infrastructure",
      deductible: true,
      taxSavingsBreakdown: {
        incomeTaxShieldUsd: 680,
        pisCofinsCreditUsd: 185,
        ibsCbsReadinessCreditUsd: 120,
        iofAndSpreadSavingsUsd: 40,
      },
      taxSavedUsd: 1025,
      complianceChecklist: ["Emitir NFS-e / fatura comercial"],
      pricing: makePricing({ taxSavedUsd: 1025 }),
      disclaimer: "preview",
    };

    const brDossier = buildExpenseAccountingDossier({
      input: brInput,
      preview: brPreview,
    });
    expect(brDossier.format).toBe("BR_LUCRO_REAL_OMIE_SPED");
    expect(brDossier.summary.irpjCsllRatePct).toBe(34);
    expect(brDossier.summary.pisCofinsRatePct).toBe(9.25);
    expect(brDossier.summary.ibsCbsReadiness).toBeDefined();
    expect(brDossier.records.some((r) => r.taxBasis === "IRPJ_CSLL_34_PCT")).toBe(
      true
    );
    expect(
      brDossier.records.some(
        (r) => r.taxBasis === "PIS_COFINS_NAO_CUMULATIVO_9_25_PCT"
      )
    ).toBe(true);
    expect(
      brDossier.records.some(
        (r) => r.taxBasis === "IBS_CBS_READINESS_EC_132_2023"
      )
    ).toBe(true);
    expect(brDossier.disclaimer).toMatch(/Contador/i);
  });
});
