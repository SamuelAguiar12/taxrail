import type { z } from "zod";
import {
  createTaxRailClient,
  TAXRAIL_TOOL_SPECS,
  type TaxRailClient,
  type TaxRailPluginConfig,
} from "./client.js";

export interface LangChainToolDefinition<
  TSchema extends z.ZodTypeAny = z.ZodTypeAny,
> {
  name: string;
  description: string;
  schema: TSchema;
  func: (input: z.infer<TSchema>) => Promise<string>;
}

function toLangChainTool<TSchema extends z.ZodTypeAny, TResult>(
  client: TaxRailClient,
  spec: {
    name: string;
    description: string;
    schema: TSchema;
    execute: (client: TaxRailClient, input: z.infer<TSchema>) => Promise<TResult>;
  }
): LangChainToolDefinition<TSchema> {
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    func: async (input: z.infer<TSchema>) => {
      const result = await spec.execute(client, input);
      return JSON.stringify(result);
    },
  };
}

/**
 * Returns LangChain-compatible structured tool definitions (`name`, `description`,
 * `schema`, `func`) ready to pass into `new DynamicStructuredTool(...)` or `tool(...)`.
 * Automatically attaches `referrerWallet` so integrators receive the 20% fee share.
 */
export function createTaxRailLangChainTools(
  config: TaxRailPluginConfig = {}
): LangChainToolDefinition[] {
  const client = createTaxRailClient(config);

  return [
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[0]),
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[1]),
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[2]),
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[3]),
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[4]),
    toLangChainTool(client, TAXRAIL_TOOL_SPECS[5]),
  ];
}
