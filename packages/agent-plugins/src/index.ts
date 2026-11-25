export {
  DEFAULT_TAXRAIL_BASE_URL,
  TAXRAIL_TOOL_SPECS,
  TaxRailApiError,
  UnlockTaxPlanActionInputSchema,
  createTaxRailClient,
  type PaymentRequiredChallenge,
  type TaxRailClient,
  type TaxRailPluginConfig,
  type TaxRailToolSpec,
  type UnlockPlanResult,
  type UnlockTaxPlanActionInput,
} from "./client.js";

export {
  TaxRailActionProvider,
  createTaxRailActions,
  taxRailActionProvider,
  type AgentKitAction,
  type AgentKitNetwork,
} from "./agentkit.js";

export {
  createTaxRailLangChainTools,
  type LangChainToolDefinition,
} from "./langchain.js";

import n8nNodeSpec from "./n8n-node.json" with { type: "json" };
export { n8nNodeSpec };
