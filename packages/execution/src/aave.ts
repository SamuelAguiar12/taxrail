import type { AaveActionPayload } from "@taxrail/shared";
import { encodeFunctionData, getAddress, isAddress, parseAbi, parseUnits } from "viem";

export type AaveSupportedChain = "base" | "ethereum" | "arbitrum";

export interface TokenMetadata {
  symbol: string;
  address: `0x${string}`;
  decimals: number;
}

export const FALLBACK_BORROWER_ADDRESS: `0x${string}` =
  "0x000000000000000000000000000000000000dEaD";

export const AAVE_V3_POOL_ADDRESSES: Record<AaveSupportedChain, `0x${string}`> = {
  base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
  ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
};

export const EVM_TOKEN_REGISTRY: Record<
  AaveSupportedChain,
  Record<"USDC" | "WETH" | "WBTC" | "cbBTC", TokenMetadata>
> = {
  base: {
    USDC: {
      symbol: "USDC",
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      decimals: 6,
    },
    WETH: {
      symbol: "WETH",
      address: "0x4200000000000000000000000000000000000006",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x0555E30da8f98308EdB960aa94C0Db47230d2B9c",
      decimals: 8,
    },
    cbBTC: {
      symbol: "cbBTC",
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      decimals: 8,
    },
  },
  ethereum: {
    USDC: {
      symbol: "USDC",
      address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      decimals: 6,
    },
    WETH: {
      symbol: "WETH",
      address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      decimals: 8,
    },
    cbBTC: {
      symbol: "cbBTC",
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      decimals: 8,
    },
  },
  arbitrum: {
    USDC: {
      symbol: "USDC",
      address: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
      decimals: 6,
    },
    WETH: {
      symbol: "WETH",
      address: "0x82aF49447d8a07e3bd95BD0d56f35241523fBab1",
      decimals: 18,
    },
    WBTC: {
      symbol: "WBTC",
      address: "0x2f2a2543B76A4166549F7aAb2E75BeF0aEFC5B0f",
      decimals: 8,
    },
    cbBTC: {
      symbol: "cbBTC",
      address: "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf",
      decimals: 8,
    },
  },
};

export const AAVE_V3_POOL_ABI = parseAbi([
  "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode)",
  "function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf)",
]);

const VARIABLE_INTEREST_RATE_MODE = 2n;
const DEFAULT_REFERRAL_CODE = 0;

/** Resolves a token symbol (or direct EVM address) on a supported Aave v3 chain. */
export function resolveEvmToken(
  chain: AaveSupportedChain,
  asset: string
): TokenMetadata | null {
  const trimmed = asset.trim();
  if (!trimmed) return null;

  const upper = trimmed.toUpperCase();
  const chainRegistry = EVM_TOKEN_REGISTRY[chain];

  if (upper === "ETH" || upper === "WETH") {
    return chainRegistry.WETH;
  }
  if (upper === "USDC") {
    return chainRegistry.USDC;
  }
  if (upper === "WBTC") {
    return chainRegistry.WBTC;
  }
  if (upper === "CBBTC") {
    return chainRegistry.cbBTC;
  }

  if (isAddress(trimmed)) {
    const checksummed = getAddress(trimmed);
    const knownMatch = Object.values(chainRegistry).find(
      (token) => token.address.toLowerCase() === checksummed.toLowerCase()
    );
    if (knownMatch) return knownMatch;

    return {
      symbol: checksummed,
      address: checksummed,
      decimals: 18,
    };
  }

  return null;
}

function resolveBorrowerAddress(borrowerAddress?: string): `0x${string}` {
  if (!borrowerAddress) return FALLBACK_BORROWER_ADDRESS;
  const trimmed = borrowerAddress.trim();
  if (!isAddress(trimmed)) return FALLBACK_BORROWER_ADDRESS;
  return getAddress(trimmed);
}

function toFixedDecimalString(value: number, decimals: number): string {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid token amount: ${value}`);
  }
  return value.toFixed(decimals);
}

/**
 * Builds Aave v3 supply() and variable-rate borrow() calldata payloads for
 * Base, Ethereum, or Arbitrum without requiring Node-specific APIs.
 */
export function buildAaveBorrowPayload(params: {
  chain: AaveSupportedChain;
  borrowerAddress?: string;
  collateralAsset: string;
  collateralAmount: number;
  borrowAmountUsd: number;
}): AaveActionPayload {
  const { chain, collateralAsset, collateralAmount, borrowAmountUsd } = params;

  const poolAddress = AAVE_V3_POOL_ADDRESSES[chain];
  if (!poolAddress) {
    throw new Error(`Unsupported Aave v3 chain: ${String(chain)}`);
  }

  if (!Number.isFinite(collateralAmount) || collateralAmount < 0) {
    throw new Error(`Invalid collateralAmount: ${collateralAmount}`);
  }
  if (!Number.isFinite(borrowAmountUsd) || borrowAmountUsd <= 0) {
    throw new Error(`Invalid borrowAmountUsd: ${borrowAmountUsd}`);
  }

  const collateralToken = resolveEvmToken(chain, collateralAsset);
  if (!collateralToken) {
    throw new Error(
      `Unsupported collateral asset "${collateralAsset}" on Aave v3 (${chain})`
    );
  }

  const borrowToken = EVM_TOKEN_REGISTRY[chain].USDC;
  const onBehalfOf = resolveBorrowerAddress(params.borrowerAddress);

  const borrowUnits = parseUnits(
    toFixedDecimalString(borrowAmountUsd, borrowToken.decimals),
    borrowToken.decimals
  );

  const borrowData = encodeFunctionData({
    abi: AAVE_V3_POOL_ABI,
    functionName: "borrow",
    args: [
      borrowToken.address,
      borrowUnits,
      VARIABLE_INTEREST_RATE_MODE,
      DEFAULT_REFERRAL_CODE,
      onBehalfOf,
    ],
  });

  const payload: AaveActionPayload = {
    protocol: "aave_v3",
    chain,
    poolAddress,
    borrowTransaction: {
      to: poolAddress,
      data: borrowData,
      value: "0",
      description: `Borrow ${borrowAmountUsd.toFixed(2)} USDC at variable rate from Aave v3 on ${chain} for ${onBehalfOf}`,
    },
  };

  if (collateralAmount > 0) {
    const supplyUnits = parseUnits(
      toFixedDecimalString(collateralAmount, collateralToken.decimals),
      collateralToken.decimals
    );

    const supplyData = encodeFunctionData({
      abi: AAVE_V3_POOL_ABI,
      functionName: "supply",
      args: [
        collateralToken.address,
        supplyUnits,
        onBehalfOf,
        DEFAULT_REFERRAL_CODE,
      ],
    });

    payload.supplyTransaction = {
      to: poolAddress,
      data: supplyData,
      value: "0",
      description: `Supply ${collateralAmount} ${collateralToken.symbol} collateral to Aave v3 on ${chain} on behalf of ${onBehalfOf}`,
    };
  }

  return payload;
}
