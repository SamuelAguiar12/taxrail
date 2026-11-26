import type {
  DynamicPricingQuote,
  SupportedChain,
  SwapIntentPayload,
} from "@taxrail/shared";
import { parseUnits } from "viem";
import { type AaveSupportedChain, resolveEvmToken } from "./aave.js";

const NATIVE_EVM_ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const MAX_INTEGRATOR_FEE_BPS = 1000;
const MAX_INTEGRATOR_FEE_PPM = 100_000;
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
    WSTETH: {
      address: "0x7f39C581F595B53c5cb19bD0b3F8dA6c935E2Ca0",
      decimals: 18,
    },
    CBETH: {
      address: "0xBe9895146f7AF43049ca1c1AE358B0541Ea49704",
      decimals: 18,
    },
  },
  base: {
    USDT: {
      address: "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
      decimals: 6,
    },
    WSTETH: {
      address: "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452",
      decimals: 18,
    },
    CBETH: {
      address: "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22",
      decimals: 18,
    },
  },
  arbitrum: {
    USDT: {
      address: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      decimals: 6,
    },
    WSTETH: {
      address: "0x5979D7b546E38E414F7E9822514be443A4800529",
      decimals: 18,
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
  return "0x_v2";
}

function clampIntegratorFeeBps(rawFeeBps: number): number {
  if (!Number.isFinite(rawFeeBps)) return 0;
  return Math.min(MAX_INTEGRATOR_FEE_BPS, Math.max(0, Math.round(rawFeeBps)));
}

function clampIntegratorFeePpm(rawFeePpm: number | undefined, fallbackBps: number): number {
  if (rawFeePpm !== undefined && Number.isFinite(rawFeePpm)) {
    return Math.min(MAX_INTEGRATOR_FEE_PPM, Math.max(0, Math.round(rawFeePpm)));
  }
  return clampIntegratorFeeBps(fallbackBps) * 100;
}

function isValidEvmAddress(addr?: string): addr is string {
  return Boolean(addr && /^0x[a-fA-F0-9]{40}$/.test(addr.trim()));
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
  integratorFeePpm: number;
  treasuryWallet: string;
  affiliateWallet?: string;
  takerAddress?: string;
}): { template: Record<string, unknown>; multiRecipientSplit: boolean } {
  const {
    venue,
    chain,
    sellAssetResolved,
    buyAssetResolved,
    sellAmountBaseUnits,
    integratorFeeBps,
    integratorFeePpm,
    treasuryWallet,
    affiliateWallet,
    takerAddress,
  } = params;

  if (venue === "jupiter") {
    return {
      multiRecipientSplit: false,
      template: {
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
      },
    };
  }

  const evmChain = chain as AaveSupportedChain;
  const normalizedAffiliate = affiliateWallet?.trim();
  const canSplit =
    isValidEvmAddress(normalizedAffiliate) &&
    normalizedAffiliate.toLowerCase() !== treasuryWallet.toLowerCase() &&
    integratorFeeBps >= 2;

  let swapFeeRecipient = treasuryWallet;
  let swapFeeBpsParam: number | string = integratorFeeBps;
  let multiRecipientSplit = false;

  if (canSplit && normalizedAffiliate) {
    const affiliateShareBps = Math.max(1, Math.round(integratorFeeBps * AFFILIATE_SPLIT_RATIO));
    const treasuryShareBps = Math.max(1, integratorFeeBps - affiliateShareBps);
    swapFeeRecipient = `${treasuryWallet},${normalizedAffiliate}`;
    swapFeeBpsParam = `${treasuryShareBps},${affiliateShareBps}`;
    multiRecipientSplit = true;
  }

  return {
    multiRecipientSplit,
    template: {
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
        swapFeeBps: swapFeeBpsParam,
        swapFeePpm: canSplit ? undefined : integratorFeePpm,
        swapFeeRecipient,
        swapFeeToken: buyAssetResolved.identifier,
      },
    },
  };
}

/**
 * Builds a venue-specific swap intent payload for 0x v2 (EVM, up to 1000 bps / 10%)
 * or Jupiter (Solana) with an 80/20 treasury/affiliate split when an affiliate wallet is present.
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
  const integratorFeePpm = clampIntegratorFeePpm(
    params.pricing.embeddedSwapFeePpm,
    integratorFeeBps
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

  const { template: requestTemplate, multiRecipientSplit } = buildRequestTemplate({
    venue,
    chain: params.chain,
    sellAssetResolved,
    buyAssetResolved,
    sellAmountBaseUnits,
    integratorFeeBps,
    integratorFeePpm,
    treasuryWallet: params.treasuryWallet,
    affiliateWallet: params.pricing.affiliateWallet,
    takerAddress: params.takerAddress,
  });

  return {
    venue,
    chain: params.chain,
    sellAsset: params.sellAsset,
    buyAsset: params.buyAsset,
    sellAmountDecimal: params.sellAmountDecimal,
    integratorFeeBps,
    integratorFeePpm,
    multiRecipientSplit,
    feeRecipients,
    requestTemplate,
  };
}
