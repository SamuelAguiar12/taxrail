export {
  AAVE_V3_POOL_ABI,
  AAVE_V3_POOL_ADDRESSES,
  ERC20_ABI,
  EVM_TOKEN_REGISTRY,
  FALLBACK_BORROWER_ADDRESS,
  buildAaveBorrowPayload,
  resolveEvmToken,
  type AaveSupportedChain,
  type TokenMetadata,
} from "./aave.js";

export { buildSwapIntent } from "./swap-router.js";

export {
  DEFAULT_PTAX_USD_BRL,
  TAXRAIL_ACCOUNTING_DISCLAIMER,
  buildBorrowAccountingDossier,
  buildCryptoAccountingDossier,
  buildExpenseAccountingDossier,
} from "./accounting.js";
