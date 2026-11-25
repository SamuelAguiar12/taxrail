import {
  HTTPFacilitatorClient,
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
} from "@x402/core/types";
import {
  DEFAULT_FACILITATOR_URL,
  DEFAULT_PAY_TO_ADDRESS,
  DEFAULT_X402_ASSET,
  DEFAULT_X402_NETWORK,
  type Env,
  resolvePublicBaseUrl,
} from "./env.js";
import type { PlanStore, StoredPlanRecord } from "./plan-store.js";

/**
 * Result returned by `verifyUnlockPayment` for both HTTP `/api/v1/unlock-plan` and MCP `unlock_tax_plan`.
 */
export type UnlockPaymentResult =
  | {
      status: "not_found";
      planId: string;
    }
  | {
      status: "paid";
      record: StoredPlanRecord;
      settlementTx?: string;
      paymentResponseHeader?: string;
    }
  | {
      status: "payment_required";
      record: StoredPlanRecord;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    }
  | {
      status: "invalid_payment";
      record: StoredPlanRecord;
      reason: string;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    }
  | {
      status: "settlement_failed";
      record: StoredPlanRecord;
      reason: string;
      paymentRequired: PaymentRequired;
      paymentRequiredHeader: string;
    };

/**
 * Converts a USD dollar amount to 6-decimal USDC atomic units as a base-10 string.
 */
export function usdToUsdcAtomic(usdAmount: number): string {
  const atomic = Math.max(0, Math.round(usdAmount * 1_000_000));
  return String(atomic);
}

/**
 * Builds the x402 v2 PaymentRequired payload for a stored plan's dynamic pricing quote.
 */
export function buildPlanPaymentRequired(
  record: StoredPlanRecord,
  env: Env,
  requestUrl?: string
): { paymentRequired: PaymentRequired; requirements: PaymentRequirements } {
  const network = (env.X402_NETWORK || DEFAULT_X402_NETWORK) as Network;
  const asset = env.X402_ASSET || DEFAULT_X402_ASSET;
  const payTo = env.PAY_TO_ADDRESS || DEFAULT_PAY_TO_ADDRESS;
  const baseUrl = resolvePublicBaseUrl(env, requestUrl);

  const requirements: PaymentRequirements = {
    scheme: "exact",
    network,
    asset,
    amount: usdToUsdcAtomic(record.pricing.upfrontX402Usd),
    payTo,
    maxTimeoutSeconds: 300,
    extra: {
      name: "USD Coin",
      version: "2",
      planId: record.plan.planId,
      taxSavedUsd: record.pricing.taxSavedUsd,
      feeRatePct: record.pricing.feeRatePct,
    },
  };

  const paymentRequired: PaymentRequired = {
    x402Version: 2,
    error: "Payment Required",
    resource: {
      url: `${baseUrl}/api/v1/unlock-plan`,
      description: `Unlock TaxRail optimization plan ${record.plan.planId} (saves $${record.pricing.taxSavedUsd.toFixed(2)})`,
      mimeType: "application/json",
    },
    accepts: [requirements],
  };

  return { paymentRequired, requirements };
}

function parsePaymentPayload(rawHeader: string): PaymentPayload | null {
  const trimmed = rawHeader.trim();
  if (!trimmed) return null;

  try {
    return decodePaymentSignatureHeader(trimmed);
  } catch {
    try {
      const parsed = JSON.parse(trimmed) as PaymentPayload;
      if (parsed && typeof parsed === "object" && "payload" in parsed) {
        return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/**
 * Verifies and settles dynamic x402 payment for unlocking a TaxRail plan.
 * Shared across the Hono `/api/v1/unlock-plan` route and the MCP `unlock_tax_plan` tool.
 */
export async function verifyUnlockPayment(params: {
  planId: string;
  paymentHeader?: string | null;
  planStore: PlanStore;
  env: Env;
  requestUrl?: string;
}): Promise<UnlockPaymentResult> {
  const { planId, paymentHeader, planStore, env, requestUrl } = params;
  const record = await planStore.get(planId);
  if (!record) {
    return { status: "not_found", planId };
  }

  // Zero-fee plans ($0 verified savings) and already-unlocked plans unlock immediately.
  if (record.unlocked || record.pricing.upfrontX402Usd <= 0) {
    const unlocked = record.unlocked
      ? record
      : (await planStore.markUnlocked(planId, "zero-fee")) ?? { ...record, unlocked: true };
    return {
      status: "paid",
      record: unlocked,
      settlementTx: unlocked.settlementTx,
    };
  }

  const { paymentRequired, requirements } = buildPlanPaymentRequired(record, env, requestUrl);
  const paymentRequiredHeader = encodePaymentRequiredHeader(paymentRequired);

  const trimmedHeader = paymentHeader?.trim();
  if (!trimmedHeader) {
    return {
      status: "payment_required",
      record,
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  // Non-production dev/test bypass when X402_DEV_BYPASS_TOKEN is explicitly configured.
  if (
    env.X402_DEV_BYPASS_TOKEN &&
    trimmedHeader === `dev-bypass:${env.X402_DEV_BYPASS_TOKEN}`
  ) {
    const unlocked = (await planStore.markUnlocked(planId, "dev-bypass")) ?? {
      ...record,
      unlocked: true,
      settlementTx: "dev-bypass",
    };
    return {
      status: "paid",
      record: unlocked,
      settlementTx: "dev-bypass",
    };
  }

  const paymentPayload = parsePaymentPayload(trimmedHeader);
  if (!paymentPayload) {
    return {
      status: "invalid_payment",
      record,
      reason: "Malformed x402 payment signature header",
      paymentRequired,
      paymentRequiredHeader,
    };
  }

  const facilitator = new HTTPFacilitatorClient({
    url: env.FACILITATOR_URL || DEFAULT_FACILITATOR_URL,
  });

  try {
    const verifyResult = await facilitator.verify(paymentPayload, requirements);
    if (!verifyResult.isValid) {
      return {
        status: "invalid_payment",
        record,
        reason:
          verifyResult.invalidMessage ||
          verifyResult.invalidReason ||
          "Facilitator rejected payment verification",
        paymentRequired,
        paymentRequiredHeader,
      };
    }

    const settleResult = await facilitator.settle(paymentPayload, requirements);
    if (!settleResult.success) {
      return {
        status: "settlement_failed",
        record,
        reason:
          settleResult.errorMessage ||
          settleResult.errorReason ||
          "Facilitator settlement failed",
        paymentRequired,
        paymentRequiredHeader,
      };
    }

    const unlocked = (await planStore.markUnlocked(planId, settleResult.transaction)) ?? {
      ...record,
      unlocked: true,
      settlementTx: settleResult.transaction,
    };

    return {
      status: "paid",
      record: unlocked,
      settlementTx: settleResult.transaction,
      paymentResponseHeader: encodePaymentResponseHeader(settleResult),
    };
  } catch (err) {
    return {
      status: "settlement_failed",
      record,
      reason: err instanceof Error ? err.message : "x402 facilitator communication error",
      paymentRequired,
      paymentRequiredHeader,
    };
  }
}
