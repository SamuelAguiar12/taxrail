import {
  BorrowVsSellInputSchema,
  CheckTaxImpactInputSchema,
  DeductibleExpenseInputSchema,
  UnlockPlanInputSchema,
  type BorrowVsSellInput,
  type BorrowVsSellPreview,
  type CheckTaxImpactInput,
  type CheckTaxImpactRedactedResponse,
  type DeductibleExpenseInput,
  type DeductibleExpensePreview,
  type FullTaxOptimizationPlan,
  type PricingTier,
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
}

export interface TaxRailToolSpec<TSchema extends z.ZodTypeAny, TResult> {
  name:
    | "check_tax_impact"
    | "compare_borrow_vs_sell"
    | "classify_deductible_expense"
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
        "/api/v1/compare-borrow-vs-sell",
        parsed
      );
    },

    classifyDeductibleExpense(input) {
      const parsed = DeductibleExpenseInputSchema.parse(
        withAffiliateDefaults(input, config)
      );
      return postJson<DeductibleExpensePreview>(
        "/api/v1/classify-deductible-expense",
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
    name: "unlock_tax_plan",
    description:
      "Unlocks the full executable tax optimization plan (selected lots, non-custodial 0x/CoW/Jupiter swap intent or Aave v3 calldata, and Form 8949 / QuickBooks / Lei 14.754 / SPED accounting dossier) via x402 Base USDC settlement.",
    schema: UnlockTaxPlanActionInputSchema,
    execute: (client: TaxRailClient, input: UnlockTaxPlanActionInput) =>
      client.unlockTaxPlan(input),
  },
] as const;
