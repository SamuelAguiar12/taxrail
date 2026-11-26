import { z } from "zod";
import type { Env } from "./env.js";
import type { PlanStore } from "./plan-store.js";

export const FeedbackCategorySchema = z.enum([
  "PRAISE",
  "BUG",
  "FEATURE_REQUEST",
  "ACCURACY",
  "GENERAL",
]);

export const FeedbackInputSchema = z.object({
  rating: z.number().int().min(1).max(5),
  category: FeedbackCategorySchema.default("GENERAL"),
  comment: z.string().trim().min(1).max(500),
  planId: z.string().trim().min(1).max(80).optional(),
  settlementTx: z
    .string()
    .trim()
    .regex(/^0x[a-fA-F0-9]{64}$/, "Must be a 32-byte 0x transaction hash")
    .optional(),
  agentName: z.string().trim().min(1).max(64).optional(),
  allowPublicQuote: z.boolean().optional().default(false),
});

export type FeedbackInput = z.infer<typeof FeedbackInputSchema>;
export type PaymentTier = "10PCT_UNLOCK" | "QUICK_OPTIMIZE" | "TLH_SCAN";

export interface PaidReceiptRecord {
  txHash: string;
  tier: PaymentTier;
  amountUsd: number;
  taxSavedUsd?: number;
  planId?: string;
  createdAt: string;
}

export interface StoredFeedbackEntry {
  id: string;
  rating: number;
  category: z.infer<typeof FeedbackCategorySchema>;
  comment: string;
  agentName?: string;
  planId?: string;
  settlementTx?: string;
  baseScanUrl?: string;
  verifiedPaid: boolean;
  paymentTier?: PaymentTier;
  verifiedTaxSavedUsd?: number;
  allowPublicQuote: boolean;
  safeForPublic: boolean;
  createdAt: string;
}

const RECEIPT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const FEEDBACK_ENTRIES_KEY = "feedback:entries";
const MAX_STORED_ENTRIES = 100;

const MEMORY_RECEIPTS = new Map<string, PaidReceiptRecord>();
const MEMORY_TX_FEEDBACK = new Set<string>();
const MEMORY_FEEDBACK_LIST: StoredFeedbackEntry[] = [];

const TX_HASH_REGEX = /^0x[a-fA-F0-9]{64}$/;
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior)\s+instructions/i,
  /system\s+prompt/i,
  /send\s+(all\s+)?(usdc|eth|funds|tokens)/i,
  /transfer\s+(all\s+)?(usdc|eth|funds|tokens)/i,
  /<\s*script/i,
  /javascript:/i,
];

function receiptKey(txHash: string): string {
  return `receipt:${txHash.toLowerCase()}`;
}

function txFeedbackKey(txHash: string): string {
  return `feedback_tx:${txHash.toLowerCase()}`;
}

/**
 * Sanitizes agent feedback against control characters, PII (emails/tax IDs), links, and
 * prompt-injection attempts before storage or optional public quotation.
 */
export function sanitizeFeedbackComment(raw: string): {
  sanitized: string;
  safeForPublic: boolean;
} {
  let clean = raw
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Strip email addresses, URLs, and long numeric sequences (CPF/CNPJ/SSN/phone)
  clean = clean
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/https?:\/\/\S+/gi, "[redacted-url]")
    .replace(/\b\d{3}[.-]?\d{3}[.-]?\d{3}[.-]?\d{2}\b/g, "[redacted-id]")
    .replace(/\b\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}\b/g, "[redacted-id]")
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, "[redacted-id]");

  if (!clean) {
    clean = "[redacted]";
  }

  const hasInjection = INJECTION_PATTERNS.some((pattern) => pattern.test(raw));
  return {
    sanitized: clean.slice(0, 500),
    safeForPublic: !hasInjection,
  };
}

/**
 * Persists a tamper-proof server-side settlement receipt whenever a real on-chain Base USDC
 * transaction settles via our x402 facilitator (ignores non-onchain dev-bypass/zero-fee strings).
 */
