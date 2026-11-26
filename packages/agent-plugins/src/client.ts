import {
  BorrowVsSellInputSchema,
  CheckTaxImpactInputSchema,
  ClaimDossierInputSchema,
  DeductibleExpenseInputSchema,
  PrepareExecutionInputSchema,
  UnlockPlanInputSchema,
  type BorrowVsSellInput,
  type BorrowVsSellPreview,
  type Br35kStatusResult,
  type CheckTaxImpactInput,
  type CheckTaxImpactRedactedResponse,
  type ClaimDossierInput,
  type ClaimDossierResponse,
  type DeductibleExpenseInput,
  type DeductibleExpensePreview,
  type FullTaxOptimizationPlan,
  type PrepareExecutionInput,
  type PrepareExecutionResponse,
  type PreTradeCheckResult,
  type PricingTier,
  type WalletTlhScanResult,
} from "@taxrail/shared";
import { z } from "zod";

export const DEFAULT_TAXRAIL_BASE_URL = "https://api.taxrail.online";

export interface TaxRailPluginConfig {
  /** Base URL of the TaxRail Edge Worker / API (defaults to https://api.taxrail.online) */
  baseUrl?: string;
  /** Developer or integrator wallet address to receive the 20% affiliate fee share */
  referrerWallet?: string;
  /** Default pricing tier override */
  pricingTier?: PricingTier;
  /** Custom fetch implementation for testing or custom runtimes */
  fetchFn?: typeof fetch;
  /** Extra headers forwarded on every TaxRail API request */
  headers?: Record<string, string>;
}

export const UnlockTaxPlanActionInputSchema = UnlockPlanInputSchema.extend({
  /** Optional x402 payment signature header value for Base USDC settlement */
  paymentSignature: z.string().min(1).optional(),
  /** Optional per-call affiliate wallet override */
  referrerWallet: z.string().min(1).optional(),
});

export type UnlockTaxPlanActionInput = z.infer<
  typeof UnlockTaxPlanActionInputSchema
>;

export interface PaymentRequiredChallenge {
  status: 402;
  paymentRequired: true;
  paymentHeader: string | null;
  body: unknown;
  instructions: string;
}

export type UnlockPlanResult =
  | FullTaxOptimizationPlan
  | PaymentRequiredChallenge;

export class TaxRailApiError extends Error {
  readonly status: number;
  readonly endpoint: string;
  readonly body: unknown;

  constructor(status: number, endpoint: string, body: unknown) {
    const detail =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as { error: unknown }).error)
        : typeof body === "string"
          ? body
          : `HTTP ${status}`;
    super(`TaxRail API error (${status}) on ${endpoint}: ${detail}`);
    this.name = "TaxRailApiError";
    this.status = status;
    this.endpoint = endpoint;
    this.body = body;
  }
}

export interface TaxRailClient {
  readonly baseUrl: string;
  readonly referrerWallet?: string;
  checkTaxImpact(
    input: CheckTaxImpactInput
  ): Promise<CheckTaxImpactRedactedResponse>;
  compareBorrowVsSell(input: BorrowVsSellInput): Promise<BorrowVsSellPreview>;
  classifyDeductibleExpense(
    input: DeductibleExpenseInput
  ): Promise<DeductibleExpensePreview>;
  unlockTaxPlan(input: UnlockTaxPlanActionInput): Promise<UnlockPlanResult>;
  prepareExecution(input: PrepareExecutionInput): Promise<PrepareExecutionResponse>;
  claimDossier(input: ClaimDossierInput): Promise<ClaimDossierResponse>;
  scanWalletTlh(params: {
    walletAddress: string;
    chain?: "base" | "ethereum" | "arbitrum";
    asset?: string;
    jurisdiction?: "US" | "BR";
    paymentSignature?: string;
    referrerWallet?: string;
  }): Promise<WalletTlhScanResult | PaymentRequiredChallenge>;
  preTradeCheck(params: {
    walletAddress: string;
    sellAsset: string;
    sellAmount: number;
    chain?: "base" | "ethereum" | "arbitrum";
    jurisdiction?: "US" | "BR";
    paymentSignature?: string;
    referrerWallet?: string;
  }): Promise<PreTradeCheckResult | PaymentRequiredChallenge>;
  checkBr35kStatus(params: {
    monthlySalesBrl?: number;
    plannedSaleUsd?: number;
    custodyLocation?: "DOMESTIC" | "OFFSHORE";
    usdBrlRate?: number;
    paymentSignature?: string;
  }): Promise<Br35kStatusResult | PaymentRequiredChallenge>;
}

