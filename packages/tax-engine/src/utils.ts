import type { CheckTaxImpactInput, TaxLot, TaxRegimeBR, TaxRegimeUS } from "@taxrail/shared";

export const TAXRAIL_DISCLAIMER =
  "TaxRail provides deterministic quantitative tax simulations for software automation and planning only. Outputs do not constitute legal, accounting, or tax advice; consult a licensed CPA or Brazilian Contador before filing.";

const US_REGIMES: ReadonlySet<string> = new Set<TaxRegimeUS>([
  "INDIVIDUAL",
  "LLC_PASS_THROUGH",
  "C_CORP",
]);

const BR_REGIMES: ReadonlySet<string> = new Set<TaxRegimeBR>([
  "PF_LEI_14754",
  "PF_DOMESTIC",
  "PJ_LUCRO_REAL",
  "PJ_SIMPLES_EXPORT",
]);

export function assertJurisdictionRegime(
  jurisdiction: "US" | "BR",
  regime: string
): void {
  if (jurisdiction === "US" && !US_REGIMES.has(regime)) {
    throw new Error(`Regime "${regime}" is not valid for US jurisdiction.`);
  }
  if (jurisdiction === "BR" && !BR_REGIMES.has(regime)) {
    throw new Error(`Regime "${regime}" is not valid for BR jurisdiction.`);
  }
}

/** Round to 2 decimal places using half-up bias mitigation and eliminating -0. */
export function round2(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Round asset quantities to 8 decimal places to avoid floating-point dust. */
export function round8(value: number): number {
  const rounded = Math.round((value + Number.EPSILON) * 1e8) / 1e8;
  return Object.is(rounded, -0) ? 0 : rounded;
}

const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Computes whole holding days between `acquiredAt` and `asOfDate`.
 * Under US IRC §1222, long-term treatment requires holding strictly > 365 days.
 */
export function computeHoldingDays(acquiredAt: string, asOfDate: string): number {
  const acquiredMs = Date.parse(acquiredAt);
  const asOfMs = Date.parse(asOfDate);
  if (Number.isNaN(acquiredMs) || Number.isNaN(asOfMs)) {
    throw new Error(`Invalid ISO timestamp in holding-period calculation: ${acquiredAt} / ${asOfDate}`);
  }
  return Math.max(0, Math.floor((asOfMs - acquiredMs) / MS_PER_DAY));
}

export function resolveDisposalQuantity(
  input: CheckTaxImpactInput,
  matchingLots: TaxLot[]
): { quantityToSell: number; warnings: string[] } {
  const warnings: string[] = [];
  const requested =
    input.sellQuantity !== undefined
      ? input.sellQuantity
      : input.targetProceedsUsd !== undefined
        ? input.targetProceedsUsd / input.currentPriceUsd
        : 0;

  if (requested <= 0) {
    warnings.push("Requested disposal quantity is zero; no lots selected.");
    return { quantityToSell: 0, warnings };
  }

  const totalAvailable = matchingLots.reduce((sum, lot) => sum + lot.quantity, 0);
  if (totalAvailable <= 0) {
    warnings.push(`No lots found matching target asset ${input.targetAsset}.`);
    return { quantityToSell: 0, warnings };
  }

  if (requested > totalAvailable + 1e-8) {
    warnings.push(
      `Requested quantity (${round8(requested)} ${input.targetAsset}) exceeds available lot balance (${round8(totalAvailable)} ${input.targetAsset}); capped to available balance.`
    );
    return { quantityToSell: round8(totalAvailable), warnings };
  }

  return { quantityToSell: round8(Math.min(requested, totalAvailable)), warnings };
}

export function filterMatchingLots(lots: TaxLot[], targetAsset: string): TaxLot[] {
  const target = targetAsset.trim().toUpperCase();
  return lots.filter((lot) => lot.asset.trim().toUpperCase() === target && lot.quantity > 0);
}

export type ExpenseCategory =
  | "Cloud & AI Compute"
  | "Software & SaaS"
  | "Marketing & Ads"
  | "Professional Services"
  | "Travel & Lodging"
  | "General Business Expense";

const CATEGORY_KEYWORDS: ReadonlyArray<{ category: ExpenseCategory; keywords: readonly string[] }> = [
  {
    category: "Cloud & AI Compute",
    keywords: [
      "aws",
      "amazon web services",
      "gcp",
      "google cloud",
      "azure",
      "cloudflare",
      "vercel",
      "openai",
      "anthropic",
      "claude",
      "bedrock",
      "gpu",
      "compute",
      "hosting",
      "hetzner",
      "digitalocean",
      "modal",
      "replicate",
      "runpod",
      "inferenc",
      "llm",
      "token",
      "server",
    ],
  },
  {
    category: "Software & SaaS",
    keywords: [
      "saas",
      "software",
      "github",
      "gitlab",
      "linear",
      "figma",
      "notion",
      "slack",
      "datadog",
      "sentry",
      "stripe",
      "cursor",
      "jetbrains",
      "adobe",
      "subscription",
      "license",
      "crm",
      "erp",
    ],
  },
  {
    category: "Marketing & Ads",
    keywords: [
      "ads",
      "google ads",
      "meta",
      "facebook",
      "instagram",
      "linkedin",
      "twitter",
      "marketing",
      "sponsorship",
      "campaign",
      "seo",
      "growth",
      "promo",
      "publicity",
    ],
  },
  {
    category: "Professional Services",
    keywords: [
      "legal",
      "attorney",
      "lawyer",
      "advogado",
      "cpa",
      "accountant",
      "accounting",
      "contabil",
      "contador",
      "audit",
      "auditoria",
      "consult",
      "advisory",
      "contractor",
      "freelance",
    ],
  },
  {
    category: "Travel & Lodging",
    keywords: [
      "flight",
      "airline",
      "delta",
      "united",
      "latam",
      "azul",
      "gol",
      "hotel",
      "airbnb",
      "lodging",
      "hospedagem",
      "uber",
      "lyft",
      "travel",
      "viagem",
      "conference",
    ],
  },
];

export function classifyExpenseCategory(vendorName: string, description: string): ExpenseCategory {
  const haystack = `${vendorName} ${description}`.toLowerCase();
  for (const entry of CATEGORY_KEYWORDS) {
    if (entry.keywords.some((kw) => haystack.includes(kw))) {
      return entry.category;
    }
  }
  return "General Business Expense";
}
