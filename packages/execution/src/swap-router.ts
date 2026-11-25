import type {
  DynamicPricingQuote,
  SupportedChain,
  SwapIntentPayload,
} from "@taxrail/shared";
import { parseUnits } from "viem";
import { type AaveSupportedChain, resolveEvmToken } from "./aave.js";

const NATIVE_EVM_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MAX_INTEGRATOR_FEE_BPS = 100;
const AFFILIATE_SPLIT_RATIO = 0.2;

const EVM_CHAIN_IDS: Record<AaveSupportedChain, number> = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
};

const EVM_EXTRA_TOKENS: Record<
  AaveSupportedChain,
  Record<string, { address: string; decimals: number }>
> = {
  ethereum: {
    USDT: {
      address: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      decimals: 6,
    },
  },
  base: {
    USDT: {
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6,
    },
  },
  arbitrum: {
    USDT: {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
    },
  },
};

const SOLANA_TOKEN_REGISTRY: Record<
  string,
  { mint: string; decimals: number }
> = {
  SOL: {
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  WSOL: {
    mint: "So11111111111111111111111111111111111111112",
    decimals: 9,
  },
  USDC: {
    mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    decimals: 6,
  },
  USDT: {
    mint: "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    decimals: 6,
  },
  CBBTC: {
    mint: "cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij",
    decimals: 8,
  },
};

interface ResolvedSwapAsset {
  identifier: string;
  decimals: number;
}

function resolveSwapAsset(
  chain: SupportedChain,
  asset: string
): ResolvedSwapAsset {
  const trimmed = asset.trim();
  const upper = trimmed.toUpperCase();

  if (chain === "solana") {
    const solToken = SOLANA_TOKEN_REGISTRY[upper];
    if (solToken) {
      return { identifier: solToken.mint, decimals: solToken.decimals };
    }
    return { identifier: trimmed, decimals: upper === "USDC" ? 6 : 9 };
  }

  if (upper === "ETH") {
    return { identifier: NATIVE_EVM_ETH_ADDRESS, decimals: 18 };
  }

  const extra = EVM_EXTRA_TOKENS[chain][upper];
  if (extra) {
    return { identifier: extra.address, decimals: extra.decimals };
  }

  const evmToken = resolveEvmToken(chain, trimmed);
  if (evmToken) {
    return { identifier: evmToken.address, decimals: evmToken.decimals };
  }

  return { identifier: trimmed, decimals: 18 };
}

function toBaseUnitsString(amountDecimal: string, decimals: number): string {
  const trimmed = amountDecimal.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid sellAmountDecimal: "${amountDecimal}"`);
  }
  return parseUnits(trimmed, decimals).toString();
}

function selectVenue(chain: SupportedChain): SwapIntentPayload["venue"] {
  if (chain === "solana") return "jupiter";
  if (chain === "ethereum") return "cow_swap";
  return "0x_v2";
}

function clampIntegratorFeeBps(rawFeeBps: number): number {
  if (!Number.isFinite(rawFeeBps)) return 0;
  return Math.min(MAX_INTEGRATOR_FEE_BPS, Math.max(0, Math.round(rawFeeBps)));
}

function buildFeeRecipients(
  integratorFeeBps: number,
  treasuryWallet: string,
  affiliateWallet?: string
): SwapIntentPayload["feeRecipients"] {
  const normalizedAffiliate = affiliateWallet?.trim();
  if (!normalizedAffiliate) {
    return [
      {
        recipient: treasuryWallet,
        shareBps: integratorFeeBps,
        role: "TAXRAIL_TREASURY",
      },
    ];
  }

  const affiliateShareBps = Math.round(integratorFeeBps * AFFILIATE_SPLIT_RATIO);
  const treasuryShareBps = integratorFeeBps - affiliateShareBps;

  return [
    {
      recipient: treasuryWallet,
      shareBps: treasuryShareBps,
      role: "TAXRAIL_TREASURY",
    },
    {
      recipient: normalizedAffiliate,
      shareBps: affiliateShareBps,
      role: "AFFILIATE_AGENT",
    },
  ];
}

function buildRequestTemplate(params: {
  venue: SwapIntentPayload["venue"];
  chain: SupportedChain;
  sellAssetResolved: ResolvedSwapAsset;
  buyAssetResolved: ResolvedSwapAsset;
  sellAmountBaseUnits: string;
  integratorFeeBps: number;
  treasuryWallet: string;
  takerAddress?: string;
}): Record<string, unknown> {
  const {
    venue,
    chain,
    sellAssetResolved,
    buyAssetResolved,
    sellAmountBaseUnits,
    integratorFeeBps,
    treasuryWallet,
    takerAddress,
  } = params;

  if (venue === "jupiter") {
    return {
      method: "GET",
      baseUrl: "https://api.jup.ag",
      endpoint: "/swap/v1/quote",
      queryParams: {
        inputMint: sellAssetResolved.identifier,
        outputMint: buyAssetResolved.identifier,
        amount: sellAmountBaseUnits,
        slippageBps: 50,
        platformFeeBps: integratorFeeBps,
        feeAccount: treasuryWallet,
        ...(takerAddress ? { userPublicKey: takerAddress } : {}),
      },
    };
  }

  if (venue === "cow_swap") {
    return {
      method: "POST",
      baseUrl: "https://api.cow.fi/mainnet",
      endpoint: "/api/v1/quote",
      body: {
        sellToken: sellAssetResolved.identifier,
        buyToken: buyAssetResolved.identifier,
        sellAmountBeforeFee: sellAmountBaseUnits,
        kind: "sell",
        from: takerAddress ?? "0x000000000000000000000000000000000000dEaD",
        appData: {
          version: "1.3.0",
          appCode: "TaxRail",
          metadata: {
            partnerFee: {
              bps: integratorFeeBps,
              recipient: treasuryWallet,
            },
          },
        },
      },
    };
  }

  const evmChain = chain as AaveSupportedChain;
  return {
    method: "GET",
    baseUrl: "https://api.0x.org",
    endpoint: "/swap/allowance-holder/quote",
    headers: {
      "0x-version": "v2",
    },
    queryParams: {
      chainId: EVM_CHAIN_IDS[evmChain],
      sellToken: sellAssetResolved.identifier,
      buyToken: buyAssetResolved.identifier,
      sellAmount: sellAmountBaseUnits,
      ...(takerAddress ? { taker: takerAddress } : {}),
      swapFeeBps: integratorFeeBps,
      swapFeeRecipient: treasuryWallet,
      swapFeeToken: buyAssetResolved.identifier,
    },
  };
}

/**
 * Builds a venue-specific, fee-capped swap intent payload for 0x v2, CoW Swap,
 * or Jupiter with an 80/20 treasury/affiliate split when an affiliate wallet is present.
 */
export function buildSwapIntent(params: {
  chain: SupportedChain;
  sellAsset: string;
  buyAsset: string;
  sellAmountDecimal: string;
  pricing: DynamicPricingQuote;
  treasuryWallet: string;
  takerAddress?: string;
}): SwapIntentPayload {
  const venue = selectVenue(params.chain);
  const integratorFeeBps = clampIntegratorFeeBps(
    params.pricing.embeddedSwapFeeBps
  );

  const sellAssetResolved = resolveSwapAsset(params.chain, params.sellAsset);
  const buyAssetResolved = resolveSwapAsset(params.chain, params.buyAsset);
  const sellAmountBaseUnits = toBaseUnitsString(
    params.sellAmountDecimal,
    sellAssetResolved.decimals
  );

  const feeRecipients = buildFeeRecipients(
    integratorFeeBps,
    params.treasuryWallet,
    params.pricing.affiliateWallet
  );

  const requestTemplate = buildRequestTemplate({
    venue,
    chain: params.chain,
    sellAssetResolved,
    buyAssetResolved,
    sellAmountBaseUnits,
    integratorFeeBps,
    treasuryWallet: params.treasuryWallet,
    takerAddress: params.takerAddress,
  });

  return {
    venue,
    chain: params.chain,
    sellAsset: params.sellAsset,
    buyAsset: params.buyAsset,
    sellAmountDecimal: params.sellAmountDecimal,
    integratorFeeBps,
    feeRecipients,
    requestTemplate,
  };
}
