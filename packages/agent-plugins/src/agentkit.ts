import type {
  BorrowVsSellInput,
  BorrowVsSellPreview,
  CheckTaxImpactInput,
  CheckTaxImpactRedactedResponse,
  DeductibleExpenseInput,
  DeductibleExpensePreview,
} from "@taxrail/shared";
import type { z } from "zod";
import {
  createTaxRailClient,
  TAXRAIL_TOOL_SPECS,
  type TaxRailClient,
  type TaxRailPluginConfig,
  type UnlockPlanResult,
  type UnlockTaxPlanActionInput,
} from "./client.js";

export interface AgentKitAction<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  invoke: (args: z.infer<TSchema>) => Promise<string>;
}

export interface AgentKitNetwork {
  protocolFamily?: string;
  networkId?: string;
  chainId?: string;
}

const SUPPORTED_PROTOCOL_FAMILIES = new Set(["evm", "svm", "solana"]);
const SUPPORTED_NETWORK_IDS = new Set([
  "base",
  "base-mainnet",
  "base-sepolia",
  "eip155:8453",
  "eip155:84532",
  "ethereum",
  "ethereum-mainnet",
  "eip155:1",
  "arbitrum",
  "arbitrum-mainnet",
  "eip155:42161",
  "solana",
  "solana-mainnet",
]);

function toAgentKitAction<TSchema extends z.ZodTypeAny, TResult>(
  client: TaxRailClient,
  spec: {
    name: string;
    description: string;
    schema: TSchema;
    execute: (client: TaxRailClient, input: z.infer<TSchema>) => Promise<TResult>;
  }
): AgentKitAction<TSchema> {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    invoke: async (args: z.infer<TSchema>) => {
      const result = await spec.execute(client, args);
      return JSON.stringify(result, null, 2);
    },
  };
}

/**
 * Builds Coinbase AgentKit-compatible actions for TaxRail (`check_tax_impact`,
 * `compare_borrow_vs_sell`, `classify_deductible_expense`, `unlock_tax_plan`),
 * automatically attaching `referrerWallet` for the 20% affiliate share.
 */
export function createTaxRailActions(
  config: TaxRailPluginConfig = {}
): AgentKitAction[] {
  const client = createTaxRailClient(config);

  return [
    toAgentKitAction(client, TAXRAIL_TOOL_SPECS[0]),
    toAgentKitAction(client, TAXRAIL_TOOL_SPECS[1]),
    toAgentKitAction(client, TAXRAIL_TOOL_SPECS[2]),
    toAgentKitAction(client, TAXRAIL_TOOL_SPECS[3]),
  ];
}

/**
 * Dependency-light Coinbase AgentKit-compatible ActionProvider for TaxRail.
 */
export class TaxRailActionProvider {
  readonly name = "taxrail";
  readonly actionProviders: never[] = [];
  readonly baseUrl: string;
  readonly referrerWallet?: string;

  private readonly client: TaxRailClient;
  private readonly actions: AgentKitAction[];

  constructor(config: TaxRailPluginConfig = {}) {
    this.client = createTaxRailClient(config);
    this.baseUrl = this.client.baseUrl;
    this.referrerWallet = config.referrerWallet;
    this.actions = createTaxRailActions(config);
  }

  supportsNetwork(network: AgentKitNetwork): boolean {
    const family = network.protocolFamily?.toLowerCase();
    const networkId = (network.networkId ?? network.chainId)?.toLowerCase();

    if (family && SUPPORTED_PROTOCOL_FAMILIES.has(family)) {
      return true;
    }
    if (networkId && SUPPORTED_NETWORK_IDS.has(networkId)) {
      return true;
    }
    return !family && !networkId;
  }

  getActions(): AgentKitAction[] {
    return this.actions;
  }

  checkTaxImpact(
    input: CheckTaxImpactInput
  ): Promise<CheckTaxImpactRedactedResponse> {
    return this.client.checkTaxImpact(input);
  }

  compareBorrowVsSell(
    input: BorrowVsSellInput
  ): Promise<BorrowVsSellPreview> {
    return this.client.compareBorrowVsSell(input);
  }

  classifyDeductibleExpense(
    input: DeductibleExpenseInput
  ): Promise<DeductibleExpensePreview> {
    return this.client.classifyDeductibleExpense(input);
  }

  unlockTaxPlan(input: UnlockTaxPlanActionInput): Promise<UnlockPlanResult> {
    return this.client.unlockTaxPlan(input);
  }
}

export function taxRailActionProvider(
  config: TaxRailPluginConfig = {}
): TaxRailActionProvider {
  return new TaxRailActionProvider(config);
}