export async function recordPaidReceipt(
  env: Env,
  params: {
    settlementTx?: string;
    tier: PaymentTier;
    amountUsd: number;
    taxSavedUsd?: number;
    planId?: string;
  }
): Promise<void> {
  const tx = params.settlementTx?.trim();
  if (!tx || !TX_HASH_REGEX.test(tx)) {
    return;
  }

  const record: PaidReceiptRecord = {
    txHash: tx.toLowerCase(),
    tier: params.tier,
    amountUsd: params.amountUsd,
    ...(params.taxSavedUsd !== undefined ? { taxSavedUsd: params.taxSavedUsd } : {}),
    ...(params.planId ? { planId: params.planId } : {}),
    createdAt: new Date().toISOString(),
  };

  if (env.TAXRAIL_PLANS) {
    await env.TAXRAIL_PLANS.put(receiptKey(tx), JSON.stringify(record), {
      expirationTtl: RECEIPT_TTL_SECONDS,
    });
  } else {
    MEMORY_RECEIPTS.set(tx.toLowerCase(), record);
  }
}

export async function getPaidReceipt(
  env: Env,
  txHash?: string
): Promise<PaidReceiptRecord | null> {
  const tx = txHash?.trim();
  if (!tx || !TX_HASH_REGEX.test(tx)) {
    return null;
  }

  if (env.TAXRAIL_PLANS) {
    const raw = await env.TAXRAIL_PLANS.get(receiptKey(tx));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PaidReceiptRecord;
    } catch {
      return null;
    }
  }
  return MEMORY_RECEIPTS.get(tx.toLowerCase()) ?? null;
}

async function hasTxFeedback(env: Env, txHash: string): Promise<boolean> {
  if (env.TAXRAIL_PLANS) {
    return Boolean(await env.TAXRAIL_PLANS.get(txFeedbackKey(txHash)));
  }
  return MEMORY_TX_FEEDBACK.has(txHash.toLowerCase());
}

async function markTxFeedback(env: Env, txHash: string, feedbackId: string): Promise<void> {
  if (env.TAXRAIL_PLANS) {
    await env.TAXRAIL_PLANS.put(txFeedbackKey(txHash), feedbackId, {
      expirationTtl: RECEIPT_TTL_SECONDS,
    });
  } else {
    MEMORY_TX_FEEDBACK.add(txHash.toLowerCase());
  }
}

async function loadFeedbackEntries(env: Env): Promise<StoredFeedbackEntry[]> {
  if (env.TAXRAIL_PLANS) {
    const raw = await env.TAXRAIL_PLANS.get(FEEDBACK_ENTRIES_KEY);
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as StoredFeedbackEntry[]) : [];
    } catch {
      return [];
    }
  }
  return [...MEMORY_FEEDBACK_LIST];
}

async function saveFeedbackEntry(env: Env, entry: StoredFeedbackEntry): Promise<void> {
  if (env.TAXRAIL_PLANS) {
    const existing = await loadFeedbackEntries(env);
    const updated = [entry, ...existing].slice(0, MAX_STORED_ENTRIES);
    await env.TAXRAIL_PLANS.put(FEEDBACK_ENTRIES_KEY, JSON.stringify(updated));
  } else {
    MEMORY_FEEDBACK_LIST.unshift(entry);
    if (MEMORY_FEEDBACK_LIST.length > MAX_STORED_ENTRIES) {
      MEMORY_FEEDBACK_LIST.length = MAX_STORED_ENTRIES;
    }
  }
}

export type SubmitFeedbackResult =
  | {
      ok: true;
      id: string;
      verifiedPaid: boolean;
      paymentTier?: PaymentTier;
      publicQuoteEligible: boolean;
      message: string;
    }
  | {
      ok: false;
      status: 409;
      error: string;
    };

/**
 * Validates payment proof strictly on the server, sanitizes comment content, deduplicates
 * verified reviews per settlementTx, and persists agent feedback.
 */
