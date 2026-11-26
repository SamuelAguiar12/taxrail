import type { DynamicPricingQuote, FullTaxOptimizationPlan } from "@taxrail/shared";
import type { Env } from "./env.js";

/** Default TTL for generated tax optimization plans (15 minutes). */
export const DEFAULT_PLAN_TTL_SECONDS = 900;

export interface ExecutionVerificationMeta {
  chain: "base" | "ethereum" | "arbitrum";
  treasuryWallet: string;
  expectedFeeTokenAddress?: string;
  expectedTreasuryFeeAtomic?: string;
  expectedFeeUsd: number;
}

/**
 * Persisted plan record storing the full unlocked payload alongside its dynamic x402 quote.
 */
export interface StoredPlanRecord {
  plan: FullTaxOptimizationPlan;
  pricing: DynamicPricingQuote;
  unlocked: boolean;
  createdAt: string;
  expiresAt: string;
  settlementTx?: string;
  executionVerification?: ExecutionVerificationMeta;
}

/**
 * Storage abstraction for pending and unlocked TaxRail optimization plans.
 */
export interface PlanStore {
  put(planId: string, data: StoredPlanRecord, ttlSeconds?: number): Promise<void>;
  get(planId: string): Promise<StoredPlanRecord | null>;
  markUnlocked(planId: string, settlementTx?: string): Promise<StoredPlanRecord | null>;
}

interface MemoryEntry {
  record: StoredPlanRecord;
  expiresAtMs: number;
}

const DEFAULT_MEMORY_MAP = new Map<string, MemoryEntry>();

/**
 * In-memory PlanStore with TTL eviction for local development and tests.
 */
export class InMemoryPlanStore implements PlanStore {
  constructor(private readonly store: Map<string, MemoryEntry> = DEFAULT_MEMORY_MAP) {}

  async put(
    planId: string,
    data: StoredPlanRecord,
    ttlSeconds: number = DEFAULT_PLAN_TTL_SECONDS
  ): Promise<void> {
    const expiresAtMs = Date.now() + Math.max(1, ttlSeconds) * 1000;
    this.store.set(planId, { record: data, expiresAtMs });
  }

  async get(planId: string): Promise<StoredPlanRecord | null> {
    const entry = this.store.get(planId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      this.store.delete(planId);
      return null;
    }
    return entry.record;
  }

  async markUnlocked(planId: string, settlementTx?: string): Promise<StoredPlanRecord | null> {
    const entry = this.store.get(planId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAtMs) {
      this.store.delete(planId);
      return null;
    }
    const updated: StoredPlanRecord = {
      ...entry.record,
      unlocked: true,
      ...(settlementTx ? { settlementTx } : {}),
    };
    this.store.set(planId, { record: updated, expiresAtMs: entry.expiresAtMs });
    return updated;
  }
}

/**
 * Cloudflare KV-backed PlanStore for production edge deployments.
 */
export class KvPlanStore implements PlanStore {
  constructor(private readonly kv: KVNamespace) {}

  private key(planId: string): string {
    return `plan:${planId}`;
  }

  async put(
    planId: string,
    data: StoredPlanRecord,
    ttlSeconds: number = DEFAULT_PLAN_TTL_SECONDS
  ): Promise<void> {
    // Cloudflare KV enforces a minimum expirationTtl of 60 seconds.
    const expirationTtl = Math.max(60, Math.ceil(ttlSeconds));
    await this.kv.put(this.key(planId), JSON.stringify(data), { expirationTtl });
  }

  async get(planId: string): Promise<StoredPlanRecord | null> {
    const raw = await this.kv.get(this.key(planId));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredPlanRecord;
      if (parsed.expiresAt && Date.parse(parsed.expiresAt) < Date.now()) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  async markUnlocked(planId: string, settlementTx?: string): Promise<StoredPlanRecord | null> {
    const existing = await this.get(planId);
    if (!existing) return null;
    const updated: StoredPlanRecord = {
      ...existing,
      unlocked: true,
      ...(settlementTx ? { settlementTx } : {}),
    };
    const remainingSeconds = existing.expiresAt
      ? Math.max(60, Math.ceil((Date.parse(existing.expiresAt) - Date.now()) / 1000))
      : DEFAULT_PLAN_TTL_SECONDS;
    await this.put(planId, updated, remainingSeconds);
    return updated;
  }
}

/**
 * Creates a PlanStore backed by Cloudflare KV when bound, or falls back to an in-memory Map.
 */
export function createPlanStore(env: Env): PlanStore {
  if (env.TAXRAIL_PLANS) {
    return new KvPlanStore(env.TAXRAIL_PLANS);
  }
  return new InMemoryPlanStore();
}
