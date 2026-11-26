import type { AaveActionPayload, AaveBatchCall } from "@taxrail/shared";
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

export const ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount)",
  "function transfer(address to, uint256 amount)",
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
 * Builds Aave v3 approve/supply, variable-rate borrow() (including optional 10% TaxRail fee
 * paid directly out of the borrowed USDC), and atomic batch call list for Base, Ethereum, or Arbitrum.
 */
export function buildAaveBorrowPayload(params: {
  chain: AaveSupportedChain;
  borrowerAddress?: string;
  collateralAsset: string;
  collateralAmount: number;
  borrowAmountUsd: number;
  feeAmountUsd?: number;
  treasuryWallet?: string;
  affiliateWallet?: string;
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
  const netLiquidityUsd = Number(borrowAmountUsd.toFixed(2));
  const rawFeeUsd =
    params.feeAmountUsd !== undefined && Number.isFinite(params.feeAmountUsd)
      ? Math.max(0, Number(params.feeAmountUsd.toFixed(2)))
      : 0;

  const hasValidTreasury = Boolean(params.treasuryWallet && isAddress(params.treasuryWallet.trim()));
  const feePaidFromBorrowUsd = hasValidTreasury ? rawFeeUsd : 0;
  const totalBorrowAmountUsd = Number((netLiquidityUsd + feePaidFromBorrowUsd).toFixed(2));

  const borrowUnits = parseUnits(
    toFixedDecimalString(totalBorrowAmountUsd, borrowToken.decimals),
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

  const borrowTransaction: AaveBatchCall = {
    to: poolAddress,
    data: borrowData,
    value: "0",
    description:
      feePaidFromBorrowUsd > 0
        ? `Borrow ${totalBorrowAmountUsd.toFixed(2)} USDC (${netLiquidityUsd.toFixed(2)} net + ${feePaidFromBorrowUsd.toFixed(2)} TaxRail fee) at variable rate from Aave v3 on ${chain}`
        : `Borrow ${netLiquidityUsd.toFixed(2)} USDC at variable rate from Aave v3 on ${chain} for ${onBehalfOf}`,
  };

  const atomicBatchCalls: AaveBatchCall[] = [];
  let approveCollateralTransaction: AaveBatchCall | undefined;
  let supplyTransaction: AaveBatchCall | undefined;

  if (collateralAmount > 0) {
    const supplyUnits = parseUnits(
      toFixedDecimalString(collateralAmount, collateralToken.decimals),
      collateralToken.decimals
    );

    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [poolAddress, supplyUnits],
    });

    approveCollateralTransaction = {
      to: collateralToken.address,
      data: approveData,
      value: "0",
      description: `Approve ${collateralAmount} ${collateralToken.symbol} for Aave v3 Pool on ${chain}`,
    };

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

    supplyTransaction = {
      to: poolAddress,
      data: supplyData,
      value: "0",
      description: `Supply ${collateralAmount} ${collateralToken.symbol} collateral to Aave v3 on ${chain} on behalf of ${onBehalfOf}`,
    };

    atomicBatchCalls.push(approveCollateralTransaction, supplyTransaction);
  }

  atomicBatchCalls.push(borrowTransaction);

  const payload: AaveActionPayload = {
    protocol: "aave_v3",
    chain,
    poolAddress,
    netLiquidityUsd,
    feePaidFromBorrowUsd,
    totalBorrowAmountUsd,
    ...(approveCollateralTransaction ? { approveCollateralTransaction } : {}),
    ...(supplyTransaction ? { supplyTransaction } : {}),
    borrowTransaction,
    atomicBatchCalls,
  };

  if (feePaidFromBorrowUsd > 0 && params.treasuryWallet && isAddress(params.treasuryWallet.trim())) {
    const treasury = getAddress(params.treasuryWallet.trim());
    const totalFeeUnits = parseUnits(
      toFixedDecimalString(feePaidFromBorrowUsd, borrowToken.decimals),
      borrowToken.decimals
    );

    const trimmedAff = params.affiliateWallet?.trim();
    const hasValidAffiliate = Boolean(
      trimmedAff &&
        isAddress(trimmedAff) &&
        getAddress(trimmedAff).toLowerCase() !== treasury.toLowerCase()
    );

    if (hasValidAffiliate && trimmedAff) {
      const affiliate = getAddress(trimmedAff);
      const affiliateUnits = (totalFeeUnits * 20n) / 100n;
      const treasuryUnits = totalFeeUnits - affiliateUnits;
      const affiliateUsd = Number(((feePaidFromBorrowUsd * 20) / 100).toFixed(2));
      const treasuryUsd = Number((feePaidFromBorrowUsd - affiliateUsd).toFixed(2));

      if (treasuryUnits > 0n) {
        const feeTransferTx = {
          to: borrowToken.address,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [treasury, treasuryUnits],
          }),
          value: "0" as const,
          amountUsd: treasuryUsd,
          recipient: treasury,
          description: `Transfer ${treasuryUsd.toFixed(2)} USDC TaxRail fee (80% treasury) from borrowed liquidity`,
        };
        payload.feeTransferTransaction = feeTransferTx;
        atomicBatchCalls.push({
          to: feeTransferTx.to,
          data: feeTransferTx.data,
          value: "0",
          description: feeTransferTx.description,
        });
      }

      if (affiliateUnits > 0n) {
        const affTransferTx = {
          to: borrowToken.address,
          data: encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "transfer",
            args: [affiliate, affiliateUnits],
          }),
          value: "0" as const,
          amountUsd: affiliateUsd,
          recipient: affiliate,
          description: `Transfer ${affiliateUsd.toFixed(2)} USDC affiliate share (20%) from borrowed liquidity`,
        };
        payload.affiliateFeeTransferTransaction = affTransferTx;
        atomicBatchCalls.push({
          to: affTransferTx.to,
          data: affTransferTx.data,
          value: "0",
          description: affTransferTx.description,
        });
      }
    } else if (totalFeeUnits > 0n) {
      const feeTransferTx = {
        to: borrowToken.address,
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "transfer",
          args: [treasury, totalFeeUnits],
        }),
        value: "0" as const,
        amountUsd: feePaidFromBorrowUsd,
        recipient: treasury,
        description: `Transfer ${feePaidFromBorrowUsd.toFixed(2)} USDC TaxRail fee (10% of verified tax savings) from borrowed liquidity`,
      };
      payload.feeTransferTransaction = feeTransferTx;
      atomicBatchCalls.push({
        to: feeTransferTx.to,
        data: feeTransferTx.data,
        value: "0",
        description: feeTransferTx.description,
      });
    }
  }

  return payload;
}