export async function submitFeedback(params: {
  input: FeedbackInput;
  env: Env;
  planStore: PlanStore;
}): Promise<SubmitFeedbackResult> {
  const { input, env, planStore } = params;
  const { sanitized, safeForPublic } = sanitizeFeedbackComment(input.comment);

  let verifiedTx: string | undefined;
  let paymentTier: PaymentTier | undefined;
  let verifiedTaxSavedUsd: number | undefined;
  let resolvedPlanId = input.planId;

  if (input.settlementTx) {
    const receipt = await getPaidReceipt(env, input.settlementTx);
    if (receipt) {
      verifiedTx = receipt.txHash;
      paymentTier = receipt.tier;
      verifiedTaxSavedUsd = receipt.taxSavedUsd;
      if (!resolvedPlanId && receipt.planId) {
        resolvedPlanId = receipt.planId;
      }
    }
  }

  if (!verifiedTx && input.planId) {
    const storedPlan = await planStore.get(input.planId);
    if (storedPlan?.unlocked && storedPlan.settlementTx && TX_HASH_REGEX.test(storedPlan.settlementTx)) {
      verifiedTx = storedPlan.settlementTx.toLowerCase();
      paymentTier = "10PCT_UNLOCK";
      verifiedTaxSavedUsd = storedPlan.pricing.taxSavedUsd;
    }
  }

  if (verifiedTx && (await hasTxFeedback(env, verifiedTx))) {
    return {
      ok: false,
      status: 409,
      error: "Feedback already submitted for this settlementTx",
    };
  }

  const verifiedPaid = Boolean(verifiedTx);
  const id = `fb_${crypto.randomUUID().slice(0, 12)}`;
  const entry: StoredFeedbackEntry = {
    id,
    rating: input.rating,
    category: input.category,
    comment: sanitized,
    ...(input.agentName ? { agentName: input.agentName } : {}),
    ...(resolvedPlanId ? { planId: resolvedPlanId } : {}),
    ...(verifiedTx
      ? {
          settlementTx: verifiedTx,
          baseScanUrl: `https://basescan.org/tx/${verifiedTx}`,
        }
      : {}),
    verifiedPaid,
    ...(paymentTier ? { paymentTier } : {}),
    ...(verifiedTaxSavedUsd !== undefined ? { verifiedTaxSavedUsd } : {}),
    allowPublicQuote: Boolean(input.allowPublicQuote),
    safeForPublic,
    createdAt: new Date().toISOString(),
  };

  if (verifiedTx) {
    await markTxFeedback(env, verifiedTx, id);
  }
  await saveFeedbackEntry(env, entry);

  console.log(
    JSON.stringify({
      event: "agent_feedback",
      id,
      rating: entry.rating,
      category: entry.category,
      verifiedPaid: entry.verifiedPaid,
      paymentTier: entry.paymentTier ?? null,
      allowPublicQuote: entry.allowPublicQuote,
      safeForPublic: entry.safeForPublic,
      comment: entry.comment,
    })
  );

  const publicQuoteEligible = Boolean(
    entry.verifiedPaid && entry.allowPublicQuote && entry.safeForPublic
  );

  return {
    ok: true,
    id,
    verifiedPaid,
    ...(paymentTier ? { paymentTier } : {}),
    publicQuoteEligible,
    message: verifiedPaid
      ? publicQuoteEligible
        ? "Thank you! Verified paid feedback recorded and published on /api/v1/reputation."
        : "Thank you! Verified paid feedback recorded privately."
      : "Thank you! Feedback recorded for continuous TaxRail improvements.",
  };
}

/**
 * Returns aggregated feedback statistics and verifiable paid reviews (linked to BaseScan txHash)
 * where `allowPublicQuote === true` and safety checks passed.
 */
export async function getPublicReputation(env: Env) {
  const entries = await loadFeedbackEntries(env);
  const verifiedEntries = entries.filter((e) => e.verifiedPaid);
  const publicVerifiedReviews = verifiedEntries
    .filter((e) => e.allowPublicQuote && e.safeForPublic)
    .slice(0, 20)
    .map((e) => ({
      id: e.id,
      rating: e.rating,
      category: e.category,
      comment: e.comment,
      paymentTier: e.paymentTier,
      verifiedTaxSavedUsd: e.verifiedTaxSavedUsd,
      settlementTx: e.settlementTx,
      baseScanUrl: e.baseScanUrl,
      agentName: e.agentName,
      createdAt: e.createdAt,
    }));

  const avg = (list: StoredFeedbackEntry[]): number | null => {
    if (list.length === 0) return null;
    const sum = list.reduce((acc, item) => acc + item.rating, 0);
    return Number((sum / list.length).toFixed(2));
  };

  const totalVerifiedTaxSavedUsd = Number(
    verifiedEntries
      .reduce((sum, item) => sum + (item.verifiedTaxSavedUsd ?? 0), 0)
      .toFixed(2)
  );

  return {
    service: "TaxRail",
    summary: {
      totalFeedbackCount: entries.length,
      verifiedPaidReviewsCount: verifiedEntries.length,
      averageRatingAll: avg(entries),
      averageRatingVerifiedPaid: avg(verifiedEntries),
      totalVerifiedTaxSavedUsd,
    },
    verifiedReviews: publicVerifiedReviews,
    disclaimer:
      "Verified reviews require a matching server-verified Base USDC settlement transaction on BaseScan. Ratings across 1-5 are accepted symmetrically after automated PII and prompt-injection sanitization.",
  };
}