export interface TaxRailToolSpec<TSchema extends z.ZodTypeAny, TResult> {
  name:
    | "check_tax_impact"
    | "compare_borrow_vs_sell"
    | "classify_deductible_expense"
    | "prepare_execution"
    | "claim_dossier"
    | "unlock_tax_plan";
  description: string;
  schema: TSchema;
  execute: (
    client: TaxRailClient,
    input: z.infer<TSchema>
  ) => Promise<TResult>;
}

function normalizeBaseUrl(baseUrl?: string): string {
  const raw = (baseUrl ?? DEFAULT_TAXRAIL_BASE_URL).trim();
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function withAffiliateDefaults<
  T extends { referrerWallet?: string; pricingTier?: PricingTier },
>(payload: T, config: TaxRailPluginConfig): T {
  const referrerWallet = payload.referrerWallet ?? config.referrerWallet;
  const pricingTier = payload.pricingTier ?? config.pricingTier;

  return {
    ...payload,
    ...(referrerWallet ? { referrerWallet } : {}),
    ...(pricingTier ? { pricingTier } : {}),
  };
}

/**
 * Creates a lightweight HTTP client bound to a TaxRail API base URL and optional
 * affiliate `referrerWallet` (20% fee share).
 */
export function createTaxRailClient(
  config: TaxRailPluginConfig = {}
): TaxRailClient {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const fetchImpl = config.fetchFn ?? globalThis.fetch;

  if (!fetchImpl) {
    throw new Error(
      "TaxRail plugin requires global fetch or a custom config.fetchFn."
    );
  }

  async function postJson<TResponse>(
    endpoint: string,
    payload: unknown,
    extraHeaders?: Record<string, string>,
    allow402 = false
  ): Promise<TResponse> {
    const url = `${baseUrl}${endpoint}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...config.headers,
      ...(config.referrerWallet
        ? { "X-TaxRail-Referrer": config.referrerWallet }
        : {}),
      ...extraHeaders,
    };

    const response = await fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    const parsed = await parseResponseBody(response);

    if (allow402 && response.status === 402) {
      const paymentHeader =
        response.headers.get("PAYMENT-REQUIRED") ??
        response.headers.get("X-PAYMENT-REQUIRED");

      const challenge: PaymentRequiredChallenge = {
        status: 402,
        paymentRequired: true,
        paymentHeader,
        body: parsed,
        instructions:
          "Settle the quoted Base USDC (eip155:8453) x402 payment and retry unlock_tax_plan with paymentSignature.",
      };
      return challenge as TResponse;
    }

    if (!response.ok) {
      throw new TaxRailApiError(response.status, endpoint, parsed);
    }

    return parsed as TResponse;
  }

  async function getX402Json<TResponse>(
    endpoint: string,
    instructions: string,
    opts: { paymentSignature?: string; referrerWallet?: string } = {}
  ): Promise<TResponse | PaymentRequiredChallenge> {
    const referrerWallet = opts.referrerWallet ?? config.referrerWallet;
    const response = await fetchImpl(`${baseUrl}${endpoint}`, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...config.headers,
        ...(referrerWallet ? { "X-TaxRail-Referrer": referrerWallet } : {}),
        ...(opts.paymentSignature
          ? {
              "PAYMENT-SIGNATURE": opts.paymentSignature,
              "X-PAYMENT": opts.paymentSignature,
            }
          : {}),
      },
    });

    const parsed = await parseResponseBody(response);
    if (response.status === 402) {
      return {
        status: 402,
        paymentRequired: true,
        paymentHeader:
          response.headers.get("PAYMENT-REQUIRED") ??
          response.headers.get("X-PAYMENT-REQUIRED"),
        body: parsed,
        instructions,
      };
    }
    if (!response.ok) {
      throw new TaxRailApiError(response.status, endpoint, parsed);
    }
    return parsed as TResponse;
  }

  return {
    baseUrl,
    referrerWallet: config.referrerWallet,

    checkTaxImpact(input) {
      const parsed = CheckTaxImpactInputSchema.parse(
        withAffiliateDefaults(input, config)
      );
      return postJson<CheckTaxImpactRedactedResponse>(
        "/api/v1/check-tax-impact",
        parsed
      );
    },

    compareBorrowVsSell(input) {
      const parsed = BorrowVsSellInputSchema.parse(
        withAffiliateDefaults(input, config)
      );
      return postJson<BorrowVsSellPreview>(
        "/api/v1/borrow-vs-sell",
        parsed
      );
    },

    classifyDeductibleExpense(input) {
      const parsed = DeductibleExpenseInputSchema.parse(
        withAffiliateDefaults(input, config)
      );
      return postJson<DeductibleExpensePreview>(
        "/api/v1/classify-expense",
        parsed
      );
    },

    unlockTaxPlan(input) {
      const parsed = UnlockTaxPlanActionInputSchema.parse(input);
      const referrerWallet = parsed.referrerWallet ?? config.referrerWallet;
      const extraHeaders: Record<string, string> = {
        ...(referrerWallet ? { "X-TaxRail-Referrer": referrerWallet } : {}),
        ...(parsed.paymentSignature
          ? {
              "PAYMENT-SIGNATURE": parsed.paymentSignature,
              "X-PAYMENT": parsed.paymentSignature,
            }
          : {}),
      };

      return postJson<UnlockPlanResult>(
        "/api/v1/unlock-plan",
        {
          planId: parsed.planId,
          ...(referrerWallet ? { referrerWallet } : {}),
        },
        extraHeaders,
        true
      );
    },

    prepareExecution(input) {
      const parsed = PrepareExecutionInputSchema.parse(input);
      return postJson<PrepareExecutionResponse>("/api/v1/prepare-execution", parsed);
    },

    claimDossier(input) {
      const parsed = ClaimDossierInputSchema.parse(input);
      return postJson<ClaimDossierResponse>("/api/v1/claim-dossier", parsed);
    },

    scanWalletTlh(params) {
      const qs = new URLSearchParams({
        walletAddress: params.walletAddress,
        ...(params.chain ? { chain: params.chain } : {}),
        ...(params.asset ? { asset: params.asset } : {}),
        ...(params.jurisdiction ? { jurisdiction: params.jurisdiction } : {}),
      });
      const referrerWallet = params.referrerWallet ?? config.referrerWallet;
      if (referrerWallet) {
        qs.set("referrerWallet", referrerWallet);
      }
      return getX402Json<WalletTlhScanResult>(
        `/api/v1/x402/tlh-scan?${qs.toString()}`,
        "Settle the $0.01 Base USDC (eip155:8453) x402 payment and retry scanWalletTlh with paymentSignature.",
        params
      );
    },

    preTradeCheck(params) {
      const qs = new URLSearchParams({
        walletAddress: params.walletAddress,
        sellAsset: params.sellAsset,
        sellAmount: String(params.sellAmount),
        ...(params.chain ? { chain: params.chain } : {}),
        ...(params.jurisdiction ? { jurisdiction: params.jurisdiction } : {}),
      });
      const referrerWallet = params.referrerWallet ?? config.referrerWallet;
      if (referrerWallet) {
        qs.set("referrerWallet", referrerWallet);
      }
      return getX402Json<PreTradeCheckResult>(
        `/api/v1/x402/pre-trade-check?${qs.toString()}`,
        "Settle the $0.01 Base USDC (eip155:8453) x402 payment and retry preTradeCheck with paymentSignature.",
        params
      );
    },

    checkBr35kStatus(params) {
      const qs = new URLSearchParams({
        monthlySalesBrl: String(params.monthlySalesBrl ?? 0),
        plannedSaleUsd: String(params.plannedSaleUsd ?? 1000),
        custodyLocation: params.custodyLocation ?? "DOMESTIC",
        ...(params.usdBrlRate !== undefined ? { usdBrlRate: String(params.usdBrlRate) } : {}),
      });
      return getX402Json<Br35kStatusResult>(
        `/api/v1/x402/br-35k-status?${qs.toString()}`,
        "Settle the $0.005 Base USDC (eip155:8453) x402 payment and retry checkBr35kStatus with paymentSignature.",
        params
      );
    },
  };
}

export const TAXRAIL_TOOL_SPECS = [
  {
    name: "check_tax_impact",
    description:
      "Free pre-trade US & Brazil tax impact simulator. Compares baseline FIFO/naive disposal against tax-optimized lot selection (HIFO/SpecID, TLH, BR R$35k exemption, Lei 14.754, Lucro Real) and returns verified taxSavedUsd, dynamic x402 quote, and planId.",
    schema: CheckTaxImpactInputSchema,
    execute: (client: TaxRailClient, input: CheckTaxImpactInput) =>
      client.checkTaxImpact(input),
  },
  {
    name: "compare_borrow_vs_sell",
    description:
      "Free quantitative comparison between selling appreciated crypto lots vs borrowing USDC on Aave v3 (Base/Ethereum/Arbitrum), including LTV liquidation risk, borrow APR cost, corporate interest tax shield, and net tax savings.",
    schema: BorrowVsSellInputSchema,
    execute: (client: TaxRailClient, input: BorrowVsSellInput) =>
      client.compareBorrowVsSell(input),
  },
  {
    name: "classify_deductible_expense",
    description:
      "Free expense deductibility & tax-shield analyzer for US (LLC/C-Corp) and Brazil (Lucro Real / Simples Export) covering income tax shield, PIS/COFINS credits, IBS/CBS readiness, and IOF/FX spread savings.",
    schema: DeductibleExpenseInputSchema,
    execute: (client: TaxRailClient, input: DeductibleExpenseInput) =>
      client.classifyDeductibleExpense(input),
  },
  {
    name: "prepare_execution",
    description:
      "FREE $0-upfront pre-execution builder: returns ready-to-sign 0x v2 / Jupiter swap calldata or Aave v3 atomic borrow batch paying TaxRail's exact 10% verified-savings fee directly out of the operation.",
    schema: PrepareExecutionInputSchema,
    execute: (client: TaxRailClient, input: PrepareExecutionInput) =>
      client.prepareExecution(input),
  },
  {
    name: "claim_dossier",
    description:
      "Verifies the settled swap or Aave borrow txHash on-chain and unlocks exact SpecID lots + Form 8949 / Brazil DeCripto CSV dossier with $0 upfront.",
    schema: ClaimDossierInputSchema,
    execute: (client: TaxRailClient, input: ClaimDossierInput) =>
      client.claimDossier(input),
  },
  {
    name: "unlock_tax_plan",
    description:
      "Dossier-only / corporate expense fallback via x402 Base USDC settlement. Unlocks selected lots, calldata, and Form 8949 / QuickBooks / Lei 14.754 / SPED accounting dossier.",
    schema: UnlockTaxPlanActionInputSchema,
    execute: (client: TaxRailClient, input: UnlockTaxPlanActionInput) =>
      client.unlockTaxPlan(input),
  },
] as const;
